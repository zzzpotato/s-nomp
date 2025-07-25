import express from 'express';
import os from 'os';

export default class WorkerAPI {
    constructor(port = 3000) {
        this.port = port;
        this.app = express();
        this.poolObj = null;
        
        this.counters = {
            validShares: 0,
            validBlocks: 0,
            invalidShares: 0,
            started: Date.now()
        };

        this.lastEvents = {
            lastValidShare: 0,
            lastValidBlock: 0,
            lastInvalidShare: 0
        };

        this.setupRoutes();
    }

    setupRoutes() {
        // Enable CORS
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });

        // JSON middleware
        this.app.use(express.json());

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: Date.now(),
                version: process.version,
                memory: process.memoryUsage(),
                cpu: os.cpus().length
            });
        });

        // Main stats endpoint
        this.app.get('/stats', (req, res) => {
            const clients = this.poolObj?.stratumServer?.getStratumClients 
                ? Object.keys(this.poolObj.stratumServer.getStratumClients()).length 
                : 0;

            const uptime = Date.now() - this.counters.started;
            const statsData = {
                clients,
                counters: { ...this.counters },
                lastEvents: { ...this.lastEvents },
                uptime,
                performance: {
                    validSharesPerSecond: this.counters.validShares / (uptime / 1000) || 0,
                    validBlocksPerHour: this.counters.validBlocks / (uptime / 3600000) || 0,
                    shareAcceptanceRate: this.calculateAcceptanceRate()
                },
                system: {
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage(),
                    platform: os.platform(),
                    nodeVersion: process.version
                }
            };

            res.json(statsData);
        });

        // Reset counters endpoint (for debugging)
        this.app.post('/reset', (req, res) => {
            this.resetCounters();
            res.json({ message: 'Counters reset successfully' });
        });

        // Detailed pool info endpoint
        this.app.get('/pool', (req, res) => {
            if (!this.poolObj) {
                return res.status(503).json({ error: 'Pool not started' });
            }

            const poolInfo = {
                algorithm: this.poolObj.options?.coin?.algorithm || 'unknown',
                coinName: this.poolObj.options?.coin?.name || 'unknown',
                networkDifficulty: this.poolObj.difficulty || 0,
                blockHeight: this.poolObj.blockHeight || 0,
                connections: this.poolObj.stratumServer ? 
                    Object.keys(this.poolObj.stratumServer.getStratumClients()).length : 0
            };

            res.json(poolInfo);
        });
    }

    calculateAcceptanceRate() {
        const total = this.counters.validShares + this.counters.invalidShares;
        return total > 0 ? (this.counters.validShares / total * 100).toFixed(2) : 0;
    }

    resetCounters() {
        this.counters = {
            validShares: 0,
            validBlocks: 0,
            invalidShares: 0,
            started: Date.now()
        };

        this.lastEvents = {
            lastValidShare: 0,
            lastValidBlock: 0,
            lastInvalidShare: 0
        };
    }

    async start(poolObj) {
        return new Promise((resolve, reject) => {
            this.poolObj = poolObj;
            
            // Wait for pool to start
            this.poolObj.once('started', () => {
                const server = this.app.listen(this.port, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    console.log(`Worker API listening on port ${this.port}`);
                    resolve(server);
                });

                server.on('error', reject);
            });

            // Handle share events
            this.poolObj.on('share', (isValidShare, isValidBlock, shareData) => {
                this.handleShare(isValidShare, isValidBlock, shareData);
            });

            // Handle error events
            this.poolObj.on('error', (error) => {
                console.error('Pool error:', error);
            });
        });
    }

    handleShare(isValidShare, isValidBlock, shareData) {
        const now = Date.now();
        
        if (isValidShare) {
            this.counters.validShares++;
            this.lastEvents.lastValidShare = now;
            
            if (isValidBlock) {
                this.counters.validBlocks++;
                this.lastEvents.lastValidBlock = now;
                console.log(`Valid block found by ${shareData.worker || 'unknown'}`);
            }
        } else {
            this.counters.invalidShares++;
            this.lastEvents.lastInvalidShare = now;
        }
    }

    stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(resolve);
            });
        }
        return Promise.resolve();
    }
}

