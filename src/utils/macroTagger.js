'use strict';

/**
 * BulletBrain v3.0 — Macro Event Tagger
 * Phase D5 — Step 0.6
 *
 * Tags candles within macro event blackout windows.
 * Strategy backtests skip signals during these windows.
 * Engine tightens stops on existing trades during blackout.
 *
 * Events: US CPI, FOMC decisions, Non-Farm Payrolls
 * Blackout: 30 min before + 15 min after each event
 *
 * Source: backtestplan.md lines 548-570 (Step 0.6)
 *
 * Expected impact:
 *   ~3% of trading time blacked out
 *   ~25% reduction in unexpected stop-outs during event periods
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// LOAD EVENTS
// ─────────────────────────────────────────────────────────────────────────────

let _cachedEvents = null;

/**
 * Load macro events from data/macro_events.json.
 * Cached after first load.
 *
 * @returns {object[]} array of event objects
 */
function loadMacroEvents() {
  if (_cachedEvents) return _cachedEvents;

  const filePath = path.join(process.cwd(), 'data', 'macro_events.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`macro_events.json not found at ${filePath}`);
  }

  _cachedEvents = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return _cachedEvents;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLACKOUT CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a candle timestamp falls within any macro event blackout window.
 *
 * Blackout window = [event.timestamp - blackout_before_min * 60000,
 *                    event.timestamp + blackout_after_min  * 60000]
 *
 * @param {number}   timestamp   - candle openTime in milliseconds
 * @param {object[]} [events]    - optional events array (uses loaded file if not provided)
 * @returns {{ inBlackout: boolean, event: string|null, eventTime: number|null }}
 */
function isInBlackout(timestamp, events) {
  const macroEvents = events || loadMacroEvents();

  for (const evt of macroEvents) {
    const windowStart = evt.timestamp - evt.blackout_before_min * 60 * 1000;
    const windowEnd   = evt.timestamp + evt.blackout_after_min  * 60 * 1000;

    if (timestamp >= windowStart && timestamp <= windowEnd) {
      return {
        inBlackout: true,
        event:      evt.event,
        eventTime:  evt.timestamp,
        date:       evt.date,
      };
    }
  }

  return { inBlackout: false, event: null, eventTime: null, date: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDLE TAGGING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tag an array of candles with blackout information.
 * Adds `.blackout` field to each candle.
 *
 * @param {object[]} candles - array of candles with .openTime field
 * @param {object[]} [events] - optional events array
 * @returns {object[]} candles with .blackout field added
 */
function tagCandlesWithBlackout(candles, events) {
  const macroEvents = events || loadMacroEvents();

  // Build a sorted list of blackout windows for efficient lookup
  const windows = macroEvents.map(evt => ({
    start: evt.timestamp - evt.blackout_before_min * 60 * 1000,
    end:   evt.timestamp + evt.blackout_after_min  * 60 * 1000,
    event: evt.event,
    date:  evt.date,
  })).sort((a, b) => a.start - b.start);

  return candles.map(candle => {
    const ts = candle.openTime;

    // Binary search for efficiency on large datasets
    let lo = 0;
    let hi = windows.length - 1;
    let inBlackout = false;
    let eventName  = null;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w   = windows[mid];

      if (ts >= w.start && ts <= w.end) {
        inBlackout = true;
        eventName  = w.event;
        break;
      } else if (ts < w.start) {
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return { ...candle, blackout: inBlackout, blackoutEvent: eventName || null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STATISTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate blackout statistics for a candle array.
 * Used to verify ~3% of trading time is blacked out.
 *
 * @param {object[]} candles - candles with .blackout field
 * @returns {{ total, blacked, pct, byEvent }}
 */
function calcBlackoutStats(candles) {
  const total   = candles.length;
  const blacked = candles.filter(c => c.blackout).length;
  const byEvent = {};

  candles.forEach(c => {
    if (c.blackout && c.blackoutEvent) {
      byEvent[c.blackoutEvent] = (byEvent[c.blackoutEvent] || 0) + 1;
    }
  });

  return {
    total,
    blacked,
    pct:     parseFloat((blacked / total * 100).toFixed(2)),
    byEvent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  loadMacroEvents,
  isInBlackout,
  tagCandlesWithBlackout,
  calcBlackoutStats,
};
