// BulletBrain v3.0 — PM2 Ecosystem Configuration
// Deploy: pm2 start ecosystem.config.js
//
// CURRENT STRATEGY STATUS (2026-08-19):
//   bb-live-eth:      STOPPED — old pool-sweep strategy (no edge)
//   bulletbrain-shadow: STOPPED — replaced by liq-collector
//   bb-wfo-eth:       PROMOTED — 60m WFO EMA crossover (Sharpe 6.52 OOS)
//                     STATUS: Paper mode (no BB_LIVE=true until local run confirmed)
//   bb-liq-collector: ACTIVE — collecting liquidation/orderbook data for 4 weeks
//                     Running paper trades of liquidation cascade strategy

require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [
    // ── TRACK 1: 60m WFO Strategy (promoted, paper mode first) ──────────
    {
      name: 'bb-wfo-eth',
      script: 'src/live/wfoRunner.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: '30s',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        BB_SYMBOL: 'ethusdt',
        // BB_LIVE: 'true',  // UNCOMMENT ONLY AFTER LOCAL PAPER RUN CONFIRMS CORRECT BEHAVIOR
        BB_CAPITAL: '100',
        BINANCE_API_KEY:    process.env.BINANCE_API_KEY,
        BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/wfo_error.log',
      out_file:   'logs/wfo_out.log',
      merge_logs: true,
      time: true,
    },

    // ── TRACK 2: Liquidation + Order Book Data Collector ─────────────────
    {
      name: 'bb-liq-collector',
      script: 'src/live/liquidationCollector.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 15000,
      max_restarts: 20,         // more restarts — data collection must stay up
      min_uptime: '10s',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        BB_SYMBOL: 'ethusdt',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/liq_error.log',
      out_file:   'logs/liq_out.log',
      merge_logs: true,
      time: true,
    },

    // ── STOPPED: old live runner (no edge confirmed) ──────────────────────
    // {
    //   name: 'bb-live-eth',
    //   script: 'src/live/liveRunner.js',
    //   ... (keep as reference but do not start)
    // },

    // ── STOPPED: shadow runner (replaced by liquidation collector) ────────
    // {
    //   name: 'bulletbrain-shadow',
    //   script: 'src/live/shadowRunner.js',
    //   ... (shadow runner data is superseded by liquidation collector)
    // },
  ],
};
