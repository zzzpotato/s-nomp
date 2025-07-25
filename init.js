import fs from 'fs';
import path from 'path';
import os from 'os';
import cluster from 'cluster';
import { fileURLToPath } from 'url';
import async from 'async';
import extend from 'extend';
import redis from 'redis';
import PoolLogger from './libs/logUtil.js';
import CliListener from './libs/cliListener.js';
import PoolWorker from './libs/poolWorker.js';
import PaymentProcessor from './libs/paymentProcessor.js';
import Website from './libs/website.js';
import ProfitSwitch from './libs/profitSwitch.js';
import CreateRedisClient from './libs/createRedisClient.js';
import algos from 'stratum-pool/lib/algoProperties.js';
import minify from 'node-json-minify';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

JSON.minify = JSON.minify || minify;

if (!fs.existsSync('config.json')){
    console.log('config.json file does not exist. Read the installation/setup instructions.');
    process.exit(1);
}

const portalConfig = JSON.parse(JSON.minify(fs.readFileSync("config.json", {encoding: 'utf8'})));
let poolConfigs;

const logger = new PoolLogger({
    logLevel: portalConfig.logLevel,
    logColors: portalConfig.logColors
});

try {
    const newrelic = await import('newrelic');
    if (cluster.isPrimary)
        logger.debug('NewRelic', 'Monitor', 'New Relic initiated');
} catch(e) {}

//Try to give process ability to handle 100k concurrent connections
try{
    const posix = await import('posix');
    try {
        posix.setrlimit('nofile', { soft: 100000, hard: 100000 });
    }
    catch(e){
        if (cluster.isPrimary)
            logger.warning('POSIX', 'Connection Limit', `Failed to set connection limit: ${e.message}, (Safe to ignore)`);
    }
} catch(e) {
    if (cluster.isPrimary)
        logger.debug('POSIX', 'Connection Limit', 'POSIX module not installed (npm install posix)');
}

