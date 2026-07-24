// BulletBrain v3.0 — PM2 Ecosystem Configuration
// Deploy: pm2 start ecosystem.config.js

require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [
    {
      name: 'bb-live-eth',
      script: 'src/live/liveRunner.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: '30s',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        BB_SYMBOL: 'ethusdt',
        BB_LIVE: 'true',
        BB_CAPITAL: '90',
        BINANCE_API_KEY: process.env.BINANCE_API_KEY,
        BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2_error.log',
      out_file: 'logs/pm2_out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 7,
      time: true,
    },
    {
      name: 'bulletbrain-shadow',
      script: 'src/live/shadowRunner.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: '30s',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2_error.log',
      out_file: 'logs/pm2_out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 7,
      time: true,
    },
  ],
};