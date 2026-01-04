const express = require('express');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
require('dotenv').config();

const {
    createJob,
    getJob,
    updateJob,
    cleanupOldJobs
} = require('./jobs');

const multer = require('multer');
const upload = multer({ dest: os.tmpdir() });

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
const COMPOSITION_ID = 'MainVideo';
const SERVE_URL = `http://localhost:${PORT}`;

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Frontend
app.use('/app', express.static(path.join(__dirname, 'client')));
app.use(express.static(path.join(__dirname, 'build')));

// Audios locales
const VOICES_DIR = path.join(__dirname, 'voices');
app.use('/voices', express.static(VOICES_DIR));

function parseAudioFileName(fileName) {
    const regex = /narration_\d+_(\d+)\.mp3$/;
    const match = fileName.match(regex);
    if (!match) return null;
    return { duration: parseInt(match[1]) };
}

// Render en segundo plano
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

// Crear job de render
app.post('/api/render-video', async (req, res) => {
    try {
        await cleanupOldJobs(); // Limpieza rápida
        const job = await createJob(req.body);

        // Render en 2do plano
        processJob(job).catch(err => console.error('❌ processJob error:', err));

        res.json({ jobId: job.id, status: job.status });

    } catch (err) {
        console.error('❌ Error al crear job:', err);
        res.status(500).json({ error: err.message });
    }
});

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

app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
