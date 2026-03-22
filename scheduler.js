/**
 * scheduler.js – Monthly cron + vacancy-change trigger
 *
 * Schedule: 1st of every month at 09:00 Doha time (UTC+3)
 * Vacancy monitor: checks every 30 minutes, triggers if vacancies changed
 *
 * Exports:
 *   startScheduler()   – Call from index.js at startup
 *   triggerManually()  – Call from Express endpoint
 */

const cron = require('node-cron');
const { runPosting } = require('./poster');
const { getVacantUnits } = require('./sheets-poster');

let lastVacancySnapshot = null;
let isRunning = false;
let schedulerStarted = false;

// ─────────────────────────────────────────────
// Safe run wrapper (prevents concurrent runs)
// ─────────────────────────────────────────────
async function safeRun(opts = {}) {
  if (isRunning) {
    console.log('[Scheduler] Already running – skipping this trigger');
    return { skipped: true, reason: 'already_running' };
  }

  isRunning = true;
  const start = Date.now();

  try {
    console.log('[Scheduler] ▶ Starting run (triggered by:', opts._trigger || 'manual', ')');
    const result = await runPosting(opts);
    console.log(`[Scheduler] ✓ Run completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return result;
  } catch (e) {
    console.error('[Scheduler] ✗ Run failed:', e.message);
    return { error: e.message };
  } finally {
    isRunning = false;
  }
}

// ─────────────────────────────────────────────
// Vacancy change monitor
// ─────────────────────────────────────────────
async function checkVacancyChanges() {
  try {
    const units = await getVacantUnits();
    const snapshot = JSON.stringify(units.map(u => u.Unit).sort());

    if (lastVacancySnapshot === null) {
      // First check – just store baseline
      lastVacancySnapshot = snapshot;
      console.log(`[Scheduler] Vacancy baseline set: ${units.length} vacant units`);
      return;
    }

    if (snapshot !== lastVacancySnapshot) {
      const prev = JSON.parse(lastVacancySnapshot || '[]');
      const curr = units.map(u => u.Unit);
      const added = curr.filter(u => !prev.includes(u));
      const removed = prev.filter(u => !curr.includes(u));

      console.log('[Scheduler] Vacancy change detected!');
      if (added.length) console.log('  New vacant units:', added.join(', '));
      if (removed.length) console.log('  No longer vacant:', removed.join(', '));

      lastVacancySnapshot = snapshot;

      // Only post for newly vacant units to avoid re-posting existing ones
      if (added.length > 0) {
        for (const unit of added) {
          await safeRun({ limitToUnit: unit, _trigger: 'vacancy_change' });
        }
      }
    }
  } catch (e) {
    console.error('[Scheduler] Vacancy check error:', e.message);
  }
}

// ─────────────────────────────────────────────
// Get next scheduled run date (1st of next month)
// ─────────────────────────────────────────────
function getNextScheduledRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
    now.getUTCMonth() === 11 ? 0 : now.getUTCMonth() + 1,
    1,
    6, 0, 0 // 06:00 UTC = 09:00 Doha
  ));
  return next.toISOString();
}

// ─────────────────────────────────────────────
// Start the scheduler
// ─────────────────────────────────────────────
function startScheduler() {
  if (schedulerStarted) {
    console.log('[Scheduler] Already started');
    return;
  }
  schedulerStarted = true;

  // ── Monthly cron: 1st of every month at 09:00 Doha (UTC+3) ──
  // Doha time = UTC+3 (no DST). 09:00 Doha = 06:00 UTC.
  cron.schedule('0 6 1 * *', async () => {
    console.log('[Scheduler] ⏰ Monthly cron fired: 1st of month, 09:00 Doha');
    await safeRun({ _trigger: 'monthly_cron' });
  }); // node-cron uses server local time; on Railway UTC → need 6am UTC for 9am Doha

  console.log('[Scheduler] ✓ Monthly cron scheduled: every 1st at 09:00 Doha time');
  console.log('[Scheduler] ✓ Next scheduled run:', getNextScheduledRun());

  // ── Vacancy change monitor every 30 minutes ──
  cron.schedule('*/30 * * * *', async () => {
    await checkVacancyChanges();
  });

  // Initial vacancy snapshot (don't post on startup)
  setTimeout(async () => {
    try {
      const units = await getVacantUnits();
      lastVacancySnapshot = JSON.stringify(units.map(u => u.Unit).sort());
      console.log(`[Scheduler] ✓ Vacancy monitor started: ${units.length} vacant units baseline`);
    } catch (e) {
      console.error('[Scheduler] Failed to set vacancy baseline:', e.message);
    }
  }, 5000);

  console.log('[Scheduler] ✓ Vacancy monitor active (checks every 30 min)');
}

// ─────────────────────────────────────────────
// Manual trigger (called from Express endpoint)
// ─────────────────────────────────────────────
function triggerManually(opts = {}) {
  return safeRun({ ...opts, _trigger: 'manual_api' });
}

function getStatus() {
  return {
    isRunning,
    schedulerStarted,
    nextScheduledRun: getNextScheduledRun(),
    vacantUnitsInSnapshot: lastVacancySnapshot
      ? JSON.parse(lastVacancySnapshot).length
      : null,
  };
}

module.exports = { startScheduler, triggerManually, getStatus };
