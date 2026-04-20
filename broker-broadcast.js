/**
 * broker-broadcast.js  –  Monthly WhatsApp broadcast of vacant units to brokers
 *
 * Runs on the 1st of every month (triggered by scheduler.js).
 * Vacant units are extracted from the latest monthly rent-report PDF in Gmail
 * via Claude Vision (see vacancy-from-pdf.js – mirrors the Google Apps Script).
 * Brokers are read from a separate Google Sheet (BROKERS_SHEET_ID).
 * Messages are sent via an approved Twilio Content Template; the template
 * carries the static intro / contact / footer text and {{1}} carries the
 * dynamic list of vacant units for that month.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY           – Claude API key (for PDF vision analysis)
 *   TWILIO_ACCOUNT_SID          – Twilio account SID (production WhatsApp sender)
 *   TWILIO_AUTH_TOKEN           – Twilio auth token
 *   TWILIO_WHATSAPP_NUMBER      – e.g. whatsapp:+15559313545
 *   TWILIO_TEMPLATE_SID         – Content SID (HXxxxx…) of approved template
 *                                 Template must expect one variable {{1}} = unit list text
 *   BROKERS_SHEET_ID            – Google Sheet ID holding the Brokers tab
 *   GMAIL_OTP_USER              – Gmail address that receives the rent report
 *   Gmail auth (either):
 *     • GOOGLE_SERVICE_ACCOUNT_JSON + domain-wide delegation, OR
 *     • GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN
 *
 * Brokers sheet structure (tab name "Brokers", headers in row 1):
 *   A Phone        (e.g. +97455513389 or 97455513389)
 *   B Name         (optional)
 *   C Status       (Active / Disabled – only Active are messaged)
 *   D LastSent     (ISO date of last successful send)
 *   E LastError    (auto-filled)
 *
 * Exports:
 *   broadcastToBrokers(opts)  – main entry; opts = { testOnly, limitToPhone, dryRun, debug }
 */

const twilio = require('twilio');
const { getSheetsClient } = require('./sheets-poster');
const { getVacantUnitsFromPdf } = require('./vacancy-from-pdf');

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const BROKERS_SHEET_ID = process.env.BROKERS_SHEET_ID || '';
const BROKERS_TAB = 'Brokers';
const LOG_TAB = 'Broker_Log';

const DAILY_LIMIT = Number(process.env.BROADCAST_DAILY_LIMIT) || 300;
const BATCH_SIZE = Number(process.env.BROADCAST_BATCH_SIZE) || 50;
const SEND_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS) || 1000; // 1 msg/sec

// Contact numbers shown in the message footer (unchanged from email template)
const CONTACTS = {
  zaidan: '3129 3905',
  nizar: '7785 1855',
  ahmed: '+974 5551 3389',
  bot: '+974 7029 7066',
};

// ─────────────────────────────────────────────
// Phone normalisation (E.164 for Qatar default)
// ─────────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[\s\-()]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    // Qatari numbers are 8 digits; prepend +974 if missing
    if (/^\d{8}$/.test(p)) p = '+974' + p;
    else if (/^974\d{8}$/.test(p)) p = '+' + p;
    else p = '+' + p;
  }
  // Basic validity: + followed by 8–15 digits
  if (!/^\+\d{8,15}$/.test(p)) return null;
  return p;
}

// ─────────────────────────────────────────────
// Twilio client
// ─────────────────────────────────────────────
let _twilioClient = null;
function getTwilio() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

// ─────────────────────────────────────────────
// Brokers sheet access
// ─────────────────────────────────────────────
async function readBrokers() {
  if (!BROKERS_SHEET_ID) throw new Error('BROKERS_SHEET_ID env var is required');
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: BROKERS_SHEET_ID,
    range: `${BROKERS_TAB}!A1:E2000`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || '').trim());
  const idx = {
    phone: headers.findIndex(h => /phone/i.test(h)),
    name: headers.findIndex(h => /name/i.test(h)),
    status: headers.findIndex(h => /status/i.test(h)),
    lastSent: headers.findIndex(h => /lastsent|last sent/i.test(h)),
  };
  if (idx.phone === -1) throw new Error('Brokers sheet is missing a Phone column');

  const brokers = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const phone = normalisePhone(row[idx.phone]);
    if (!phone) continue;
    const status = idx.status >= 0 ? String(row[idx.status] || '').trim().toLowerCase() : 'active';
    if (status && status !== 'active' && status !== '') continue; // skip Disabled etc.
    brokers.push({
      rowNumber: r + 1, // 1-based sheet row
      phone,
      name: idx.name >= 0 ? (row[idx.name] || '') : '',
      lastSent: idx.lastSent >= 0 ? (row[idx.lastSent] || '') : '',
    });
  }
  return brokers;
}

