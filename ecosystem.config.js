// BulletBrain v3.0 — PM2 Ecosystem Configuration
// Phase D14: Shadow Trading Engine
// Deploy: pm2 start ecosystem.config.js

module.exports = {
  apps: [{
    name: 'bulletbrain-shadow',
    script: 'src/live/shadowRunner.js',
    
    // Process management
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    
    // Restart policy
    max_memory_restart: '512M',
    restart_delay: 10000,
    max_restarts: 10,
    min_uptime: '30s',
    
    // Auto-restart on crash
    autorestart: true,
    
    // Environment
    env: {
      NODE_ENV: 'production',
    },
    
    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/pm2_error.log',
    out_file: 'logs/pm2_out.log',
    merge_logs: true,
    
    // Rotate logs (keep 7 days)
    max_size: '10M',
    retain: 7,
    
    // Tokyo timezone
    time: true,
  }],
};
