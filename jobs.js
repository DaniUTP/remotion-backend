// jobs.js - Sistema de gestión de jobs con Redis
const redis = require('redis');
const { setTimeout, setInterval } = require('timers');

const REDIS_URL = 'redis://default:PfqouJPJQPmfJK7KhrqISWdFwXVJPkhP@redis-16659.c57.us-east-1-4.ec2.cloud.redislabs.com:16659';
const MAX_JOBS_STORED = 50;
const MAX_JOB_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MINUTES = 60;

let redisClient;
const JOB_PREFIX = 'job:';
const JOB_IDS_SET = 'job_ids';
const JOB_QUEUE_ZSET = 'job_queue';

async function initializeRedis() {
    try {
        redisClient = redis.createClient({ url: REDIS_URL });

        redisClient.on('error', (err) => console.error('❌ Redis error:', err));
        redisClient.on('connect', () => console.log('🔗 Conectando a Redis...'));
        redisClient.on('ready', () => console.log('✅ Redis listo'));

        await redisClient.connect();
        return true;
    } catch (err) {
        console.error('❌ No se pudo conectar a Redis:', err);
        return false;
    }
}

function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function createJob(data) {
    if (!redisClient) throw new Error('Redis no inicializado');

    const id = generateJobId();
    const now = Date.now();

    const job = {
        id,
        status: 'queued',
        videoUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        inputProps: data,
    };

    const jobKey = JOB_PREFIX + id;

    await redisClient.hSet(jobKey, {
        id,
        status: job.status,
        videoUrl: '',
        error: '',
        createdAt: now.toString(),
        updatedAt: now.toString(),
        inputProps: JSON.stringify(job.inputProps)
    });

    await redisClient.expire(jobKey, MAX_JOB_AGE_HOURS * 3600);
    await redisClient.sAdd(JOB_IDS_SET, id);
    await redisClient.zAdd(JOB_QUEUE_ZSET, [{ score: now, value: id }]);

    console.log(`📝 Job creado: ${id}`);

    // Crear job de limpieza diario si no existe
    scheduleDailyCleanup();

    // Limpiar si hay exceso
    const totalJobs = await redisClient.sCard(JOB_IDS_SET);
    if (totalJobs > MAX_JOBS_STORED * 1.5) {
        setTimeout(() => cleanupOldJobs(), 1000);
    }

    return job;
}

async function getJob(id) {
    if (!redisClient) return null;
    const jobKey = JOB_PREFIX + id;
    const jobData = await redisClient.hGetAll(jobKey);
    if (!jobData || !jobData.id) return null;
    return {
        ...jobData,
        createdAt: parseInt(jobData.createdAt),
        updatedAt: parseInt(jobData.updatedAt),
        inputProps: JSON.parse(jobData.inputProps || '{}')
    };
}

async function updateJob(id, patch) {
    if (!redisClient) return false;

    const jobKey = JOB_PREFIX + id;
    const exists = await redisClient.exists(jobKey);
    if (!exists) return false;

    const updates = { updatedAt: Date.now().toString() };
    if (patch.status) updates.status = patch.status;
    if (patch.videoUrl !== undefined) updates.videoUrl = patch.videoUrl || '';
    if (patch.error !== undefined) updates.error = patch.error || '';
    if (patch.inputProps) updates.inputProps = JSON.stringify(patch.inputProps);

    await redisClient.hSet(jobKey, updates);
    await redisClient.expire(jobKey, MAX_JOB_AGE_HOURS * 3600);

    return true;
}

async function cleanupOldJobs() {
    if (!redisClient) return 0;

    const now = Date.now();
    const cutoffTime = now - MAX_JOB_AGE_HOURS * 3600 * 1000;
    const oldJobs = await redisClient.zRangeByScore(JOB_QUEUE_ZSET, 0, cutoffTime);

    for (const jobId of oldJobs) {
        const jobKey = JOB_PREFIX + jobId;
        await redisClient.del(jobKey);
        await redisClient.sRem(JOB_IDS_SET, jobId);
        await redisClient.zRem(JOB_QUEUE_ZSET, jobId);
        console.log(`🗑️ Eliminado job viejo: ${jobId}`);
    }

    const totalJobs = await redisClient.sCard(JOB_IDS_SET);
    if (totalJobs > MAX_JOBS_STORED) {
        const jobsToRemove = totalJobs - MAX_JOBS_STORED;
        const oldestJobs = await redisClient.zRange(JOB_QUEUE_ZSET, 0, jobsToRemove - 1);
        for (const jobId of oldestJobs) {
            const jobKey = JOB_PREFIX + jobId;
            await redisClient.del(jobKey);
            await redisClient.sRem(JOB_IDS_SET, jobId);
            await redisClient.zRem(JOB_QUEUE_ZSET, jobId);
            console.log(`🗑️ Eliminado por límite: ${jobId}`);
        }
    }

    return oldJobs.length;
}

// Programa limpieza diaria a las 23:59 hora Perú (UTC-5)
let dailyCleanupScheduled = false;
function scheduleDailyCleanup() {
    if (dailyCleanupScheduled) return;
    dailyCleanupScheduled = true;

    const now = new Date();
    const utcOffset = -5; // Perú UTC-5
    const nowUtc = new Date(now.getTime() + now.getTimezoneOffset() * 60000);
    const nowPeru = new Date(nowUtc.getTime() + utcOffset * 3600 * 1000);

    // Hora objetivo 23:59 Perú
    const target = new Date(nowPeru);
    target.setHours(23, 59, 0, 0);
    if (target < nowPeru) target.setDate(target.getDate() + 1);

    const delay = target - nowPeru;

    setTimeout(async () => {
        console.log('🧹 Ejecutando limpieza diaria programada (hora Perú)');
        await cleanupOldJobs();
        // Reprogramar para el siguiente día
        dailyCleanupScheduled = false;
        scheduleDailyCleanup();
    }, delay);
}

// Inicializar Redis y limpieza automática periódica
let isInitialized = false;
async function init() {
    if (isInitialized) return true;
    isInitialized = await initializeRedis();
    isInitialized = true;
    return isInitialized;
}

init().catch(console.error);

module.exports = {
    createJob,
    getJob,
    updateJob,
    cleanupOldJobs,
    init,
    MAX_JOBS_STORED,
    MAX_JOB_AGE_HOURS,
    getRedisClient: () => redisClient
};