async function markBrokerSent(rowNumber, { success, error }) {
  const sheets = await getSheetsClient();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.update({
    spreadsheetId: BROKERS_SHEET_ID,
    range: `${BROKERS_TAB}!D${rowNumber}:E${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[success ? timestamp : '', success ? '' : String(error || '').substring(0, 400)]],
    },
  });
}

async function ensureBrokerLogTab() {
  const sheets = await getSheetsClient();
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: BROKERS_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: BROKERS_SHEET_ID,
      range: `${LOG_TAB}!A1:F1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['Timestamp', 'Phone', 'Name', 'Status', 'MessageSid', 'Error']],
      },
    });
  } catch (e) {
    if (!/already exists|duplicate/i.test(e.message || '')) {
      console.warn('[BrokerBroadcast] ensureBrokerLogTab warning:', e.message);
    }
  }
}

async function logBrokerResult({ phone, name, status, messageSid = '', error = '' }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: BROKERS_SHEET_ID,
    range: `${LOG_TAB}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toISOString(),
        phone,
        name || '',
        status,
        messageSid,
        String(error || '').substring(0, 500),
      ]],
    },
  });
}

// ─────────────────────────────────────────────
// Message body
// ─────────────────────────────────────────────
// Two helpers:
//   buildUnitList(units)       → goes into Twilio template variable {{1}}
//   buildFullPreview(units)    → the full rendered message (for dryRun / logs)
// The static parts of the message (intro, contacts, footer) live inside
// the APPROVED Twilio Content Template, not in code.
// See TWILIO_TEMPLATE.md for the exact template body to submit to Meta.

function buildUnitList(units) {
  if (!units || !units.length) return 'No vacant units currently.';

  const lines = [];
  units.forEach((u, i) => {
    const unit = u.unit || u.Unit || '';
    const propAr = u.property || u.Property_Name || '';
    const propEn = u.propertyEn || u.Property_Name_EN || '';
    const rent = u.monthlyRent || u.Monthly_Rent || u.Rent || '';

    lines.push(`#${i + 1}`);
    lines.push(`Unit | الوحدة: ${unit}`);
    const propParts = [propAr, propEn].filter(Boolean).join(' | ');
    if (propParts) lines.push(`Property | العقار: ${propParts}`);
    if (rent) lines.push(`Rent: ${rent}`);
    lines.push('');
  });
  // Drop trailing blank line
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function buildFullPreview(units) {
  const unitList = buildUnitList(units);
  return (
    '*Properties for rent | عقارات للايجار*\n' +
    '\n' +
    'السلام عليكم،\n' +
    'تتوفر لدينا الوحدات التالية للإيجار:\n' +
    '\n' +
    'Dear Sir/Madam,\n' +
    'The following units are available for rent:\n' +
    '\n' +
    unitList +
    '\n\n' +
    '*Contact | للتواصل:*\n' +
    `Mohamed Zaidan: ${CONTACTS.zaidan}\n` +
    `Nizar: ${CONTACTS.nizar}\n` +
    `Ahmed: ${CONTACTS.ahmed}\n` +
    '\n' +
    '📱 *بوت واتساب متاح ٢٤/٧ | WhatsApp Bot Available 24/7*\n' +
    'للاستفسار الفوري عن العقارات، تحدث مع مساعدنا الذكي على واتساب\n' +
    'For instant property inquiries, chat with our AI assistant on WhatsApp\n' +
    `${CONTACTS.bot}\n` +
    'أرسل لنا رسالة في أي وقت — نرد بالعربية والإنجليزية فوراً ✓\n' +
    'Send us a message anytime — we reply in Arabic & English instantly ✓'
  );
}

// Backwards-compat alias used previously by any caller.
function buildBilingualMessage(units) { return buildFullPreview(units); }

// ─────────────────────────────────────────────
// Send via Twilio Content Template
// ─────────────────────────────────────────────
// The approved Twilio template body contains {{1}} where the unit list goes.
// We pass the unit list (not the full message) as the variable value,
// because the static header/footer live inside the approved template.
async function sendTemplateMessage({ toPhone, unitListText, fullFallbackText }) {
  const client = getTwilio();
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  const templateSid = process.env.TWILIO_TEMPLATE_SID;
  if (!from) throw new Error('Missing TWILIO_WHATSAPP_NUMBER');

  const to = `whatsapp:${toPhone}`;

  // Preferred path: approved Content Template ({{1}} = unit list)
  if (templateSid) {
    return client.messages.create({
      from,
      to,
      contentSid: templateSid,
      contentVariables: JSON.stringify({ 1: unitListText }),
    });
  }

  // Fallback: plain WhatsApp message (only works inside 24-hr session
  // or when sender/receiver already have an open session — e.g. Twilio Sandbox)
  return client.messages.create({ from, to, body: fullFallbackText });
}

