// jobs.js - Sistema de gestión de jobs con Redis
const redis = require('redis');

// Configuración de Redis desde la URL proporcionada
const REDIS_URL = 'redis://default:PfqouJPJQPmfJK7KhrqISWdFwXVJPkhP@redis-16659.c57.us-east-1-4.ec2.cloud.redislabs.com:16659';

// Configuración de limpieza
const MAX_JOBS_STORED = 50;
const MAX_JOB_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MINUTES = 60;

// Cliente Redis
let redisClient;
const JOB_PREFIX = 'job:';
const JOB_IDS_SET = 'job_ids';
const JOB_QUEUE_ZSET = 'job_queue';

// Inicializar Redis
async function initializeRedis() {
    try {
        redisClient = redis.createClient({
            url: REDIS_URL,
            socket: {
                connectTimeout: 10000, // 10s timeout de conexión
                reconnectStrategy: retries => {
                    if (retries > 10) {
                        console.error('❌ Máximo de reconexiones alcanzado');
                        return new Error('Máximo de reconexiones alcanzado');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });

        redisClient.on('error', (err) => {
            console.error('❌ Error de Redis:', err);
        });

        redisClient.on('connect', () => {
            console.log('🔗 Conectando a Redis...');
        });

        redisClient.on('ready', () => {
            console.log('✅ Conectado y listo Redis');
        });

        await redisClient.connect();
        return true;
    } catch (error) {
        console.error('❌ Error al conectar a Redis:', error);
        return false;
    }
}

// Helper para generar ID único
function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Crear un nuevo job
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
        videoUrl: job.videoUrl || '',
        error: job.error || '',
        createdAt: now.toString(),
        updatedAt: now.toString(),
        inputProps: JSON.stringify(job.inputProps)
    });

    await redisClient.expire(jobKey, MAX_JOB_AGE_HOURS * 3600);
    await redisClient.sAdd(JOB_IDS_SET, id);
    await redisClient.zAdd(JOB_QUEUE_ZSET, [{ score: now, value: id }]);

    console.log(`📝 Job creado: ${id}`);

    const totalJobs = await redisClient.sCard(JOB_IDS_SET);
    if (totalJobs > MAX_JOBS_STORED * 1.5) {
        setTimeout(() => cleanupOldJobs(), 1000);
    }

    return job;
}

// Obtener un job por ID
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

// Actualizar un job
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

// Limpiar jobs viejos
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

    // Limitar cantidad de jobs
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

// Iniciar limpieza automática
async function startAutoCleanup() {
    console.log('🔄 Iniciando limpieza inicial de jobs...');
    await cleanupOldJobs();

    setInterval(async () => {
        console.log('⏰ Ejecutando limpieza automática periódica...');
        await cleanupOldJobs();
    }, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

    console.log(`✅ Limpieza automática configurada cada ${CLEANUP_INTERVAL_MINUTES} minutos`);
}

// Inicializar sistema
let isInitialized = false;
async function init() {
    if (isInitialized) return true;
    isInitialized = await initializeRedis();
    if (isInitialized) {
        await startAutoCleanup();
    }
    return isInitialized;
}

// Inicializar automáticamente
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
