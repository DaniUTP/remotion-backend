const express = require('express');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

console.log("Cargando datos del .env:");
console.log("CLOUDINARY_CLOUD_NAME: ", process.env.CLOUDINARY_CLOUD_NAME);
console.log("CLOUDINARY_API_KEY: ", process.env.CLOUDINARY_API_KEY);
console.log("CLOUDINARY_API_SECRET: ", process.env.CLOUDINARY_API_SECRET);

const { createJob, getJob, updateJob, cleanupOldJobs } = require('./jobs');

const multer = require('multer');
const upload = multer({ dest: os.tmpdir() });

const app = express();
app.use(express.json());

/* -------------------------
   CONFIG
-------------------------- */
const PORT = process.env.PORT || 8000;
const COMPOSITION_ID = 'MainVideo';
const SERVE_URL = `http://localhost:${PORT}`;

/* -------------------------
   CLOUDINARY
-------------------------- */
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* -------------------------
   FRONTEND
-------------------------- */
app.use('/app', express.static(path.join(__dirname, 'client')));
app.use(express.static(path.join(__dirname, 'build')));

/* -------------------------
   AUDIOS LOCALES
-------------------------- */
const VOICES_DIR = path.join(__dirname, 'voices');
app.use('/voices', express.static(VOICES_DIR));

function parseAudioFileName(fileName) {
    const regex = /narration_\d+_(\d+)\.mp3$/;
    const match = fileName.match(regex);
    if (!match) return null;
    return { duration: parseInt(match[1]) };
}

const EXPLANATION_AUDIOS = {
    a: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_a_r14zgs.mp3',
    b: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_b_d7zvt5.mp3',
    c: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_c_ynwh6k.mp3',
    d: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_d_syoc9q.mp3'
};

/* -------------------------
   API: GENERAR AUDIOS
-------------------------- */
app.post('/api/generate-audios', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be an array' });
        }

        const results = [];

        for (const row of items) {
            const id_question = row["0"];
            const question = row["1"];
            const options = [row["2"], row["3"], row["4"], row["5"]];
            const correctLetterRaw = row["7"];
            const imagePathRaw = row["8"];

            if (!correctLetterRaw) throw new Error(`Respuesta correcta faltante en pregunta ${id_question}`);

            const correctLetter = String(correctLetterRaw).toLowerCase();
            const correctIndexMap = { a: 0, b: 1, c: 2, d: 3 };
            const correctIndex = correctIndexMap[correctLetter];
            if (correctIndex === undefined) throw new Error(`Respuesta correcta inválida (${correctLetter}) en pregunta ${id_question}`);

            let image = "";
            if (imagePathRaw && imagePathRaw !== "NULL" && imagePathRaw !== "null") {
                image = `https://media.autocheckapp.pe/1M4G3QU1Z/${imagePathRaw}`;
            }

            // Archivo de audio local
            const audioFiles = fs.readdirSync(VOICES_DIR);
            const audioFileName = audioFiles.find(f => f.includes(`_${id_question}_`) && f.endsWith('.mp3'));
            if (!audioFileName) throw new Error(`Audio no encontrado para pregunta ${id_question}`);

            const parsed = parseAudioFileName(audioFileName);
            if (!parsed) throw new Error(`Nombre de archivo inválido: ${audioFileName}`);

            const countdownSeconds = parsed.duration + 5;
            const narrationUrl = `${SERVE_URL}/voices/${audioFileName}`;

            results.push({
                question,
                image,
                options,
                correctIndex,
                countdownSeconds,
                revealSeconds: 2,
                narrationUrl,
                explanationAudioUrl: EXPLANATION_AUDIOS[correctLetter]
            });
        }

        res.json(results);

    } catch (err) {
        console.error('❌ Error generación audio local:', err.message);
        res.status(500).json({ error: 'Audio generation failed', detail: err.message });
    }
});

/* -------------------------
   UPLOAD FILE
-------------------------- */
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const result = await cloudinary.uploader.upload(req.file.path, { resource_type: 'auto' });
        fs.unlinkSync(req.file.path);
        res.json({ url: result.secure_url, publicId: result.public_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* -------------------------
   RENDER VIDEO
-------------------------- */
async function processJob(job) {
    try {
        await updateJob(job.id, { status: 'rendering' });

        const composition = await selectComposition({
            serveUrl: SERVE_URL,
            id: COMPOSITION_ID,
            inputProps: job.inputProps
        });

        const outputLocation = path.join(os.tmpdir(), `video-${job.id}.mp4`);

        await renderMedia({
            composition,
            serveUrl: SERVE_URL,
            codec: 'h264',
            outputLocation,
            inputProps: job.inputProps,
            concurrency: 4
        });

        await updateJob(job.id, { status: 'uploading' });

        const uploadResult = await cloudinary.uploader.upload(outputLocation, {
            resource_type: 'video',
            public_id: `job-${job.id}`
        });

        fs.unlinkSync(outputLocation);
        await updateJob(job.id, { status: 'done', videoUrl: uploadResult.secure_url });

    } catch (err) {
        console.error('❌ Error renderizando job:', err);
        await updateJob(job.id, { status: 'error', error: err.message });
    }
}

/* -------------------------
   API: RENDER VIDEO (CREAR JOB)
-------------------------- */
app.post('/api/render-video', async (req, res) => {
    try {
        // Limpiar jobs antiguos antes de crear uno nuevo
        await cleanupOldJobs();

        // Crear job de video
        const job = await createJob(req.body);

        // Render en segundo plano
        processJob(job).catch(err => console.error('❌ processJob error:', err));

        // Responder inmediatamente con jobId
        res.json({ jobId: job.id, status: job.status });

    } catch (err) {
        console.error('❌ Error al crear job:', err);
        res.status(500).json({ error: err.message });
    }
});

/* -------------------------
   API: CHECK STATUS
-------------------------- */
app.get('/api/render-status/:jobId', async (req, res) => {
    try {
        const job = await getJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        res.json({
            jobId: job.id,
            status: job.status,
            videoUrl: job.videoUrl || null,
            error: job.error || null
        });

    } catch (err) {
        console.error('❌ Error al obtener job:', err);
        res.status(500).json({ error: err.message });
    }
});

/* -------------------------
   START SERVER
-------------------------- */
app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