// ─────────────────────────────────────────────
// Dedupe helper – already sent this month?
// ─────────────────────────────────────────────
function alreadySentThisMonth(lastSentIso) {
  if (!lastSentIso) return false;
  const d = new Date(lastSentIso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

// ─────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────
/**
 * @param {Object} [opts]
 * @param {boolean} [opts.testOnly]       – send to first broker only
 * @param {string}  [opts.limitToPhone]   – send to a single phone only (E.164 or 8-digit QA)
 * @param {boolean} [opts.dryRun]         – build message, don't call Twilio
 */
async function broadcastToBrokers(opts = {}) {
  const summary = {
    timestamp: new Date().toISOString(),
    totalBrokers: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun: !!opts.dryRun,
  };

  console.log('\n═══════════════════════════════════════');
  console.log('[BrokerBroadcast] ▶ Starting run:', summary.timestamp);
  console.log('[BrokerBroadcast] Options:', JSON.stringify(opts));
  console.log('═══════════════════════════════════════\n');

  // 1. Vacant units — sourced from the monthly rent-report PDF (Gmail → Claude Vision)
  const units = await getVacantUnitsFromPdf({ debug: !!opts.debug });
  console.log(`[BrokerBroadcast] Vacant units found: ${units.length}`);
  if (units.length === 0) {
    console.log('[BrokerBroadcast] Nothing to broadcast. Exiting.');
    return summary;
  }

  // 2. Brokers
  let brokers = await readBrokers();
  summary.totalBrokers = brokers.length;
  console.log(`[BrokerBroadcast] Active brokers in sheet: ${brokers.length}`);

  if (opts.limitToPhone) {
    const target = normalisePhone(opts.limitToPhone);
    brokers = brokers.filter(b => b.phone === target);
    console.log(`[BrokerBroadcast] Filtered to ${target}: ${brokers.length} broker(s)`);
  }
  if (opts.testOnly) {
    brokers = brokers.slice(0, 1);
    console.log('[BrokerBroadcast] TEST MODE: first broker only');
  }

  if (brokers.length === 0) {
    console.log('[BrokerBroadcast] No brokers to contact.');
    return summary;
  }

  // 3. Ensure log tab exists before logging
  await ensureBrokerLogTab();

  // 4. Build message bodies once
  const unitListText = buildUnitList(units);
  const fullPreview = buildFullPreview(units);
  console.log(`[BrokerBroadcast] Unit list chars: ${unitListText.length}, preview chars: ${fullPreview.length}`);

  if (opts.dryRun) {
    console.log('──── DRY RUN – TEMPLATE VARIABLE {{1}} ────');
    console.log(unitListText);
    console.log('──── DRY RUN – FULL RENDERED PREVIEW ────');
    console.log(fullPreview);
    console.log('──── END PREVIEW ────');
    return { ...summary, unitListText, fullPreview };
  }

  // 5. Iterate brokers, respect rate limits & monthly dedupe
  let sentCount = 0;
  for (let i = 0; i < brokers.length && sentCount < DAILY_LIMIT; i++) {
    const broker = brokers[i];

    if (alreadySentThisMonth(broker.lastSent)) {
      summary.skipped++;
      console.log(`[BrokerBroadcast] Skip ${broker.phone} — already sent this month`);
      continue;
    }

    try {
      const resp = await sendTemplateMessage({
        toPhone: broker.phone,
        unitListText,
        fullFallbackText: fullPreview,
      });
      sentCount++;
      summary.sent++;
      await markBrokerSent(broker.rowNumber, { success: true });
      await logBrokerResult({
        phone: broker.phone,
        name: broker.name,
        status: 'Sent',
        messageSid: resp.sid || '',
      });
      console.log(`[BrokerBroadcast] ✓ ${broker.phone} (${resp.sid})`);
    } catch (e) {
      summary.failed++;
      summary.errors.push({ phone: broker.phone, error: e.message });
      await markBrokerSent(broker.rowNumber, { success: false, error: e.message });
      await logBrokerResult({
        phone: broker.phone,
        name: broker.name,
        status: 'Failed',
        error: e.message,
      });
      console.error(`[BrokerBroadcast] ✗ ${broker.phone}: ${e.message}`);
      // If Twilio flags quota/credential issues, stop early
      if (/authenticate|quota|exceeded|rate limit|21408|20003/i.test(e.message)) {
        console.error('[BrokerBroadcast] Halting run due to platform error.');
        break;
      }
    }

    // Throttle between sends
    if (i < brokers.length - 1) {
      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    }

    // Breather every BATCH_SIZE
    if ((i + 1) % BATCH_SIZE === 0) {
      console.log(`[BrokerBroadcast] Batch pause after ${i + 1} brokers (${sentCount} sent)`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('[BrokerBroadcast] Run complete.');
  console.log(`  Total brokers:   ${summary.totalBrokers}`);
  console.log(`  Sent:            ${summary.sent}`);
  console.log(`  Skipped (dedup): ${summary.skipped}`);
  console.log(`  Failed:          ${summary.failed}`);
  console.log('═══════════════════════════════════════\n');

  return summary;
}

module.exports = {
  broadcastToBrokers,
  buildBilingualMessage, // legacy alias -> full preview
  buildUnitList,
  buildFullPreview,
  normalisePhone,
};

