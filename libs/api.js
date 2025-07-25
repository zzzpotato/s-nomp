import stats from './stats.js';

export default class PoolAPI {
    constructor(logger, portalConfig, poolConfigs) {
        this.logger = logger;
        this.portalConfig = portalConfig;
        this.poolConfigs = poolConfigs;
        this.portalStats = new stats(logger, portalConfig, poolConfigs);
        this.liveStatConnections = new Map();
    }

    async handleApiRequest(req, res, next) {
        const { method } = req.params;

        switch (method) {
            case 'stats':
                this.sendJsonResponse(res, this.portalStats.statsString);
                return;

            case 'pool_stats':
                this.sendJsonResponse(res, JSON.stringify(this.portalStats.statPoolHistory));
                return;

            case 'blocks':
            case 'getblocksstats':
                try {
                    const data = await this.getBlocksData();
                    this.sendJsonResponse(res, JSON.stringify(data));
                } catch (error) {
                    this.sendErrorResponse(res, error);
                }
                return;

            case 'payments':
                const poolBlocks = Object.keys(this.portalStats.stats.pools).map(pool => ({
                    name: pool,
                    pending: this.portalStats.stats.pools[pool].pending,
                    payments: this.portalStats.stats.pools[pool].payments
                }));
                this.sendJsonResponse(res, JSON.stringify(poolBlocks));
                return;

            case 'worker_stats':
                await this.handleWorkerStats(req, res);
                return;

            case 'live_stats':
                this.handleLiveStats(req, res);
                return;

            default:
                next();
        }
    }

    async handleWorkerStats(req, res) {
        const urlParams = req.url.split('?');
        
        if (urlParams.length <= 1) {
            this.sendErrorResponse(res, 'Missing parameters');
            return;
        }

        const address = urlParams[1]?.split('.')[0];
        
        if (!address) {
            this.sendErrorResponse(res, 'Invalid address');
            return;
        }

        try {
            const [balances, shares] = await Promise.all([
                this.getBalanceByAddress(address),
                this.getTotalSharesByAddress(address)
            ]);

            const { history, workers, totalHash, networkSols } = this.processWorkerData(address, balances);

            const response = {
                miner: address,
                totalHash,
                totalShares: shares,
                networkSols,
                immature: balances.totalImmature,
                balance: balances.totalHeld,
                paid: balances.totalPaid,
                workers,
                history
            };

            this.sendJsonResponse(res, JSON.stringify(response));
        } catch (error) {
            this.sendErrorResponse(res, error);
        }
    }

    processWorkerData(address, balances) {
        const history = {};
        const workers = {};
        let totalHash = 0;
        let networkSols = 0;

        // Process historical data
        for (const historyEntry of this.portalStats.statHistory) {
            for (const [pool, poolData] of Object.entries(historyEntry.pools)) {
                for (const [workerName, workerData] of Object.entries(poolData.workers)) {
                    if (workerName.startsWith(address)) {
                        if (!history[workerName]) {
                            history[workerName] = [];
                        }
                        
                        if (workerData.hashrate) {
                            history[workerName].push({
                                time: historyEntry.time,
                                hashrate: workerData.hashrate
                            });
                        }
                    }
                }
            }
        }

        // Process current workers
        for (const [pool, poolData] of Object.entries(this.portalStats.stats.pools)) {
            for (const [workerName, workerData] of Object.entries(poolData.workers)) {
                if (workerName.startsWith(address)) {
                    workers[workerName] = { ...workerData };
                    
                    // Add balance information
                    const workerBalance = balances.balances.find(b => b.worker === workerName);
                    if (workerBalance) {
                        workers[workerName].paid = workerBalance.paid;
                        workers[workerName].balance = workerBalance.balance;
                    }
                    
                    workers[workerName].balance = workers[workerName].balance || 0;
                    workers[workerName].paid = workers[workerName].paid || 0;
                    totalHash += poolData.workers[workerName].hashrate;
                    networkSols = poolData.poolStats.networkSols;
                }
            }
        }

        return { history, workers, totalHash, networkSols };
    }

    handleLiveStats(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });
        
        res.write('\n');
        
        const uid = Math.random().toString(36).substring(2, 15);
        this.liveStatConnections.set(uid, res);
        
        if (res.flush) {
            res.flush();
        }

        req.on('close', () => {
            this.liveStatConnections.delete(uid);
        });

        req.on('error', () => {
            this.liveStatConnections.delete(uid);
        });
    }

    handleAdminApiRequest(req, res, next) {
        const { method } = req.params;

        switch (method) {
            case 'pools':
                this.sendJsonResponse(res, JSON.stringify({ result: this.poolConfigs }));
                return;

            default:
                next();
        }
    }

    sendJsonResponse(res, data) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(data);
    }

    sendErrorResponse(res, error) {
        this.sendJsonResponse(res, JSON.stringify({ 
            result: 'error', 
            message: error.message || error 
        }));
    }

    // Promisify callback-based methods
    getBlocksData() {
        return new Promise((resolve, reject) => {
            this.portalStats.getBlocks((data) => {
                if (data) {
                    resolve(data);
                } else {
                    reject(new Error('Failed to get blocks data'));
                }
            });
        });
    }

    getBalanceByAddress(address) {
        return new Promise((resolve, reject) => {
            this.portalStats.getBalanceByAddress(address, (balances) => {
                if (balances) {
                    resolve(balances);
                } else {
                    reject(new Error('Failed to get balance data'));
                }
            });
        });
    }

    getTotalSharesByAddress(address) {
        return new Promise((resolve, reject) => {
            this.portalStats.getTotalSharesByAddress(address, (shares) => {
                resolve(shares);
            });
        });
    }

    broadcastLiveStats(data) {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        
        for (const [uid, res] of this.liveStatConnections) {
            try {
                res.write(message);
                if (res.flush) {
                    res.flush();
                }
            } catch (error) {
                this.liveStatConnections.delete(uid);
            }
        }
    }

    close() {
        for (const [uid, res] of this.liveStatConnections) {
            try {
                res.end();
            } catch (error) {
                // Connection already closed
            }
        }
        this.liveStatConnections.clear();
    }
}