if (cluster.isPrimary){
    const buildPoolConfigs = () => {
        const configs = {};
        const configDir = './pool_configs/';

        if (!fs.existsSync(configDir)){
            logger.error('Master', 'PoolConfigs', 'No pool config files found at expected location "./pool_configs"');
            return;
        }

        const poolConfigFiles = [];

        fs.readdirSync(configDir).forEach(file => {
            if (!fs.lstatSync(configDir + file).isDirectory()){
                const poolName = file.split('.')[0];
                const poolOptions = JSON.parse(JSON.minify(fs.readFileSync(configDir + file, {encoding: 'utf8'})));
                poolOptions.fileName = file;
                poolOptions.logCategory = poolName;
                configs[poolName] = poolOptions;
                poolConfigFiles.push(poolName);
            }
        });

        if (Object.keys(configs).length === 0){
            logger.warning('Master', 'PoolConfigs', 'No enabled pools configured');
            return;
        }

        poolConfigFiles.forEach(poolOptions => {
            const poolName = poolOptions;
            const poolConfig = configs[poolName];

            //ensure coin address and rewardRecipients are set before starting anything
            if (!poolConfig.address){
                logger.error('Master', poolName, 'No address configured');
                delete configs[poolName];
            }
        });

        return configs;
    };

    const spawnPoolWorkers = () => {
        Object.keys(poolConfigs).forEach(coin => {
            const p = poolConfigs[coin];

            if (!Array.isArray(p.daemons) || p.daemons.length < 1){
                logger.error('Master', coin, 'No daemons configured so a pool cannot be started for this coin.');
                delete poolConfigs[coin];
            }
        });

        if (Object.keys(poolConfigs).length === 0){
            logger.warning('Master', 'PoolSpawner', 'No valid pool configs to spawn');
            return;
        }

        const serializedConfigs = JSON.stringify(poolConfigs);

        const numForks = (() => {
            if (!portalConfig.clustering || !portalConfig.clustering.enabled)
                return 1;
            if (portalConfig.clustering.forks === 'auto')
                return os.cpus().length;
            if (!portalConfig.clustering.forks || isNaN(portalConfig.clustering.forks))
                return 1;
            return portalConfig.clustering.forks;
        })();

        const poolWorkers = {};

        const createPoolWorker = forkId => {
            const worker = cluster.fork({
                __FORKID: forkId,
                pools: serializedConfigs,
                portalConfig: JSON.stringify(portalConfig)
            });
            worker.forkId = forkId;
            worker.type = 'pool';
            poolWorkers[forkId] = worker;
            worker.on('exit', (code, signal) => {
                logger.error('Master', 'PoolSpawner', `Fork ${forkId} died, spawning replacement worker...`);
                setTimeout(() => {
                    createPoolWorker(forkId);
                }, 2000);
            }).on('message', msg => {
                switch(msg.type){
                    case 'banIP':
                        Object.keys(cluster.workers).forEach(id => {
                            cluster.workers[id].send({type: 'banIP', ip: msg.ip});
                        });
                        break;
                }
            });
        };

        let i = 1;
        const spawnInterval = setInterval(() => {
            createPoolWorker(i);
            i++;
            if (i - 1 === numForks) {
                clearInterval(spawnInterval);
                logger.debug('Master', 'PoolSpawner', `Spawned ${numForks} pool workers`);

                //Pay workers every 30 seconds
                const paymentProcessingConfig = portalConfig.paymentProcessing;
                const paymentProcessingEnabled = paymentProcessingConfig && paymentProcessingConfig.enabled;

                if (paymentProcessingEnabled){
                    setInterval(() => {
                        startPaymentProcessor();
                    }, paymentProcessingConfig.paymentInterval * 1000);
                }
            }
        }, 250);
    };

    const startCliListener = () => {
        const cliPort = portalConfig.cliPort;
        const listener = new CliListener(cliPort);
        listener.on('log', text => {
            logger.debug('Master', 'CLI', text);
        }).on('command', (command, params, options, reply) => {
            switch(command){
                case 'blocknotify':
                    Object.keys(cluster.workers).forEach(id => {
                        cluster.workers[id].send({type: 'blocknotify', coin: params[0], hash: params[1]});
                    });
                    reply('Pool workers notified');
                    break;
                case 'coinswitch':
                    processCoinSwitchCommand(params, options, reply);
                    break;
                case 'reloadpool':
                    Object.keys(cluster.workers).forEach(id => {
                        cluster.workers[id].send({type: 'reloadpool', coin: params[0]});
                    });
                    reply('reloaded pool ' + params[0]);
                    break;
                default:
                    reply('unrecognized command "' + command + '"');
                    break;
            }
        });
    };

    const processCoinSwitchCommand = (params, options, reply) => {
        let logSystem = 'CLI';
        let logComponent = 'coinswitch';

        const replyError = msg => {
            reply(msg);
            logger.error(logSystem, logComponent, msg);
        };

        if (!params[0]) {
            replyError('Coin name required');
            return;
        }

        if (!portalConfig.switching) {
            replyError('No switching setup in config');
            return;
        }

        const switchName = params[0];

        if (!portalConfig.switching[switchName]) {
            replyError(`Switching for ${switchName} not configured`);
            return;
        }

        if (!options.algorithm && !Object.keys(portalConfig.switching).filter(s => {
            return portalConfig.switching[s].enabled && portalConfig.switching[s].algorithm === portalConfig.switching[switchName].algorithm;
        }).length > 1) {
            replyError('Cannot switch with no algorithm specified');
            return;
        }

        const newCoin = Object.keys(poolConfigs).filter(p => {
            return p === switchName;
        })[0];

        if (!newCoin) {
            replyError(`Coin ${switchName} not configured`);
            return;
        }

        const algo = poolConfigs[newCoin].coin.algorithm;

        const switchNames = [];

        if (!options.algorithm)
            switchNames.push(switchName);
        else {
            Object.keys(portalConfig.switching).forEach(name => {
                if (portalConfig.switching[name].enabled && portalConfig.switching[name].algorithm === algo)
                    switchNames.push(name);
            });
        }

        switchNames.forEach(name => {
            if (portalConfig.switching[name] && portalConfig.switching[name].enabled) {
                poolConfigs[newCoin].switchingPools = switchNames;
                Object.keys(cluster.workers).forEach(id => {
                    cluster.workers[id].send({type: 'coinswitch', coin: newCoin, switchNames: switchNames});
                });
                reply(`Pools ${switchNames} switched to ${newCoin}`);
                logger.debug(logSystem, logComponent, `Pools ${switchNames} switched to ${newCoin}`);
            }
        });
    };

    const startPaymentProcessor = () => {
        const worker = cluster.fork({
            workerType: 'paymentProcessor',
            pools: JSON.stringify(poolConfigs),
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.on('exit', (code, signal) => {
            logger.error('Master', 'Payment Processor', `Payment processor died, spawning replacement... (Code: ${code})`);
            setTimeout(() => {
                startPaymentProcessor();
            }, 2000);
        });
    };

    const startWebsite = () => {
        const worker = cluster.fork({
            workerType: 'website',
            pools: JSON.stringify(poolConfigs),
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.on('exit', (code, signal) => {
            logger.error('Master', 'Website', `Website process died, spawning replacement... (Code: ${code})`);
            setTimeout(() => {
                startWebsite();
            }, 2000);
        });
    };

    const startProfitSwitch = () => {
        const worker = cluster.fork({
            workerType: 'profitSwitch',
            pools: JSON.stringify(poolConfigs),
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.on('exit', (code, signal) => {
            logger.error('Master', 'Profit Switcher', `Profit switching process died, spawning replacement... (Code: ${code})`);
            setTimeout(() => {
                startProfitSwitch();
            }, 2000);
        });
    };

    (async () => {
        poolConfigs = buildPoolConfigs();

        spawnPoolWorkers();

        startCliListener();

        if (portalConfig.website && portalConfig.website.enabled){
            startWebsite();
        }

        if (portalConfig.switching && portalConfig.switching.enabled){
            startProfitSwitch();
        }
    })();

} else {
    if (process.env.workerType === 'paymentProcessor'){
        new PaymentProcessor(logger);
    }
    else if (process.env.workerType === 'website'){
        new Website(logger);
    }
    else if (process.env.workerType === 'profitSwitch'){
        new ProfitSwitch(logger);
    }
    else{
        new PoolWorker(logger);
    }
}
