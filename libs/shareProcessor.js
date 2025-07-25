import CreateRedisClient from './createRedisClient.js';

/*
This module deals with handling shares when in internal payment processing mode. It connects to a redis
database and inserts shares with the database structure of:

key: coin_name + ':' + block_height
value: a hash with various share data
*/

export default class ShareProcessor {
    constructor(logger, poolConfig) {
        this.logger = logger;
        this.poolConfig = poolConfig;
        this.redisConfig = poolConfig.redis;
        this.coin = poolConfig.coin.name;
        
        this.forkId = process.env.__FORKID || process.env.forkId;
        this.logSystem = 'Pool';
        this.logComponent = this.coin;
        this.logSubCat = `Thread ${parseInt(this.forkId || 0) + 1}`;
        
        this.initializeRedisConnection();
    }

    async initializeRedisConnection() {
        try {
            this.connection = CreateRedisClient(this.redisConfig);
            
            this.connection.on('ready', () => {
                this.logger.debug(this.logSystem, this.logComponent, this.logSubCat, 
                    `Share processing setup with redis (${this.redisConfig.host}:${this.redisConfig.port})`);
            });
            
            this.connection.on('error', (err) => {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                    `Redis client had an error: ${JSON.stringify(err)}`);
            });
            
            this.connection.on('end', () => {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                    'Connection to redis database has been ended');
            });

            await this.checkRedisVersion();
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                `Failed to initialize Redis connection: ${error.message}`);
        }
    }

    async checkRedisVersion() {
        try {
            const response = await this.connection.info();
            const parts = response.split('\r\n');
            let version;
            let versionString;
            
            for (const part of parts) {
                if (part.includes(':')) {
                    const [key, value] = part.split(':');
                    if (key === 'redis_version') {
                        versionString = value;
                        version = parseFloat(versionString);
                        break;
                    }
                }
            }
            
            if (!version) {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                    'Could not detect redis version - might be super old or broken');
            } else if (version < 6.0) {
                this.logger.warning(this.logSystem, this.logComponent, this.logSubCat, 
                    `You're using redis version ${versionString}. Consider upgrading to Redis 6.0+ for better performance`);
            } else {
                this.logger.debug(this.logSystem, this.logComponent, this.logSubCat, 
                    `Redis version ${versionString} detected`);
            }
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                `Redis version check failed: ${error.message}`);
        }
    }

    async handleShare(isValidShare, isValidBlock, shareData) {
        const multi = this.connection.multi();
        
        try {
            if (isValidShare) {
                multi.hIncrByFloat(`${this.coin}:shares:roundCurrent`, shareData.worker, shareData.difficulty);
                multi.hIncrBy(`${this.coin}:stats`, 'validShares', 1);
            } else {
                multi.hIncrBy(`${this.coin}:stats`, 'invalidShares', 1);
            }

            /* Stores share diff, worker, and unique value with a score that is the timestamp. Unique value ensures it
               doesn't overwrite an existing entry, and timestamp as score lets us query shares from last X minutes to
               generate hashrate for each worker and pool. */
            const dateNow = Date.now();
            const hashrateData = [
                isValidShare ? shareData.difficulty : -shareData.difficulty, 
                shareData.worker, 
                dateNow
            ];
            multi.zAdd(`${this.coin}:hashrate`, {
                score: Math.floor(dateNow / 1000),
                value: hashrateData.join(':')
            });

            if (isValidBlock) {
                multi.rename(`${this.coin}:shares:roundCurrent`, `${this.coin}:shares:round${shareData.height}`);
                multi.rename(`${this.coin}:shares:timesCurrent`, `${this.coin}:shares:times${shareData.height}`);
                const blockData = [
                    shareData.blockHash, 
                    shareData.txHash, 
                    shareData.height, 
                    shareData.worker, 
                    dateNow
                ].join(':');
                multi.sAdd(`${this.coin}:blocksPending`, blockData);
                multi.hIncrBy(`${this.coin}:stats`, 'validBlocks', 1);
            } else if (shareData.blockHash) {
                multi.hIncrBy(`${this.coin}:stats`, 'invalidBlocks', 1);
            }

            await multi.exec();
        } catch (err) {
            this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 
                `Error with share processor multi: ${JSON.stringify(err)}`);
        }
    }

    async close() {
        if (this.connection) {
            await this.connection.quit();
        }
    }
}
