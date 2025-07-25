export default {
    /**
     * Application configuration section
     * http://pm2.keymetrics.io/docs/usage/application-declaration/
     */
    apps: [{
        name: 's-nomp-pool',
        script: 'init.js',
        node_args: [
            '--max_old_space_size=4096',
            '--experimental-modules',
            '--enable-source-maps'
        ],
        max_memory_restart: '4G',
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        ignore_watch: [
            'node_modules',
            'logs',
            'pool_configs'
        ],
        env: {
            NODE_ENV: 'development',
            UV_THREADPOOL_SIZE: 16
        },
        env_production: {
            NODE_ENV: 'production',
            UV_THREADPOOL_SIZE: 32
        },
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        error_file: './logs/pm2-error.log',
        out_file: './logs/pm2-out.log',
        log_file: './logs/pm2-combined.log',
        time: true,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        kill_timeout: 5000
    }]
};
