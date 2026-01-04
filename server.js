const express = require('express');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
console.log("Cargando datos del .env:");
console.log("CLOUDINARY_CLOUD_NAME: ", process.env.CLOUDINARY_CLOUD_NAME);
console.log("CLOUDINARY_API_KEY: ", process.env.CLOUDINARY_API_KEY);
console.log("CLOUDINARY_API_SECRET: ", process.env.CLOUDINARY_API_SECRET);
console.log("ELEVENLABS_API_KEY: ", process.env.ELEVENLABS_API_KEY);
const {
    createJob,
    getJob,
    updateJob,
    jobs,
    cleanupOldJobs,
    getJobsStats
} = require('./jobs');

const multer = require('multer');
const upload = multer({ dest: os.tmpdir() });

const app = express();
app.use(express.json());

/* -------------------------
   CORS (MAKE FRIENDLY)
-------------------------- */
app.use(cors({
    origin: function (origin, callback) {
        // Make / Postman / curl -> sin origin
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://localhost:8000',
            'http://localhost:3000'
        ];

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

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
const ELEVEN_VOICE_ID = 'pqHfZKP75CvOlQylNhV4';

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
   ELEVENLABS HELPERS
-------------------------- */
async function elevenLabsTTS(text) {
    const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
        {
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.4,
                similarity_boost: 0.8
            }
        },
        {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            responseType: 'arraybuffer'
        }
    );

    return response.data;
}

function uploadAudioToCloudinary(buffer, publicId) {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            {
                resource_type: 'video',
                folder: '',
                public_id: publicId,
                format: 'mp3'
            },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        ).end(buffer);
    });
}

/* -------------------------
   API: GENERAR AUDIOS (MAKE)
-------------------------- */
const EXPLANATION_AUDIOS = {
    a: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_a_r14zgs.mp3',
    b: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_b_d7zvt5.mp3',
    c: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_c_ynwh6k.mp3',
    d: 'https://res.cloudinary.com/dly4rnmgh/video/upload/v1767543794/la_d_syoc9q.mp3'
};

app.post('/api/generate-audios', async (req, res) => {
    try {
        const { items } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be an array' });
        }

        const results = [];

        for (const row of items) {

            // 🟢 Make manda objetos con keys "0","1","2",...
            const id_question = row["0"];
            const question = row["1"];

            const options = [
                row["2"],
                row["3"],
                row["4"],
                row["5"]
            ];

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

            // 🖼️ Imagen: solo si hay path válido
            let image = "";
            if (imagePathRaw && imagePathRaw !== "NULL" && imagePathRaw !== "null") {
                image = `https://media.autocheckapp.pe/1M4G3QU1Z/${imagePathRaw}`;
            }

            // 🎙️ Texto de narración
            const narrationText = `
${question}

A) ${options[0]}
B) ${options[1]}
C) ${options[2]}
D) ${options[3]}
            `.trim();

            console.log(`🎙 Generando audio pregunta ${id_question}`);

            // 🔊 Generar audio
            const audioBuffer = await elevenLabsTTS(narrationText);

            // ☁️ Subir a Cloudinary
            const uploadResult = await uploadAudioToCloudinary(
                audioBuffer,
                `question_${id_question}_${Date.now()}`
            );

            // ⏱️ Duración estimada
            const wordCount = narrationText.split(/\s+/).length;
            const narrationSeconds = Math.ceil((wordCount / 150) * 60);

            // ✅ Audio de explicación correcto
            const explanationAudioUrl = EXPLANATION_AUDIOS[correctLetter];

            results.push({
                question,
                image, // 👈 siempre presente, pero vacío si no hay
                options,
                correctIndex,
                countdownSeconds: narrationSeconds + 5,
                revealSeconds: 2,
                narrationUrl: uploadResult.secure_url,
                explanationAudioUrl
            });
        }

        res.json(results);

    } catch (err) {
        console.error('❌ Error TTS:', err.message);
        res.status(500).json({
            error: 'Audio generation failed',
            detail: err.message
        });
    }
});




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
app.get('/api/jobs', (req, res) => {
    cleanupOldJobs();
    res.json(Array.from(jobs.values()));
});

app.get('/api/jobs-stats', (req, res) => {
    res.json(getJobsStats());
});

/* -------------------------
   RENDER VIDEO
-------------------------- */
async function processJob(job) {
    const { id, inputProps } = job;

    try {
        updateJob(id, { status: 'rendering' });

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

        updateJob(id, { status: 'uploading' });

        const uploadResult = await cloudinary.uploader.upload(outputLocation, {
            resource_type: 'video',
            public_id: `job-${id}`
        });

        fs.unlinkSync(outputLocation);

        updateJob(id, {
            status: 'done',
            videoUrl: uploadResult.secure_url
        });

    } catch (err) {
        updateJob(id, {
            status: 'error',
            error: err.message
        });
    }
}

app.post('/api/render-video', (req, res) => {
    cleanupOldJobs();
    const job = createJob(req.body);
    processJob(job);
    res.json({ jobId: job.id, status: job.status });
});

app.get('/api/render-status/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

/* -------------------------
   START
-------------------------- */
app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
