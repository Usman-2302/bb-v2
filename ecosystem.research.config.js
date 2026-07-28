// BulletBrain — PM2 config for the RESEARCH platform.
//
// This process performs research only. It holds no API keys and has no exchange
// client in its dependency graph, so it cannot place an order.
// Production (`ecosystem.config.js`) is a separate, frozen process.

module.exports = {
  apps: [{
    name: 'bulletbrain-research',
    script: 'src/live/claude-runner.js',
    args: '--auto --interval 60',

    instances: 1,
    exec_mode: 'fork',
    watch: false,

    // Research cycles hold several timeframes of features in memory at once.
    max_memory_restart: '2G',
    restart_delay: 30000,
    max_restarts: 50,
    min_uptime: '120s',
    autorestart: true,

    env: { NODE_ENV: 'research' },

    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/research_error.log',
    out_file: 'logs/research_out.log',
    merge_logs: true,
    max_size: '20M',
    retain: 14,
    time: true,
  }],
};
