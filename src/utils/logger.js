'use strict';

const fs   = require('fs');
const path = require('path');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const COLORS = {
  DEBUG: '\x1b[36m',  // cyan
  INFO:  '\x1b[32m',  // green
  WARN:  '\x1b[33m',  // yellow
  ERROR: '\x1b[31m',  // red
  RESET: '\x1b[0m',
};

const LOG_DIR  = path.join(process.cwd(), 'logs');
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Log file: one per day
function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `bulletbrain-${date}.log`);
}

function format(level, message, meta) {
  const ts   = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level}] ${message}${metaStr}`;
}

function write(level, message, meta) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const line = format(level, message, meta);

  // Console output with color
  const color = COLORS[level] || '';
  process.stdout.write(`${color}${line}${COLORS.RESET}\n`);

  // File output (no color codes)
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch {
    // Non-fatal — don't crash the engine if logging fails
  }
}

const logger = {
  debug: (msg, meta) => write('DEBUG', msg, meta),
  info:  (msg, meta) => write('INFO',  msg, meta),
  warn:  (msg, meta) => write('WARN',  msg, meta),
  error: (msg, meta) => write('ERROR', msg, meta),

  // Phase progress helper
  phase: (phase, step, msg) => write('INFO', `[${phase}][${step}] ${msg}`),
};

module.exports = logger;
