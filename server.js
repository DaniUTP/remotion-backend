// server.js - Backend completo actualizado

const express = require('express');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

console.log("Cargando datos del .env:");
console.log("CLOUDINARY_CLOUD_NAME: ", process.env.CLOUDINARY_CLOUD_NAME);
console.log("CLOUDINARY_API_KEY: ", process.env.CLOUDINARY_API_KEY);
console.log("CLOUDINARY_API_SECRET: ", process.env.CLOUDINARY_API_SECRET);

const { createJob, getJob, updateJob, cleanupOldJobs, getJobsStats } = require('./jobs');

const upload = multer({ dest: os.tmpdir() });
const app = express();
app.use(express.json());

/* -------------------------
   CORS (MAKE FRIENDLY)
-------------------------- */
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://localhost:8000',
            'http://localhost:3000'
        ];
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

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
   API: GENERAR AUDIOS DESDE CARPETA LOCAL
-------------------------- */
const VOICES_DIR = path.join(__dirname, 'voices');

// Parsea duración y narrador desde el nombre del archivo
// Ejemplo: narration_1_15Juan.mp3 -> duration=15, narrator=Juan
function parseAudioFileName(fileName) {
    const regex = /_(\d+)([a-zA-Z]+)\.mp3$/;
    const match = fileName.match(regex);
    if (!match) return null;
    const duration = parseInt(match[1]);
    const narrator = match[2];
    return { duration, narrator };
}

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

            if (!correctLetterRaw) {
                throw new Error(`Respuesta correcta faltante en pregunta ${id_question}`);
            }

            const correctLetter = String(correctLetterRaw).toLowerCase();
            const correctIndexMap = { a: 0, b: 1, c: 2, d: 3 };
            const correctIndex = correctIndexMap[correctLetter];
            if (correctIndex === undefined) {
                throw new Error(`Respuesta correcta inválida (${correctLetter}) en pregunta ${id_question}`);
            }

            // Imagen
            let image = "";
            if (imagePathRaw && imagePathRaw !== "NULL" && imagePathRaw !== "null") {
                image = `https://media.autocheckapp.pe/1M4G3QU1Z/${imagePathRaw}`;
            }

            // Buscar archivo de audio local
            const audioFiles = fs.readdirSync(VOICES_DIR);
            const audioFileName = audioFiles.find(f => f.includes(`_${id_question}_`));
            if (!audioFileName) {
                throw new Error(`Audio no encontrado para pregunta ${id_question}`);
            }

            const parsed = parseAudioFileName(audioFileName);
            if (!parsed) {
                throw new Error(`Nombre de archivo inválido: ${audioFileName}`);
            }

            const countdownSeconds = parsed.duration + 5;
            const narrationUrl = `/voices/${audioFileName}`;

            // Audio de explicación
            const EXPLANATION_AUDIOS = {
                a: '/voices/explanation_a.mp3',
                b: '/voices/explanation_b.mp3',
                c: '/voices/explanation_c.mp3',
                d: '/voices/explanation_d.mp3'
            };
            const explanationAudioUrl = EXPLANATION_AUDIOS[correctLetter];

            results.push({
                question,
                image,
                options,
                correctIndex,
                countdownSeconds,
                revealSeconds: 2,
                narrationUrl,
                explanationAudioUrl
            });
        }

        res.json(results);

    } catch (err) {
        console.error('❌ Error TTS local:', err.message);
        res.status(500).json({
            error: 'Audio generation failed',
            detail: err.message
        });
    }
});

// Servir audios locales
app.use('/voices', express.static(path.join(__dirname, 'voices')));

/* -------------------------
   UPLOAD FILE
-------------------------- */
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: 'auto'
        });
        fs.unlinkSync(req.file.path);
        res.json({
            url: result.secure_url,
            publicId: result.public_id
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* -------------------------
   JOBS
-------------------------- */
app.get('/api/jobs', async (req, res) => {
    await cleanupOldJobs();
    const allJobs = await getJobsStats();
    res.json(allJobs);
});

app.get('/api/jobs-stats', async (req, res) => {
    const stats = await getJobsStats();
    res.json(stats);
});

/* -------------------------
   RENDER VIDEO
-------------------------- */
async function processJob(job) {
    const { id, inputProps } = job;

    try {
        await updateJob(id, { status: 'rendering' });

        const composition = await selectComposition({
            serveUrl: SERVE_URL,
            id: COMPOSITION_ID,
            inputProps
        });

        const outputLocation = path.join(os.tmpdir(), `video-${id}.mp4`);

        await renderMedia({
            composition,
            serveUrl: SERVE_URL,
            codec: 'h264',
            outputLocation,
            inputProps,
            concurrency: 4
        });

        await updateJob(id, { status: 'uploading' });

        const uploadResult = await cloudinary.uploader.upload(outputLocation, {
            resource_type: 'video',
            public_id: `job-${id}`
        });

        fs.unlinkSync(outputLocation);

        await updateJob(id, {
            status: 'done',
            videoUrl: uploadResult.secure_url
        });

    } catch (err) {
        await updateJob(id, {
            status: 'error',
            error: err.message
        });
    }
}

app.post('/api/render-video', async (req, res) => {
    await cleanupOldJobs();
    const job = await createJob(req.body);
    processJob(job); // async fire-and-forget
    res.json({ jobId: job.id, status: job.status });
});

app.get('/api/render-status/:jobId', async (req, res) => {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

/* -------------------------
   START SERVER
-------------------------- */
app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
