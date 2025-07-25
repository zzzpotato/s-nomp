import { createClient } from 'redis';

export default function createRedisClient(redisConfig) {
    const client = createClient({
        socket: {
            host: redisConfig.host || 'localhost',
            port: redisConfig.port || 6379,
            path: redisConfig.socket || undefined,
            connectTimeout: 5000,
            lazyConnect: true
        },
        password: redisConfig.password || undefined,
        database: redisConfig.db || 0,
        retryDelayOnFailover: 100,
        enableOfflineQueue: false
    });

    client.on('error', (err) => {
        console.error('Redis Client Error:', err);
    });

    client.on('connect', () => {
        console.log('Redis Client Connected');
    });

    client.on('ready', () => {
        console.log('Redis Client Ready');
    });

    client.on('end', () => {
        console.log('Redis Client Disconnected');
    });

    // Connect immediately
    client.connect().catch(console.error);

    return client;
}
