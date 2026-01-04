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
                reconnectStrategy: (retries) => {
                    if (retries > 10) {
                        console.log('❌ Máximo de reconexiones alcanzado');
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
            console.log('✅ Conectado a Redis');
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
    try {
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

        // Guardar job en Redis
        const jobKey = JOB_PREFIX + id;
        await redisClient.hSet(jobKey, {
            id,
            status: job.status,
            videoUrl: job.videoUrl || '',
            error: job.error || '',
            createdAt: job.createdAt.toString(),
            updatedAt: job.updatedAt.toString(),
            inputProps: JSON.stringify(job.inputProps)
        });

        // Establecer TTL (24 horas)
        await redisClient.expire(jobKey, MAX_JOB_AGE_HOURS * 3600);

        // Añadir a conjunto de IDs
        await redisClient.sAdd(JOB_IDS_SET, id);

        // Añadir a sorted set por timestamp (para limpieza)
        await redisClient.zAdd(JOB_QUEUE_ZSET, [
            { score: now, value: id }
        ]);

        console.log(`📝 Job creado: ${id}`);

        // Verificar límite de jobs
        const totalJobs = await redisClient.sCard(JOB_IDS_SET);
        if (totalJobs > MAX_JOBS_STORED * 1.5) {
            setTimeout(() => cleanupOldJobs(), 1000);
        }

        return job;
    } catch (error) {
        console.error('❌ Error al crear job:', error);
        throw error;
    }
}

// Obtener un job por ID
async function getJob(id) {
    try {
        const jobKey = JOB_PREFIX + id;
        const jobData = await redisClient.hGetAll(jobKey);

        if (!jobData || !jobData.id) {
            return null;
        }

        // Convertir campos numéricos y JSON
        return {
            ...jobData,
            createdAt: parseInt(jobData.createdAt),
            updatedAt: parseInt(jobData.updatedAt),
            inputProps: JSON.parse(jobData.inputProps || '{}')
        };
    } catch (error) {
        console.error('❌ Error al obtener job:', error);
        return null;
    }
}

// Actualizar un job
async function updateJob(id, patch) {
    try {
        const jobKey = JOB_PREFIX + id;
        const exists = await redisClient.exists(jobKey);

        if (!exists) {
            return false;
        }

        const updates = {
            updatedAt: Date.now().toString()
        };

        // Añadir campos específicos del patch
        if (patch.status) updates.status = patch.status;
        if (patch.videoUrl !== undefined) updates.videoUrl = patch.videoUrl || '';
        if (patch.error !== undefined) updates.error = patch.error || '';
        if (patch.inputProps) updates.inputProps = JSON.stringify(patch.inputProps);

        // Actualizar en Redis
        await redisClient.hSet(jobKey, updates);

        // Actualizar TTL
        await redisClient.expire(jobKey, MAX_JOB_AGE_HOURS * 3600);

        return true;
    } catch (error) {
        console.error('❌ Error al actualizar job:', error);
        return false;
    }
}

// Limpiar jobs viejos
async function cleanupOldJobs() {
    try {
        const now = Date.now();
        const maxAgeMs = MAX_JOB_AGE_HOURS * 3600 * 1000;
        const cutoffTime = now - maxAgeMs;

        let deletedCount = 0;

        // 1. Eliminar jobs muy viejos del sorted set
        const oldJobs = await redisClient.zRangeByScore(JOB_QUEUE_ZSET, 0, cutoffTime);

        if (oldJobs.length > 0) {
            for (const jobId of oldJobs) {
                const jobKey = JOB_PREFIX + jobId;

                // Eliminar job
                await redisClient.del(jobKey);
                // Eliminar de conjunto de IDs
                await redisClient.sRem(JOB_IDS_SET, jobId);
                // Eliminar de sorted set
                await redisClient.zRem(JOB_QUEUE_ZSET, jobId);

                deletedCount++;
                console.log(`🗑️ Eliminado (viejo): ${jobId}`);
            }
        }

        // 2. Si aún hay demasiados, eliminar los más viejos
        const totalJobs = await redisClient.sCard(JOB_IDS_SET);

        if (totalJobs > MAX_JOBS_STORED) {
            const jobsToRemove = totalJobs - MAX_JOBS_STORED;
            const oldestJobs = await redisClient.zRange(JOB_QUEUE_ZSET, 0, jobsToRemove - 1);

            for (const jobId of oldestJobs) {
                const jobKey = JOB_PREFIX + jobId;

                await redisClient.del(jobKey);
                await redisClient.sRem(JOB_IDS_SET, jobId);
                await redisClient.zRem(JOB_QUEUE_ZSET, jobId);

                deletedCount++;
                console.log(`🗑️ Eliminado (límite): ${jobId}`);
            }
        }

        if (deletedCount > 0) {
            const remaining = await redisClient.sCard(JOB_IDS_SET);
            console.log(`🧹 Limpieza completada: ${deletedCount} jobs eliminados, ${remaining} restantes`);
        }

        return deletedCount;
    } catch (error) {
        console.error('❌ Error en cleanup:', error);
        return 0;
    }
}

// Obtener estadísticas
async function getJobsStats() {
    try {
        const allJobIds = await redisClient.sMembers(JOB_IDS_SET);
        const now = Date.now();

        const stats = {
            totalJobs: allJobIds.length,
            byStatus: {
                queued: 0,
                rendering: 0,
                uploading: 0,
                done: 0,
                error: 0
            },
            oldestJobHours: 0,
            newestJobHours: 0
        };

        let oldestTime = now;
        let newestTime = 0;

        // Procesar jobs en lotes para mejor rendimiento
        for (let i = 0; i < allJobIds.length; i += 100) {
            const batchIds = allJobIds.slice(i, i + 100);
            const pipeline = redisClient.multi();

            batchIds.forEach(id => {
                pipeline.hGet(JOB_PREFIX + id, 'status');
                pipeline.hGet(JOB_PREFIX + id, 'createdAt');
            });

            const results = await pipeline.exec();

            for (let j = 0; j < batchIds.length; j++) {
                const status = results[j * 2];
                const createdAt = parseInt(results[j * 2 + 1]) || now;

                if (status && stats.byStatus[status] !== undefined) {
                    stats.byStatus[status]++;
                }

                oldestTime = Math.min(oldestTime, createdAt);
                newestTime = Math.max(newestTime, createdAt);
            }
        }

        if (allJobIds.length > 0) {
            stats.oldestJobHours = Math.round((now - oldestTime) / (1000 * 60 * 60));
            stats.newestJobHours = Math.round((now - newestTime) / (1000 * 60 * 60));
        }

        return stats;
    } catch (error) {
        console.error('❌ Error al obtener stats:', error);
        return {
            totalJobs: 0,
            byStatus: {
                queued: 0,
                rendering: 0,
                uploading: 0,
                done: 0,
                error: 0
            },
            oldestJobHours: 0,
            newestJobHours: 0
        };
    }
}

// Iniciar limpieza automática
async function startAutoCleanup() {
    try {
        console.log('🔄 Iniciando limpieza inicial de jobs...');
        await cleanupOldJobs();

        // Configurar limpieza periódica
        setInterval(async () => {
            console.log('⏰ Ejecutando limpieza automática periódica...');
            const deleted = await cleanupOldJobs();
            if (deleted > 0) {
                console.log(`✅ Limpieza automática: ${deleted} jobs eliminados`);
            }
        }, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

        console.log(`✅ Limpieza automática configurada cada ${CLEANUP_INTERVAL_MINUTES} minutos`);
        console.log(`   - Máximo de jobs: ${MAX_JOBS_STORED}`);
        console.log(`   - Edad máxima: ${MAX_JOB_AGE_HOURS} horas`);
    } catch (error) {
        console.error('❌ Error al iniciar limpieza automática:', error);
    }
}

// Obtener todos los jobs (para debugging/admin)
async function getAllJobs() {
    try {
        const jobIds = await redisClient.sMembers(JOB_IDS_SET);
        const jobs = [];

        for (const id of jobIds) {
            const job = await getJob(id);
            if (job) jobs.push(job);
        }

        return jobs;
    } catch (error) {
        console.error('❌ Error al obtener todos los jobs:', error);
        return [];
    }
}

// Inicializar el sistema
let isInitialized = false;

async function init() {
    if (!isInitialized) {
        isInitialized = await initializeRedis();
        if (isInitialized) {
            await startAutoCleanup();
        }
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
    getJobsStats,
    getAllJobs,
    init,
    MAX_JOBS_STORED,
    MAX_JOB_AGE_HOURS,
    // Exportar cliente para operaciones avanzadas
    getRedisClient: () => redisClient

};
