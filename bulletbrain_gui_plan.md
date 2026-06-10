# BulletBrain v3.0 — Web GUI Control Center
## Plan Document
### Status: Planning Phase | Date: June 2026

---

## 1. Purpose and Scope

The shadow runner is live, producing logs via PM2 on `ubuntu@54.249.145.15`. Right now, monitoring means SSHing into the server and reading raw log files — umpire reports every 6 hours, circuit breaker events, gate-block reasons, sweep data. That is workable for a solo developer during early testing but breaks down fast as complexity grows: three accounts (SNIPER, SCALPER, SMART) each produce independent trade logs, regime drifts happen at any time of day, and you need to be able to act (restart, change params, pause an account) without opening a terminal.

This GUI is not a dashboard that watches passively. It is a **control center** — read, understand, and act, all from one browser tab, on any device.

The scope is explicitly **shadow trading phase only**. It does not manage real orders, real wallets, or exchange API keys beyond what the bot already uses. That boundary matters for security: the GUI reads state from the bot and sends commands to it; the bot remains the only process touching Binance.

---

## 2. Core Design Principles

These are non-negotiable and shape every decision downstream.

**Read from log files and state files — no direct database dependency.** The bot already writes structured output: `logs/umpire.log`, `logs/circuit_breaker.log`, `results/*.json`, and PM2 stdout. The GUI backend parses these rather than adding a new persistence layer. This keeps the bot's architecture unchanged.

**Commands go through a command queue file, not direct process control.** The GUI writes to a `commands/pending.json` file. The shadow runner polls this file on every candle close. This preserves the bot's event loop integrity and avoids race conditions from external signals.

**All parameter edits are config-diff proposals, not live mutations.** The GUI can stage a config change. The user reviews the diff. On confirm, the backend writes a new config snapshot and schedules a graceful bot restart via PM2. The bot never gets a hot-patched config mid-candle.

**Mobile-first layout.** You are watching this from a phone at odd hours. Every panel must be readable on a 390px screen without horizontal scrolling.

**No login for localhost; simple token auth for remote.** During local development, no auth. For the server deployment, a single static bearer token in `.env` is sufficient. There are no user accounts, no OAuth, no database.

---

## 3. Technology Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Backend | Node.js + Express | Same runtime as the bot. No new language. Can import bot's own modules for parsing. |
| Real-time push | Server-Sent Events (SSE) | Lighter than WebSocket, works through proxies, perfectly suited for one-way server→browser push. |
| Frontend | Vanilla HTML + CSS + minimal JS | No React, no bundler, no build step. One `index.html` served by Express. Loads instantly. |
| Charts | Chart.js (CDN) | Already listed as available in the artifact environment. Lightweight. |
| Process control | PM2 programmatic API | `pm2.restart()`, `pm2.describe()` — already installed on the server. |
| Auth | Express middleware + `.env` token | One environment variable. Adequate for a single-user bot control panel. |

The entire GUI backend is one additional Node.js process on the same server, running on port 3000 (configurable). It reads from the same `logs/` and `results/` directories the bot writes to.

---

## 4. Backend Architecture

```
bulletbrain-gui/
├── server.js              ← Express app, SSE endpoint, command handler
├── src/
│   ├── logParser.js       ← Parses umpire.log, circuit_breaker.log, PM2 stdout
│   ├── stateReader.js     ← Reads results/*.json, current candle state
│   ├── configManager.js   ← Read/diff/stage config.js changes
│   ├── commandQueue.js    ← Write/read commands/pending.json
│   └── pm2Manager.js      ← PM2 programmatic API wrapper
├── public/
│   ├── index.html         ← Single-page control center
│   ├── style.css
│   └── app.js             ← Client-side SSE consumer + UI logic
├── commands/
│   └── pending.json       ← Command queue (polled by bot)
├── .env                   ← GUI_TOKEN, LOG_PATH, BOT_DIR
└── package.json
```

The backend exposes these HTTP endpoints:

```
GET  /api/state           → current full bot state (JSON snapshot)
GET  /api/events          → SSE stream (text/event-stream)
GET  /api/logs?tail=200   → last N lines of raw log
GET  /api/config          → current parsed config.js values
POST /api/config/stage    → stage a config change (writes diff, does not apply)
POST /api/config/apply    → apply staged change + schedule restart
POST /api/command         → write to command queue (PAUSE_ACCOUNT, FORCE_UMPIRE, etc.)
GET  /api/results/:file   → serve a specific results JSON file
POST /api/restart         → PM2 restart bulletbrain-shadow
```

The SSE stream pushes an event every time a new candle closes. The event payload is a JSON object containing the latest umpire state, regime, and any new circuit breaker events since the last push. The client does not poll — it listens.

### Log Parser Design

`logParser.js` maintains an in-memory state object built by tailing the log files. It uses Node's `fs.watch` or a 5-second interval to detect new writes.

The umpire log has a known structure — each 6-hour report is delimited by the `════` separator. The parser extracts the most recent report into a structured object:

```javascript
{
  timestamp: "2026-06-07T12:00:00.000Z",
  regime: "RANGING",
  candleCount: 1248,
  accounts: {
    SNIPER: { capital: 10234, trades: 3, wr: 0.667, pf: 2.15, dd: 0.0045, avgCS: 0.720 },
    SCALPER: { capital: 10112, trades: 4, wr: 0.500, pf: 1.34, dd: 0.0062, avgCS: 0.650 },
    SMART:   { capital: 10389, trades: 6, wr: 0.583, pf: 1.87, dd: 0.0031, avgCS: 0.710 }
  },
  leader: "SNIPER",
  circuitBreaker: { tier1Fires: 0, tier2Fires: 0, tier3Fires: 0 }
}
```

The circuit breaker log is parsed separately — each event is timestamped and includes WOULD_DO action and the triggering metric.

The PM2 stdout log (`~/.pm2/logs/bulletbrain-shadow-out.log`) is tailed for per-candle lines that include close price, regime, and account capital. These feed the live price and equity sparklines.

---

## 5. Frontend Layout

The control center is a single HTML page divided into five panels. On desktop (>768px) these arrange in a 2-column grid. On mobile they stack vertically.

---

### Panel 1 — System Status Bar (always visible, top of page)

A fixed header strip showing the most critical information at a glance:

```
● ONLINE   BTC $106,240   RANGING   Candle 1,892   Last umpire: 2h 14m ago
[SNIPER $10,234 ↑]  [SCALPER $10,112 →]  [SMART $10,389 ↑]
```

The dot is green (ONLINE), yellow (STALE — no new candle in 20+ minutes), or red (OFFLINE — PM2 reports stopped). BTC price comes from the latest candle close line in the PM2 log. Regime is color-coded: green for BULL, orange for RANGING, red for BEAR, red flashing for CRISIS. Account capital shows a small up/down arrow relative to the starting capital tracked since the GUI started.

---

### Panel 2 — Live Regime + Account Performance

Left column, upper section. Shows the current 6-hour umpire report as a structured card per account.

Each account card shows:
- Capital (large number, delta from start in smaller text below)
- Trades count, WR, PF, current DD
- Average Conviction Score with a horizontal bar
- Gate configuration badge (CVD_ZSCORE vs CVD_PLAIN, etc.)

Below the cards, a small equity sparkline chart (Chart.js line chart) shows each account's capital over the last 48 umpire reports (12 days). Three lines, three colors. This is the single most useful chart for shadow period evaluation.

---

### Panel 3 — Regime Timeline

Right column, upper section. A horizontal timeline showing regime periods over the last 7 days, pulled from the per-candle log lines. Color bands:

- BULL → green
- RANGING → yellow
- BEAR → red  
- CRISIS → dark red
- RANGING_ZOMBIE → grey

Below the timeline, two metrics:
- Current regime duration ("In RANGING for 14h 22m")
- Regime drift count for the past 24 hours (number of switches)

This panel gives immediate context for why an account may or may not have traded recently. "0 trades in 2 days" looks very different against a backdrop of 100% RANGING vs a BULL→BEAR transition.

---

### Panel 4 — Gate Activity + Sweep Log

Left column, lower section. The most diagnostic panel — the one you look at when trades aren't firing.

**Gate Block Summary (rolling 24h):**

A horizontal bar chart showing how many sweeps were blocked by each gate reason. Categories pulled from the BB_DEBUG log output:

```
Gate7: CVD_VELOCITY_BELOW_THRESHOLD   ███████████ 34
Gate7: OI_DROP_TOO_SMALL              ██ 7
RVOL below sweepRvolMin               ████ 11
DOL not found                         ██ 5
Regime not allowed                    █ 2
```

**Recent Sweeps Table (last 20 sweeps):**

| Time | Symbol | Pool Level | RVOL | Regime | Gate7 Result | Account |
|------|--------|-----------|------|--------|-------------|---------|
| 11:45 | BTC | $73,321 | 2.14 | RANGING | BLOCKED z<1.0 | SCALPER |
| 09:30 | BTC | $74,100 | 1.87 | BULL | PASS → TRADE | SNIPER |

Rows with PASS are highlighted green. This table is the primary debugging tool during the shadow period — it replaces SSHing into the server and grepping debug logs.

---

### Panel 5 — Circuit Breaker Status

Right column, lower section.

Shows the three circuit breaker tiers as a traffic light grid. Each tier displays:
- Current status (CLEAR / WATCHING / TRIGGERED)
- Trigger threshold vs current value
- Last time it fired (or "Never")
- WOULD_DO action

Below the grid, a timeline of all circuit breaker events in the last 7 days (empty during early shadow period — that's correct and expected).

A prominent note reminds the user: "All tiers LOGGING ONLY. No trade intervention active."

---

### Panel 6 — Operations (collapsible, bottom)

This is the control section. Collapsed by default so it doesn't dominate the view. Expanded by clicking a "⚙ Operations" header.

**Bot Control:**
- [Restart Bot] — triggers PM2 restart with confirmation modal ("This will interrupt live candle processing for ~30 seconds")
- [Force Umpire Report] — writes FORCE_UMPIRE to command queue
- [View Raw Umpire Log] — opens a scrollable pre-formatted log viewer in a modal

**Account Control:**
- Per-account pause toggle for SNIPER, SCALPER, SMART
- Writes PAUSE_ACCOUNT:{name} to command queue
- Paused accounts show a yellow banner on their Panel 2 card

**Config Staging:**
- A table showing key config parameters (the ones most likely to need adjustment based on the shadow period learnings):
  - `cvdVelocityZscoreThreshold` (current: 2.5)
  - `GATES.gate7_range_multiplier` (current: 0.5)
  - `GATES.gate7_range_zscore_floor` (current: 1.0)
  - `scalperRangingZscoreMin` (current: 1.0)
  - `scalperRangingRvolMin` (current: 1.5)
  - `LSO.sweepRvolMin` (current: 1.2)
  - `LSO.cvdVelocityZscoreThreshold` (current: 2.5)
- Each row has an editable input field
- An [Apply Changes] button shows a diff modal before writing anything
- The diff modal requires the user to type "CONFIRM" to proceed
- On confirm: writes a timestamped config snapshot to `config_history/`, applies the change, restarts the bot

**Results Viewer:**
- Dropdown listing all `results/*.json` files
- Renders the selected result as a formatted metrics card (not raw JSON)
- Key metrics: Trades, WR, PF, DD, year-by-year, regime-split

---

## 6. Command Queue Protocol

The shadow runner needs one small addition: at the top of its per-candle processing loop, it checks `commands/pending.json`. If the file exists and is non-empty, it processes commands one at a time and clears the file.

Supported commands:

```javascript
// commands/pending.json format
[
  { "cmd": "PAUSE_ACCOUNT", "account": "SNIPER", "timestamp": "..." },
  { "cmd": "RESUME_ACCOUNT", "account": "SCALPER", "timestamp": "..." },
  { "cmd": "FORCE_UMPIRE", "timestamp": "..." },
  { "cmd": "SET_BB_DEBUG", "value": true, "timestamp": "..." }
]
```

The bot processes this file at candle close (not mid-candle) to avoid race conditions. After processing, it empties the file and writes the result to `commands/processed.json` (the GUI reads this to confirm commands executed).

This requires adding approximately 25 lines to `shadowRunner.js` — a minimal, non-breaking change.

---

## 7. Security Model

The GUI runs on the same server as the bot. Access from outside the server goes through a simple bearer token:

```
Authorization: Bearer <GUI_TOKEN>
```

`GUI_TOKEN` is a 32-character random string stored in `.env`. The Express middleware checks this header on every request except the static HTML/CSS/JS assets (which contain no sensitive data on their own).

For the config apply operation specifically, there is an additional CSRF-style protection: the diff modal requires the user to type a confirmation phrase ("CONFIRM") which is passed back in the request body. The backend verifies this before writing any files.

No exposure of Binance API keys to the GUI at any point. The GUI never calls Binance directly. The only credentials the GUI server needs are `GUI_TOKEN` and the path to the bot directory.

---

## 8. Build Phases

### Phase G0 — Backend Skeleton (1-2 days)

Goal: Express server running, serving static files, SSE endpoint works.

- `server.js` with Express + SSE route
- `logParser.js` that tails `umpire.log` and parses the last report
- `/api/state` returns the parsed umpire state as JSON
- `/api/events` SSE stream that pushes a heartbeat every 30 seconds
- Static `public/index.html` that connects to SSE and logs events to console
- Auth middleware in place
- PM2 process `bulletbrain-gui` registered

Done criteria: SSE connection stays alive, console shows heartbeat events, `/api/state` returns real data from the actual umpire log.

---

### Phase G1 — Status Bar + Account Cards (1-2 days)

Goal: Panel 1 and Panel 2 fully functional and live-updating.

- Parse per-candle lines from PM2 stdout for BTC price, regime, candle count
- System status bar renders with live regime color
- Three account cards rendering latest umpire data
- Equity sparkline (last 20 umpire reports, or whatever exists)
- Mobile layout verified on 390px viewport

Done criteria: Open the page on a phone, see current bot status without touching a terminal.

---

### Phase G2 — Regime Timeline + Gate Log (2-3 days)

Goal: Panel 3 and Panel 4 functional.

- Regime timeline built from PM2 log candle lines (in-memory, last 7 days)
- Regime duration and drift count computed
- Gate block summary bar chart (Chart.js) from BB_DEBUG log
- Recent sweeps table from BB_DEBUG log output
- BB_DEBUG=1 confirmed enabled on the server for this data to exist

Done criteria: Can open the gate log and immediately see why no trades fired in the last 48 hours without reading raw log files.

---

### Phase G3 — Circuit Breaker + Operations (2 days)

Goal: Panel 5 and Panel 6 functional, command queue wired up.

- Circuit breaker status grid from `circuit_breaker.log` parser
- Circuit breaker event timeline
- Operations panel: restart button with confirmation modal
- Account pause/resume via command queue
- Bot-side command queue polling (25-line addition to `shadowRunner.js`)
- Force umpire command verified working

Done criteria: Can pause SCALPER from the browser, see SCALPER card update to show paused state within one candle close (15 minutes).

---

### Phase G4 — Config Manager + Results Viewer (2 days)

Goal: Full config staging workflow and results inspection.

- Config reader parsing `config.js` into a structured object for the key parameters
- Editable config table with diff preview modal
- Config history snapshots in `config_history/`
- Apply + PM2 restart flow
- Results dropdown pulling `results/*.json` filenames
- Results renderer (not raw JSON — structured metrics card)

Done criteria: Can stage, preview, and apply a change to `scalperRangingZscoreMin` without opening a terminal, and verify the bot restarted with the new value from the browser.

---

### Phase G5 — Polish + Mobile Hardening (1 day)

- CSS dark theme (easier to read at night / on a phone)
- All panels tested on iPhone SE (375px) and standard mobile (390px)
- Loading states for all async operations
- Error states when bot is offline or log files are unreadable
- Favicon, page title shows bot status ("● BulletBrain — RANGING")

---

## 9. What This Does NOT Include

These are deliberate exclusions, not oversights.

**No charting of BTC price.** TradingView exists for this. The GUI is about bot state, not market state.

**No backtesting interface.** Backtests run from the command line. Adding a backtest trigger to the GUI would require long-running jobs, progress streaming, and result management that add significant complexity for marginal benefit.

**No multi-symbol support.** The bot currently runs BTCUSDT only. When that changes, the GUI extends.

**No Telegram integration.** The bot already sends Telegram alerts. The GUI is a separate monitoring channel, not a replacement.

**No authentication beyond bearer token.** This is a single-user internal tool. OAuth and user management are out of scope.

**No real-order management.** The GUI cannot place, modify, or cancel Binance orders. Shadow mode only. When the bot eventually goes live with real orders, the operations panel will need a separate security review before adding order management.

---

## 10. File Structure (Final Target)

```
bulletbrain-gui/                 ← sibling directory to bbv-2/ on the server
├── server.js
├── src/
│   ├── logParser.js             ← umpire.log, circuit_breaker.log, PM2 stdout
│   ├── stateReader.js           ← results/*.json, commands/processed.json
│   ├── configManager.js         ← read/diff/stage/apply config.js
│   ├── commandQueue.js          ← write commands/pending.json
│   └── pm2Manager.js            ← pm2.restart(), pm2.describe()
├── public/
│   ├── index.html               ← all six panels
│   ├── style.css                ← dark theme, mobile-first grid
│   └── app.js                   ← SSE client, panel rendering, modals
├── commands/
│   ├── pending.json             ← written by GUI, read by bot
│   └── processed.json           ← written by bot, read by GUI
├── config_history/
│   └── config_YYYYMMDD_HHMMSS.js  ← timestamped snapshots before each change
├── .env                         ← GUI_TOKEN, LOG_PATH, BOT_DIR, PORT
├── package.json
└── README.md
```

**Bot-side change required** (in `bbv-2/src/live/shadowRunner.js`):

```javascript
// Add at top of per-candle processing loop (~25 lines):
async function processCommandQueue() {
  const queuePath = path.join(process.env.COMMAND_QUEUE_PATH || '../bulletbrain-gui/commands/pending.json');
  if (!fs.existsSync(queuePath)) return;
  const commands = JSON.parse(fs.readFileSync(queuePath, 'utf8') || '[]');
  if (!commands.length) return;
  
  for (const cmd of commands) {
    if (cmd.cmd === 'PAUSE_ACCOUNT') pauseAccount(cmd.account);
    if (cmd.cmd === 'RESUME_ACCOUNT') resumeAccount(cmd.account);
    if (cmd.cmd === 'FORCE_UMPIRE') forceUmpireReport();
    if (cmd.cmd === 'SET_BB_DEBUG') process.env.BB_DEBUG = cmd.value ? '1' : '';
  }
  
  fs.writeFileSync(queuePath, '[]');
  // write processed.json with results...
}
```

This is the only required change to the bot itself.

---

## 11. Deployment on Server

```bash
# On ubuntu@54.249.145.15

cd ~
git clone https://github.com/Usman-2302/bb-v2-gui bulletbrain-gui  # or copy files
cd bulletbrain-gui
npm install

# Set environment
cat > .env << EOF
GUI_TOKEN=<generate_32_char_random_string>
LOG_PATH=/home/ubuntu/bulletbrain/logs
BOT_DIR=/home/ubuntu/bulletbrain
COMMAND_QUEUE_PATH=/home/ubuntu/bulletbrain-gui/commands/pending.json
PORT=3000
EOF

# Register with PM2
pm2 start server.js --name bulletbrain-gui
pm2 save

# Access from browser:
# http://54.249.145.15:3000
# With Authorization: Bearer <GUI_TOKEN> header
# Or use nginx reverse proxy with HTTPS for proper remote access
```

For remote access from a phone, the recommended setup is an nginx reverse proxy with a self-signed certificate (or Let's Encrypt if a domain is available). This puts HTTPS in front of the GUI so the bearer token is not sent in plaintext.

---

## 12. Success Criteria

The GUI is complete when you can do all of the following without opening a terminal:

1. See at a glance whether the bot is online and what regime BTC is in
2. Know exactly why no trades have fired in the last 48 hours (gate log)
3. See which of the three accounts is performing best
4. Pause or resume a specific account
5. Stage a config parameter change, review the diff, and apply it
6. Verify the bot restarted with the new config
7. Check circuit breaker status and confirm it has not fired
8. View the canonical backtest result for any strategy in the results/ directory

All of the above must work correctly on a phone at 390px viewport width.

---

*BulletBrain GUI Control Center Plan — June 2026*
*Ready to begin Phase G0 when confirmed.*
