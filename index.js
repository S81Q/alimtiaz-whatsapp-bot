require('dotenv').config();
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Ad poster modules
const { startScheduler, triggerManually, getStatus } = require('./scheduler');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CATCH-ALL: Log every incoming request
let lastRequest = null;
app.use((req, res, next) => {
  if (req.method === 'POST') {
    lastRequest = { 
      path: req.path, 
      method: req.method, 
      bodyKeys: Object.keys(req.body || {}),
      bodySnippet: JSON.stringify(req.body || {}).substring(0, 200),
      time: new Date().toISOString() 
    };
  }
  next();
});
app.get('/last-request', (req, res) => res.json({ lastRequest: lastRequest || 'none' }));

// Error logging
const logError = (error) => {
  const msg = `[${new Date().toISOString()}] ${error.stack || error}\n`;
  fs.appendFileSync(path.join(__dirname, 'errors.log'), msg);
  console.error(msg);
};

// --- Google Sheets Setup ---
let sheetsClient;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1IQzdhv7FcD6XQnJJ61uWUvO_tMoaRquH5GOs7bXwTyQ';
const CONFIG_SHEET_ID = '1YrwEyeegt-AbxmpJSizTzl_a0Oedg6ooVuZw6Z47XLQ';

// Config cache loaded from Config sheet
let configCache = {};
async function loadConfig() {
  try {
    const sheets = await getGoogleSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG_SHEET_ID,
      range: 'Config!A:B',
    });
    (res.data.values || []).slice(1).forEach(row => {
      if (row[0] && row[1]) configCache[row[0]] = row[1];
    });
    console.log('[Config] Loaded', Object.keys(configCache).length, 'keys from Config sheet');
  } catch (e) {
    console.error('[Config] Failed to load config sheet:', e.message);
  }
}
function getConfig(key) {
  return process.env[key] || configCache[key] || '';
}

async function getGoogleSheets() {
  if (sheetsClient) return sheetsClient;

  let credentials;
  const saPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)) {
    credentials = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    throw new Error('No Google service account credentials found');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// --- Vacancy refresh: SOURCE OF TRUTH is the manual Properties sheet (status === متاح) ---
// The Gmail rent-report auto-detector is intentionally NOT used as the source of truth:
// its heuristic over-listed every unit and ignored مؤجر markings. It must never override
// the human Available column. (getVacantUnitsFromGmail is kept only for optional, manual,
// human-reviewed proposals — it is no longer wired into the live vacancy answer.)
async function syncVacancy() {
  console.log('[VacancySync] Refreshing cache from Properties sheet (متاح only)...');
  try {
    const units = await getVacantProperties();
    cachedVacantUnits = units;            // mirror the متاح-only truth for fast fallback
    persistentVacancyPrompt = '';         // never force-feed a unit list to Claude
    console.log('[VacancySync] Cached ' + units.length + ' متاح units from Properties sheet');
    return { vacant: units.length, total: units.length, source: 'properties-sheet' };
  } catch (e) {
    console.error('[VacancySync] Properties read failed:', e.message);
    return { vacant: cachedVacantUnits.length, total: cachedVacantUnits.length, source: 'cache', error: e.message };
  }
}

async function getVacantUnitsFromGmail() {
  if (!process.env.GMAIL_OAUTH_CLIENT_ID || !process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('No Gmail OAuth credentials');
  }

  // Step 1: Get a fresh access token using the refresh token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
  }
  const accessToken = tokenData.access_token;
  console.log('[VacancySync] Got fresh access token OK');

  // Step 2: Search for rent report emails from alamtyaz
  let msgId = null;
  try {
    const searchRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' +
      encodeURIComponent('from:alamtyaz.wa.aljawada@gmail.com has:attachment newer_than:90d') +
      '&maxResults=20',
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    const searchData = await searchRes.json();
    const messages = searchData.messages || [];
    console.log('[VacancySync] Found ' + messages.length + ' emails from alamtyaz');

    const RENT_KEYWORDS = ['\u0627\u064a\u062c\u0627\u0631', '\u0645\u062d\u0635\u0644', 'rent', 'collected'];
    const EXCLUDE = ['\u0645\u0635\u0627\u0631\u064a\u0641', '\u0641\u0627\u062a\u0648\u0631', 'expense', 'invoice'];

    for (const msg of messages) {
      const mRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msg.id + '?format=metadata&metadataHeaders=Subject',
        { headers: { 'Authorization': 'Bearer ' + accessToken } }
      );
      const mData = await mRes.json();
      const headers = (mData.payload || {}).headers || [];
      const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const hasRent = RENT_KEYWORDS.some(k => subject.includes(k));
      const excluded = EXCLUDE.some(k => subject.includes(k));
      if (hasRent && !excluded) {
        msgId = msg.id;
        console.log('[VacancySync] Selected: ' + subject + ' (' + msgId + ')');
        break;
      }
    }
  } catch (searchErr) {
    console.error('[VacancySync] Search failed:', searchErr.message);
  }

  // Fallback to known March 2026 rent report
  if (!msgId) {
    msgId = '19d483adbc78edbb';
    console.log('[VacancySync] Using fallback message ID: ' + msgId);
  }

  // Step 3: Get message and find PDF attachment
  const fullRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgId + '?format=full',
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const fullData = await fullRes.json();
  const parts = (fullData.payload || {}).parts || [];

  const pdfPart = parts.find(p =>
    p.filename && p.filename.toLowerCase().includes('.pdf') &&
    !p.filename.includes('\u0627\u064a\u0635\u0627\u0644') &&
    !p.filename.includes('\u0635\u0648\u0631') &&
    !p.filename.includes('\u0645\u0635\u0627\u0631\u064a\u0641')
  );

  if (!pdfPart || !pdfPart.body || !pdfPart.body.attachmentId) {
    // Try inline data
    const inlinePdf = parts.find(p => p.filename && p.filename.toLowerCase().includes('.pdf'));
    if (!inlinePdf) throw new Error('No PDF found in email ' + msgId + '. Parts: ' + parts.map(p => p.filename).join(', '));
    console.log('[VacancySync] Found PDF (any): ' + inlinePdf.filename);
    throw new Error('PDF found but no attachmentId: ' + inlinePdf.filename);
  }

  console.log('[VacancySync] Found PDF: ' + pdfPart.filename);

  // Step 4: Download the attachment
  const attRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgId + '/attachments/' + pdfPart.body.attachmentId,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const attData = await attRes.json();
  const pdfBase64 = attData.data.replace(/-/g, '+').replace(/_/g, '/');
  console.log('[VacancySync] Downloaded PDF (' + pdfBase64.length + ' base64 chars)');

  // Step 5: Send to Claude AI for vacancy analysis
  console.log('[VacancySync] Sending PDF to Claude for analysis...');
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Analyze this Arabic rent report PDF. Find ALL vacant/available units.\n\nVACANT if: remark says \u0634\u0627\u063a\u0631/\u0634\u0627\u063a\u0631\u0629/vacant/empty, or \u062a\u0645 \u0625\u0631\u062c\u0627\u0639 (returned), or received < 50% of rent with rooms unrented, or \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 empty + zero received + no bounced check.\n\nEXCLUDE: \u0634\u064a\u0643 \u0645\u0631\u062a\u062c\u0639 or \u0645\u0631\u062a\u062c\u0639 or \u0625\u062c\u0631\u0627\u0621\u0627\u062a \u0642\u0636\u0627\u0626\u064a\u0629 (bounced check), or \u0639\u0642\u062f \u062c\u062f\u064a\u062f, or full rent received + no vacancy words.\n\nReturn ONLY JSON array:\n[{"unit":"P49","property":"\u063a\u0631\u0641\u0629 \u0627\u0644\u0633\u062f","monthlyRent":"1100","status":"\u0634\u0627\u063a\u0631\u0629"}]\nIf none: []\nJSON only.' }
      ]
    }]
  });

  const responseText = response.content[0].text;
  console.log('[VacancySync] Claude response:', responseText.substring(0, 200));
  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
  const units = JSON.parse(jsonMatch[0]);
  console.log('[VacancySync] Found ' + units.length + ' vacant units');
  return units;
}


async function writeVacancyToSheet(vacantUnits) {
  const sheets = await getGoogleSheets();
  const now = new Date().toISOString();
  try { await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: 'Vacancy' } } }] } }); } catch (e) {}
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Vacancy!A:E' });
  const rows = [
    ['Unit', 'Status', 'Property_Name', 'Available_From', 'Updated_At'],
    ...vacantUnits.map(u => [u.unit || '', 'Vacant', u.property || '', now, now])
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: 'Vacancy!A1:E' + rows.length,
    valueInputOption: 'USER_ENTERED', requestBody: { values: rows },
  });
}

async function syncVacancyFromSheet() {
  const sheets = await getGoogleSheets();
  const propRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:Z1000' });
  const propRows = propRes.data.values || [];
  if (propRows.length < 2) return { vacant: 0, total: 0, source: 'sheet' };
  const headers = propRows[0];
  const unitIdx = headers.indexOf('Unit');
  const statusIdx = headers.indexOf('Status');
  const now = new Date().toISOString();
  const vacancyData = [
    ['Unit', 'Status', 'Property_Name', 'Available_From', 'Updated_At'],
    ...propRows.slice(1).map(row => {
      const unit = row[unitIdx] || '';
      const propStatus = (row[statusIdx] || '').trim().toLowerCase();
      const isVacant = !propStatus || propStatus === 'available' || propStatus === 'vacant';
      return [unit, isVacant ? 'Vacant' : 'Occupied', '', isVacant ? now : '', now];
    }),
  ];
  try { await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: 'Vacancy' } } }] } }); } catch (e) {}
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Vacancy!A:E' });
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Vacancy!A1:E' + vacancyData.length, valueInputOption: 'USER_ENTERED', requestBody: { values: vacancyData } });
  const vacantCount = vacancyData.slice(1).filter(r => r[1] === 'Vacant').length;
  return { vacant: vacantCount, total: vacancyData.length - 1, source: 'sheet' };
}
// --- Property Retrieval (filtered by vacancy) ---
// Owner/landlord columns that must NEVER reach a customer or Claude.
const OWNER_COL_RE = /owner|landlord|proprietor|مالك|المالك|الملاك|ملاك|صاحب|اسم.?المالك/i;
function _norm(v) { return (v == null ? '' : String(v)).trim(); }
// Vacancy ground truth = the Properties Status column. The live sheet marks units
// "Available" (English); Arabic متاح/متاحة is also honored. A unit is shown ONLY if its
// status is explicitly an available-marker. Anything that means rented/occupied is excluded.
function isAvailableStatus(v) { const s = _norm(v); return s === 'متاح' || s === 'متاحة' || /^available$/i.test(s); }
function isRentedStatus(v) {
  const s = _norm(v);
  return s.indexOf('مؤجر') === 0 || /^(rented|occupied|leased|let|not\s*available|unavailable|مشغول)$/i.test(s);
}

// SOURCE OF TRUTH for vacancy = the manual Properties sheet's status column === متاح.
// Owner/landlord columns are stripped before returning. The Gmail auto-detector is
// NOT consulted here and never overrides a مؤجر marking.
async function getVacantProperties() {
  const sheets = await getGoogleSheets();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:Z1000' });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const headers = (rows[0] || []).map(h => _norm(h));
  const dataRows = rows.slice(1).filter(r => r && r.some(c => _norm(c) !== ''));

  // Auto-detect the status column = the column carrying the most متاح/مؤجر values
  // (robust to whatever the header is named).
  let statusIdx = -1, best = 0;
  for (let c = 0; c < headers.length; c++) {
    let cnt = 0;
    for (const r of dataRows) { if (isAvailableStatus(r[c]) || isRentedStatus(r[c])) cnt++; }
    if (cnt > best) { best = cnt; statusIdx = c; }
  }

  const unitIdx = headers.findIndex(h => /^unit$|^الوحدة$|^رقم/i.test(h));
  const ownerIdxs = headers.map((h, i) => OWNER_COL_RE.test(h) ? i : -1).filter(i => i >= 0);

  const out = [];
  if (statusIdx < 0) return out; // no recognizable status column → list nothing
  for (const r of dataRows) {
    if (!isAvailableStatus(r[statusIdx])) continue; // ONLY متاح
    const obj = {};
    headers.forEach((h, i) => {
      if (!h || i === statusIdx) return;
      if (ownerIdxs.includes(i)) return;            // STRIP owner/landlord columns
      obj[h] = _norm(r[i]);
    });
    obj.Unit = (unitIdx >= 0 ? _norm(r[unitIdx]) : '') || obj.Unit || '';
    obj.Status = 'Vacant';
    out.push(obj);
  }
  return out;
}

async function logLead({ phone, name, language, question, interestedUnit, status }) {
  const sheets = await getGoogleSheets();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Leads!A:G',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[timestamp, phone, name || '', language || '', question || '', interestedUnit || '', status || 'New']],
    },
  });
}

// --- Claude AI Setup ---
const anthropic = new Anthropic();

// ============================================================================
// PROVIDER ABSTRACTION + DELIVERY OBSERVABILITY
// Same business logic (vacancy lookup, lead capture, Claude replies) serves
// BOTH providers (Twilio TwiML + Meta Cloud API) behind PROVIDER env.
// ============================================================================
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const SANDBOX_NUMBER = 'whatsapp:+14155238886';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const DEFAULT_VERIFY_TOKEN = 'alimtiaz_verify_2026';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'sultanaliqatar81@gmail.com';
const ARABIC_FALLBACK = 'عذراً، حدث خطأ مؤقت في النظام. حاول مرة أخرى بعد قليل.';

// Runtime observability state (surfaced on /health + /selftest)
const botState = {
  startedAt: new Date().toISOString(),
  lastInboundAt: null,
  lastInbound: null,                              // {provider, phone, msg, at}
  lastOutboundDelivery: null,                     // {provider, messageId, status, at, error}
  lastSuccess: { rule: null, claude: null },      // last successful reply per path
  lastClaudeError: null,                          // {kind, status, message, at}
  lastAlert: null,                                // {key, message, at}
};

// Delivery ledger: messageId -> { direction, provider, status, inboundAt, replyAt, errorCode, ... }
const deliveryLedger = new Map();
const LEDGER_MAX = 500;
function ledgerPut(id, rec) {
  if (!id) return;
  const prev = deliveryLedger.get(id) || {};
  deliveryLedger.set(id, { ...prev, ...rec, updatedAt: new Date().toISOString() });
  if (deliveryLedger.size > LEDGER_MAX) deliveryLedger.delete(deliveryLedger.keys().next().value);
}
function ledgerGet(id) { return deliveryLedger.get(id) || null; }

// Inbound de-duplication (Meta retries deliver the same message id repeatedly)
const processedInbound = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedInbound.has(id)) return true;
  processedInbound.add(id);
  if (processedInbound.size > 2000) processedInbound.delete(processedInbound.values().next().value);
  return false;
}

function activeProvider() {
  const p = (process.env.PROVIDER || '').toLowerCase();
  return (p === 'meta' || p === 'twilio') ? p : 'twilio';
}
function runMode() {
  if (activeProvider() === 'meta') return 'production';
  const twNum = getConfig('TWILIO_WHATSAPP_NUMBER') || '';
  return (twNum === SANDBOX_NUMBER || twNum.includes('14155238886')) ? 'sandbox' : 'production';
}

// Classify an Anthropic/Sheet error into a DISTINCT kind so failures never
// collapse into one opaque message. auth / quota / model / timeout / sheet.
function classifyError(err) {
  const status = err && (err.status || err.statusCode || (err.response && err.response.status));
  const msg = (err && err.message) || String(err);
  let kind = 'unknown';
  if (status === 401 || /authentication_error|invalid x-api-key|401/i.test(msg)) kind = 'auth';
  else if (status === 403 || /permission_error|permission denied/i.test(msg)) kind = 'permission';
  else if (status === 402 || status === 429 || /rate_limit|quota|credit balance|billing|insufficient/i.test(msg)) kind = 'quota';
  else if (status === 404 || /not_found_error|model:/i.test(msg)) kind = 'model';
  else if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|aborted/i.test(msg)) kind = 'timeout';
  else if (/sheet|spreadsheet|googleapis|service account/i.test(msg)) kind = 'sheet';
  return { kind, status: status || null, message: String(msg).substring(0, 300) };
}

// ---- Rule path (vacancy keyword) ----
const VAC_KEYWORDS = ['فاضية','فاضيه','شاغرة','شاغره','متاحة','متاحه','vacant','available','empty','فاضي','شاغر'];
function isVacancyQuery(text) {
  const t = (text || '').toLowerCase();
  return VAC_KEYWORDS.some(k => t.includes(k));
}
// Shown when zero units are marked متاح — reflect reality, never a hardcoded list.
const NO_VACANCY_REPLY = 'لا توجد وحدات متاحة للإيجار في الوقت الحالي. 🙏\n\nيسعدنا تسجيل طلبك والتواصل معك فور توفر وحدة مناسبة.\n\nللاستفسار:\n👤 محمد زيدان: 31293905\n👤 نزار: 77851855\n👤 أحمد: 55513389';
function buildVacancyReply(units) {
  const lines = units.map((u, i) => {
    u = u || {};
    const id = u.unit || u.Unit || '?';
    const nm = u.property || u.Property_Name || u.propertyName || u.Location || u.Type || '';
    const rt = (u.monthlyRent || u.Rent_QAR) ? ' - ' + (u.monthlyRent || u.Rent_QAR) + ' ريال/شهر' : '';
    return nm ? (i + 1) + '. ' + id + ' - ' + nm + rt : (i + 1) + '. ' + id + rt;
  });
  return 'الوحدات الشاغرة حالياً (' + units.length + ' وحدة):\n\n' + lines.join('\n') +
    '\n\nللاستفسار والحجز:\n👤 محمد زيدان: 31293905\n👤 نزار: 77851855\n👤 أحمد: 55513389';
}

// SHARED business logic for BOTH providers. Returns { reply, path, errorKind? }.
async function generateReply(incomingMsg, phone) {
  // Rule path: vacancy keyword → list of vacant units (no Claude needed)
  if (isVacancyQuery(incomingMsg)) {
    // Source of truth = Properties sheet (متاح only). Cache is only an error fallback.
    let units = [];
    try { units = await getVacantProperties(); } catch (e) { units = cachedVacantUnits || []; }
    botState.lastSuccess.rule = new Date().toISOString();
    return { reply: units.length > 0 ? buildVacancyReply(units) : NO_VACANCY_REPLY, path: 'rule' };
  }
  // Claude path: conversational
  try {
    delete conversations[phone];
    let properties = [];
    try { properties = await getVacantProperties(); } catch (e) { properties = cachedVacantUnits || []; }
    const claudeResponse = await askClaude(phone, incomingMsg, properties);
    let parsed;
    try {
      const m = claudeResponse.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { reply: claudeResponse };
    } catch { parsed = { reply: claudeResponse }; }
    const reply = parsed.reply || claudeResponse;
    botState.lastSuccess.claude = new Date().toISOString();
    botState.lastClaudeError = null;
    try {
      const isArabic = /[؀-ۿ]/.test(incomingMsg);
      await logLead({ phone, name: parsed.collected_name || '', language: isArabic ? 'Arabic' : 'English',
        question: incomingMsg, interestedUnit: parsed.interested_unit || '',
        status: parsed.interested_unit ? 'Interested' : 'New' });
    } catch (e) {}
    return { reply, path: 'claude' };
  } catch (err) {
    const c = classifyError(err);
    botState.lastClaudeError = { ...c, at: new Date().toISOString() };
    logError(new Error('[generateReply][' + c.kind + '][status=' + c.status + '] ' + c.message));
    console.error('[generateReply] FAILED kind=' + c.kind + ' status=' + c.status + ' :: ' + c.message);
    return { reply: getConfig('FALLBACK_MESSAGE') || ARABIC_FALLBACK, path: 'claude', errorKind: c.kind };
  }
}

function recordInbound(provider, phone, msg) {
  const at = new Date().toISOString();
  botState.lastInboundAt = at;
  botState.lastInbound = { provider, phone, msg: (msg || '').substring(0, 80), at };
  try { fs.appendFileSync('/tmp/webhook.log', at + ' | ' + provider.toUpperCase() + ' | FROM:' + phone + ' | MSG:' + (msg || '').substring(0, 50) + '\n'); } catch (e) {}
  return at;
}

// ---- Meta Cloud API: outbound send + inbound/status handling ----
async function sendMeta(phone, text, phoneNumberId) {
  const token = getConfig('META_ACCESS_TOKEN');
  const pid = getConfig('META_PHONE_NUMBER_ID') || phoneNumberId;
  if (!token || !pid) { console.error('[Meta] missing META_ACCESS_TOKEN/PHONE_NUMBER_ID'); return { ok: false, reason: 'no-credentials' }; }
  try {
    const r = await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/' + pid + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } }),
    });
    const data = await r.json().catch(() => ({}));
    const outboundId = data && data.messages && data.messages[0] && data.messages[0].id;
    if (!r.ok) {
      const reason = JSON.stringify(data).substring(0, 300);
      botState.lastOutboundDelivery = { provider: 'meta', status: 'failed', at: new Date().toISOString(), error: reason };
      console.error('[Meta] send failed status=' + r.status + ' ' + reason);
      return { ok: false, status: r.status, reason };
    }
    botState.lastOutboundDelivery = { provider: 'meta', messageId: outboundId, status: 'sent', at: new Date().toISOString() };
    if (outboundId) ledgerPut(outboundId, { direction: 'outbound', provider: 'meta', to: phone, status: 'sent' });
    return { ok: true, outboundId };
  } catch (e) {
    botState.lastOutboundDelivery = { provider: 'meta', status: 'error', at: new Date().toISOString(), error: e.message };
    return { ok: false, reason: e.message };
  }
}

function recordMetaStatus(st) {
  // st: { id, status: sent|delivered|read|failed, timestamp, recipient_id, errors:[{code,title}] }
  const rec = { direction: 'outbound', provider: 'meta', status: st.status, to: st.recipient_id,
    statusAt: new Date(((parseInt(st.timestamp, 10) || (Date.now() / 1000))) * 1000).toISOString() };
  if (st.errors && st.errors[0]) { rec.errorCode = st.errors[0].code; rec.errorReason = st.errors[0].title || st.errors[0].message || ''; }
  ledgerPut(st.id, rec);
  botState.lastOutboundDelivery = { provider: 'meta', messageId: st.id, status: st.status, at: new Date().toISOString(), error: rec.errorReason || null };
  console.log('[Meta status] id=' + st.id + ' status=' + st.status + (rec.errorCode ? ' err=' + rec.errorCode + ':' + rec.errorReason : ''));
  if (st.status === 'failed') maybeAlert('meta-delivery-failed', 'Meta delivery FAILED for ' + st.id + ' (' + (rec.errorReason || rec.errorCode || 'unknown') + ')');
}

async function handleMetaWebhook(body) {
  const entry = body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  if (!value) return;
  if (value.statuses) { for (const st of value.statuses) recordMetaStatus(st); return; }
  if (!value.messages) return;
  const msg = value.messages[0];
  if (!msg) return;
  const msgId = msg.id;
  if (alreadyProcessed(msgId)) { console.log('[Meta] duplicate inbound ignored ' + msgId); return; }
  const phone = msg.from;
  const userMessage = msg.type === 'text' ? (msg.text && msg.text.body) : '';
  if (!userMessage) { console.log('[Meta] non-text inbound ignored type=' + msg.type); return; }
  const inboundAt = recordInbound('meta', phone, userMessage);
  const phoneNumberId = value.metadata && value.metadata.phone_number_id;
  const { reply, path: replyPath } = await generateReply(userMessage, phone);
  const replyAt = new Date().toISOString();
  const sent = await sendMeta(phone, reply, phoneNumberId);
  ledgerPut(msgId, { direction: 'inbound', provider: 'meta', from: phone, inboundAt, replyAt, path: replyPath, replySent: !!(sent && sent.ok) });
  console.log('[Meta] inbound ' + msgId + ' path=' + replyPath + ' sent=' + (sent && sent.ok));
}

// ---- Twilio: delivery status callback parsing ----
function recordTwilioStatus(body) {
  const id = body.MessageSid || body.SmsSid;
  const status = body.MessageStatus || body.SmsStatus;
  const rec = { direction: 'outbound', provider: 'twilio', status, to: (body.To || '').replace('whatsapp:', ''), statusAt: new Date().toISOString() };
  if (body.ErrorCode) { rec.errorCode = body.ErrorCode; rec.errorReason = body.ErrorMessage || ('Twilio error ' + body.ErrorCode); }
  ledgerPut(id, rec);
  botState.lastOutboundDelivery = { provider: 'twilio', messageId: id, status, at: new Date().toISOString(), error: rec.errorReason || null };
  console.log('[Twilio status] sid=' + id + ' status=' + status + (body.ErrorCode ? ' err=' + body.ErrorCode : ''));
  if (status === 'failed' || status === 'undelivered') maybeAlert('twilio-delivery-failed', 'Twilio delivery ' + status + ' for ' + id + ' err=' + (body.ErrorCode || ''));
}

// ---- Alerting (best-effort email via Gmail OAuth; always logs) ----
const alertTimestamps = {};
async function maybeAlert(key, message) {
  const now = Date.now();
  if (alertTimestamps[key] && (now - alertTimestamps[key]) < 3600000) return; // dedup: 1/hour/key
  alertTimestamps[key] = now;
  botState.lastAlert = { key, message, at: new Date().toISOString() };
  console.error('[ALERT][' + key + '] ' + message);
  try { await sendAlertEmail('[Al-Imtiaz Bot] ' + key, message); } catch (e) { console.error('[ALERT] email failed: ' + e.message); }
}
async function sendAlertEmail(subject, text) {
  if (!process.env.GMAIL_OAUTH_CLIENT_ID || !process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    console.error('[ALERT] Gmail OAuth not configured (GMAIL_OAUTH_*) — alert logged only');
    return;
  }
  const oauth2 = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const raw = Buffer.from(
    'To: ' + ALERT_EMAIL + '\r\nSubject: ' + subject + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + text
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log('[ALERT] email sent to ' + ALERT_EMAIL);
}
// ============================================================================

const SYSTEM_PROMPT = `You are a bilingual real estate agent for Al-Imtiaz Wal-Jawada in Qatar.
- Reply ENTIRELY in the same language as the customer. If they write in English, reply FULLY in English (translate ALL property names, descriptions, and details to English). If they write in Arabic, reply FULLY in Arabic. NEVER mix languages.
- Only use property data provided, never invent
- Answer: price, size, availability, bedrooms, bathrooms, location
- Collect customer name naturally
- If interested in unit → ask for full name and visit time
- Use formal Gulf Arabic when replying in Arabic
- Keep replies short (WhatsApp style)
- When a customer asks for contact details or wants to visit or schedule a viewing, always provide these staff contacts:
  👤 محمد زيدان: 31293905 Mohammed
  👤 نزار: 77851855 Nizar
  👤 أحمد: 55513389 Ahmed
  WhatsApp: +974 7029 7066
- AVAILABILITY = TRUTH: The "Available Properties" list contains ONLY units explicitly marked متاح in the sheet. List exactly those units. If the list is EMPTY, tell the customer there are no available units right now and offer to take their details — do NOT invent, guess, or list rented units.
- PRIVACY (hard rule): NEVER reveal or imply the property owner/landlord identity, owner name, owner phone, ownership details, or any internal financials (purchase price, owner's rent share, mortgages). If asked who owns a property or for the owner's contact, politely decline and offer the staff agents below instead. Only ever share these staff contacts:
  👤 محمد زيدان: 31293905 Mohammed
  👤 نزار: 77851855 Nizar
  👤 أحمد: 55513389 Ahmed
- Always respond as JSON: {"reply":"...","interested_unit":"...","collected_name":"..."}`;

// Simple in-memory conversation store (keyed by phone number)
const conversations = {};

let lastBypassError = null;
let lastWebhookHit = null;
let lastClaudeData = null;

// In-memory cache of vacant units (populated by syncVacancy)
let cachedVacantUnits = [];
// Quick startup: load متاح-only truth from the Properties sheet (no force-feed prompt)
(async () => {
  try {
    const quickUnits = await getVacantProperties();
    cachedVacantUnits = quickUnits;
    persistentVacancyPrompt = '';
    console.log('[QuickStart] Loaded ' + quickUnits.length + ' متاح units from Properties sheet');
  } catch(e) { console.log('[QuickStart] Sheet read failed:', e.message); }
})();
let persistentVacancyPrompt = ''; // Always included in Claude's system prompt

async function askClaude(phone, userMessage, properties) {
  // If properties empty but we have cached data, use that instead
  if ((!properties || properties.length === 0) && cachedVacantUnits.length > 0) {
    properties = cachedVacantUnits.map(u => ({
      Unit: u.unit || u.Unit || '',
      Property_Name: u.property || u.Property_Name || '',
      Rent_QAR: u.monthlyRent || u.Rent_QAR || '',
      Status: 'Vacant'
    }));
    console.log('[askClaude] Using cached units as fallback:', properties.length);
  }
  const propertyData = JSON.stringify(properties, null, 2);
  
  // Build a plain-text vacancy summary that Claude cannot miss
  let vacancySummary = '';
  if (properties && properties.length > 0) {
    vacancySummary = '\n\n=== VACANCY LIST (CONFIRMED ' + properties.length + ' VACANT UNITS) ===\n';
    properties.forEach((p, i) => {
      const unit = p.Unit || p.unit || '?';
      const name = p.Property_Name || p.property || '';
      const rent = p.Rent_QAR || p.monthlyRent || '';
      vacancySummary += (i+1) + '. Unit ' + unit + (name ? ' - ' + name : '') + (rent ? ' - Rent: ' + rent + ' QAR/month' : '') + '\n';
    });
    vacancySummary += '=== END OF VACANCY LIST ===\nIMPORTANT: The above ' + properties.length + ' units ARE vacant and available. You MUST list them when asked about vacant/available units.';
  }
  lastClaudeData = { count: properties.length, sample: properties.slice(0,2), phone };

  if (!conversations[phone]) {
    conversations[phone] = [];
  }

  conversations[phone].push({ role: 'user', content: userMessage });

  // Keep only last 10 messages to avoid token limits
  if (conversations[phone].length > 10) {
    conversations[phone] = conversations[phone].slice(-10);
  }

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    // Fast, cheap chat: Sonnet 4.6 defaults to high effort; disable thinking and
    // use low effort so WhatsApp replies stay snappy (~1s) like the old Sonnet-4 path.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: `${SYSTEM_PROMPT}\n\nAvailable Properties:\n${propertyData}${vacancySummary}${persistentVacancyPrompt}`,
    messages: conversations[phone],
  });

  const assistantText = response.content[0].text;
  conversations[phone].push({ role: 'assistant', content: assistantText });

  return assistantText;
}

// --- Twilio Conversations Webhook (onMessageAdded POST) ---
app.post('/conversations-webhook', async (req, res) => {
  console.log('[CONV-WEBHOOK HIT] Keys:', Object.keys(req.body || {}));
  try { require('fs').appendFileSync('/tmp/webhook.log', new Date().toISOString() + ' | CONV | KEYS:' + Object.keys(req.body||{}).join(',') + ' | EVT:' + (req.body.EventType||'?') + ' | AUTH:' + (req.body.Author||'?') + '\n'); } catch(e) {}
  // TRACK at very top - before anything else
  lastWebhookHit = { endpoint: 'conv-webhook-TOP', eventType: req.body.EventType, author: req.body.Author, body: (req.body.Body||'').substring(0,30), participantSid: req.body.ParticipantSid || 'EMPTY', time: new Date().toISOString(), allKeys: Object.keys(req.body).join(',') };

  // Respond immediately so Twilio doesn't retry
  res.status(200).send('{}');

  try {
    const eventType = req.body.EventType;
    if (eventType !== 'onMessageAdded') return;

    const conversationSid = req.body.ConversationSid;
    const author = req.body.Author || '';
    const participantSid = req.body.ParticipantSid || '';
    const userMessage = req.body.Body || '';

    // TRACK ALL incoming webhook calls (before any filters)
    lastWebhookHit = { endpoint: 'conversations-webhook', eventType, author, participantSid: participantSid || 'EMPTY', msg: userMessage?.substring(0,50), convSid: conversationSid, time: new Date().toISOString() };

    // Ignore messages sent by the bot itself (no ParticipantSid = system/bot)
    // Bot messages come without a phone number author
    if (!author || author.startsWith('bot') || !userMessage) return;
    // Skip if this looks like it was sent by us (no ParticipantSid usually means bot message)
    if (!participantSid) return;

    const phone = author.replace('whatsapp:', '').replace(/^\+/, '');

    lastWebhookHit = { endpoint: 'conversations-webhook', author, msg: userMessage, convSid: conversationSid, time: new Date().toISOString() };
    console.log(`[CONV] ConvSid: ${conversationSid} | From: ${author} | Msg: ${userMessage}`);

    const properties = await getVacantProperties();

    // If asking about vacant units, reply directly using cached data (no sheet read needed)
    const vacancyKeywords = ['فاضية', 'فاضيه', 'شاغرة', 'شاغره', 'متاحة', 'متاحه', 'vacant', 'available', 'empty', 'فاضي', 'شاغر'];
    const isVacancyQuestion = vacancyKeywords.some(k => userMessage.toLowerCase().includes(k));

    if (isVacancyQuestion) {
      try {
        const units = cachedVacantUnits.length > 0 ? cachedVacantUnits : properties;
        console.log('[CONV] Vacancy bypass. cache:', cachedVacantUnits.length, 'props:', properties.length);
        if (units.length > 0) {
          const lines = units.map((u, i) => {
            try {
              const id = (u && (u.unit || u.Unit)) || String(u) || '?';
              const name = (u && (u.property || u.Property_Name || u.propertyName)) || '';
              const rent = (u && u.monthlyRent) ? ' - ' + u.monthlyRent + ' ريال/شهر' : '';
              return name ? (i+1) + '. ' + id + ' - ' + name + rent : (i+1) + '. ' + id + rent;
            } catch(e) { return (i+1) + '. وحدة شاغرة'; }
          });
          const reply = 'الوحدات الشاغرة حالياً (' + units.length + ' وحدة):\n\n' + lines.join('\n') + '\n\nللاستفسار والحجز:\n👤 محمد زيدان: 31293905\n👤 نزار: 77851855\n👤 أحمد: 55513389';
          const bypassTwilio = twilio(getConfig('TWILIO_ACCOUNT_SID'), getConfig('TWILIO_AUTH_TOKEN'));
          await bypassTwilio.conversations.v1.conversations(conversationSid).messages.create({ body: reply });
          await logLead({ phone, name: '', language: 'ar', question: userMessage, interestedUnit: '', status: 'New' });
          return;
        }
      } catch(bypassErr) {
        lastBypassError = { msg: bypassErr.message, stack: bypassErr.stack ? bypassErr.stack.substring(0,500) : '', time: new Date().toISOString() };
        console.error('[CONV] Bypass error:', bypassErr.message);
      }
    }

    // Clear old conversation history for vacancy questions so Claude sees fresh data
    if (isVacancyQuestion) { delete conversations[phone]; }

    const claudeResponse = await askClaude(phone, userMessage, properties);

    let parsed;
    try {
      const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { reply: claudeResponse };
    } catch {
      parsed = { reply: claudeResponse };
    }

    const replyText = parsed.reply || claudeResponse;
    const interestedUnit = parsed.interested_unit || '';
    const collectedName = parsed.collected_name || '';

    const isArabic = /[\u0600-\u06FF]/.test(userMessage);
    await logLead({
      phone,
      name: collectedName,
      language: isArabic ? 'Arabic' : 'English',
      question: userMessage,
      interestedUnit,
      status: interestedUnit ? 'Interested' : 'New',
    });

    // Reply via Conversations API
    const twilioClient = twilio(getConfig('TWILIO_ACCOUNT_SID'), getConfig('TWILIO_AUTH_TOKEN'));
    await twilioClient.conversations.v1.conversations(conversationSid).messages.create({
      body: replyText,
    });

    console.log(`[CONV] Replied to ${conversationSid}`);
  } catch (error) {
    logError(error);
  }
});

// --- Twilio WhatsApp Webhook ---
app.post('/webhook', async (req, res) => {
  const _body = req.body || {};
  lastRequest = { path: '/webhook', method: 'POST', bodyKeys: Object.keys(_body), time: new Date().toISOString() };

  // ROUTING 1: Meta Cloud API JSON (inbound message OR delivery status)
  if (_body.object === 'whatsapp_business_account') {
    res.sendStatus(200); // ack immediately, then process async
    handleMetaWebhook(_body).catch(e => logError(new Error('[Meta webhook] ' + (e && e.message))));
    return;
  }
  // ROUTING 2: Twilio delivery status callback (has MessageStatus, no Body)
  if ((_body.MessageStatus || _body.SmsStatus) && !_body.Body) {
    try { recordTwilioStatus(_body); } catch (e) { logError(e); }
    return res.sendStatus(204);
  }

  // ROUTING 3: Twilio inbound WhatsApp message -> synchronous TwiML reply
  console.log('[WEBHOOK HIT][twilio] From:', _body.From, 'Body:', (_body.Body || '').substring(0, 50));
  const _msgId = _body.MessageSid || ('tw_' + Date.now());
  if (alreadyProcessed(_msgId)) { res.type('text/xml'); return res.send(new MessagingResponse().toString()); }
  const _inboundAt = recordInbound('twilio', (_body.From || '').replace('whatsapp:', ''), _body.Body || '');
  ledgerPut(_msgId, { direction: 'inbound', provider: 'twilio', from: (_body.From || '').replace('whatsapp:', ''), inboundAt: _inboundAt });
  try {
    const incomingMsg = req.body.Body || '';
    const from = req.body.From || '';
    const phone = from.replace('whatsapp:', '');

    lastWebhookHit = { endpoint: 'webhook', phone, msg: incomingMsg, time: new Date().toISOString() };
    console.log(`[MSG-WEBHOOK] From: ${phone} | Message: ${incomingMsg}`);

    // Get only vacant/available properties from Google Sheets
    const properties = await getVacantProperties();

    // Vacancy bypass for /webhook path
    const vacKw2 = ['فاضية', 'فاضيه', 'شاغرة', 'شاغره', 'متاحة', 'متاحه', 'vacant', 'available', 'empty', 'فاضي', 'شاغر'];
    const isVacQ2 = vacKw2.some(k => incomingMsg.toLowerCase().includes(k));
    if (isVacQ2) {
      let units2 = properties; // properties = getVacantProperties() truth (متاح only)
      if (units2.length === 0) {
        console.log('[BYPASS] zero متاح units → no-vacancy reply (no hardcoded list)');
        const hcReply = 'الوحدات الشاغرة حالياً:\n\n1. P6A - مخزن بركة العوامر (20,000 ريال)\n2. P10 - محل ام غويلينا (9,000 ريال)\n3. P15 - مصنع العفجة\n4. P26-1 - سكن عمال غرفة (1,000 ريال)\n5. P26-3 - سكن عمال غرفتين (2,000 ريال)\n6. P26-4 - سكن عمال 3 غرف (3,000 ريال)\n7. P33-4 - سكن عمال 18 غرفة (16,200 ريال)\n8. P34 - مصنع الجبس (100,000 ريال)\n9. P47 - ملحق سكنى السد (3,200 ريال)\n10. P48 - بناء السد\n11. P49 - غرفه السد (1,100 ريال)\n\nللاستفسار:\n👤 محمد زيدان: 31293905\n👤 نزار: 77851855\n👤 أحمد: 55513389';
        const twimlHC = new MessagingResponse();
        twimlHC.message(NO_VACANCY_REPLY);
        res.type('text/xml');
        return res.send(twimlHC.toString());
      }
      if (units2.length > 0) {
        const twiml2 = new MessagingResponse();
        twiml2.message(buildVacancyReply(units2)); // shared formatter (uses Location/Type as name)
        res.type('text/xml');
        return res.send(twiml2.toString());
      }
      delete conversations[phone];
    }

    // Always clear conversation history for fresh Claude response
    delete conversations[phone];

    // Ask Claude
    const claudeResponse = await askClaude(phone, incomingMsg, properties);

    // Parse Claude's JSON response
    let parsed;
    try {
      const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { reply: claudeResponse };
    } catch {
      parsed = { reply: claudeResponse };
    }

    const replyText = parsed.reply || claudeResponse;
    const interestedUnit = parsed.interested_unit || '';
    const collectedName = parsed.collected_name || '';

    // Detect language
    const isArabic = /[\u0600-\u06FF]/.test(incomingMsg);
    const language = isArabic ? 'Arabic' : 'English';

    // Log lead to Google Sheets
    await logLead({
      phone,
      name: collectedName,
      language,
      question: incomingMsg,
      interestedUnit,
      status: interestedUnit ? 'Interested' : 'New',
    });

    // Send reply via Twilio TwiML, wiring a delivery-status callback to /twilio-status
    const _base = process.env.PUBLIC_URL || ('https://' + req.get('host'));
    const twiml = new MessagingResponse();
    twiml.message({ statusCallback: _base + '/twilio-status' }, replyText);
    botState.lastSuccess.claude = botState.lastSuccess.claude || new Date().toISOString();
    ledgerPut(_msgId, { replyAt: new Date().toISOString(), path: 'claude' });

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    // Distinct, classified error logging — never collapse to one opaque message
    const c = classifyError(error);
    botState.lastClaudeError = { ...c, at: new Date().toISOString() };
    logError(new Error('[POST /webhook][' + c.kind + '][status=' + c.status + '] ' + c.message));
    console.error('[POST /webhook] FAILED kind=' + c.kind + ' status=' + c.status + ' :: ' + c.message);
    ledgerPut(_msgId, { replyAt: new Date().toISOString(), errorKind: c.kind });
    const twiml = new MessagingResponse();
    twiml.message(getConfig('FALLBACK_MESSAGE') || ARABIC_FALLBACK);
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// === META CLOUD API: webhook verification (GET) ===
// Meta calls GET with hub.mode/hub.verify_token/hub.challenge. Primary path is
// GET /webhook; /meta-webhook is kept as a back-compat alias.
function handleMetaVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = getConfig('META_VERIFY_TOKEN') || DEFAULT_VERIFY_TOKEN;
  if (mode === 'subscribe' && token === expected) {
    console.log('[Meta] Webhook verified (challenge echoed)');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta] Webhook verify FAILED mode=' + mode + ' tokenMatch=' + (token === expected));
  return res.sendStatus(403);
}
app.get('/webhook', handleMetaVerify);
app.get('/meta-webhook', handleMetaVerify);

// === META CLOUD API: inbound + status (POST alias) ===
// Primary inbound path is POST /webhook (provider-routed). This alias delegates
// to the same shared handler so nothing breaks mid-migration.
app.post('/meta-webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately
  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') return;
  lastWebhookHit = { endpoint: 'meta-webhook', time: new Date().toISOString() };
  lastRequest = { path: '/meta-webhook', method: 'POST', bodyKeys: Object.keys(body), time: new Date().toISOString() };
  handleMetaWebhook(body).catch(e => logError(new Error('[Meta webhook alias] ' + (e && e.message))));
});

// === Twilio delivery status callback endpoint ===
app.post('/twilio-status', (req, res) => {
  try { recordTwilioStatus(req.body || {}); } catch (e) { logError(e); }
  res.sendStatus(204);
});
// === END WEBHOOK HANDLERS ===

app.get('/debug-vacancy', async (req, res) => {
  try {
    const sheets = await getGoogleSheets();
    // Read vacancy sheet raw
    const vacRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Vacancy!A1:E30' }).catch(() => ({data:{values:[]}}));
    const vacRows = vacRes.data.values || [];
    // Read properties unit column
    const propRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:B60' });
    const propRows = propRes.data.values || [];
    const propUnits = propRows.slice(1).map(r => r[1] || r[0]);
    // Get filtered properties
    const props = await getVacantProperties();
    res.json({
      vacancySheet: vacRows,
      propertiesUnits: propUnits.slice(0,20),
      filteredCount: props.length,
      filteredUnits: props.map(p => p.Unit)
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0,300) });
  }
});

// Ground-truth diagnostic for the Properties sheet status column (متاح/مؤجر tally).
app.get('/debug-properties', async (req, res) => {
  try {
    const sheets = await getGoogleSheets();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID }).catch(() => null);
    const tabs = meta ? (meta.data.sheets || []).map(s => s.properties.title) : [];
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:Z1000' });
    const rows = resp.data.values || [];
    const headers = (rows[0] || []).map(h => _norm(h));
    const dataRows = rows.slice(1).filter(r => r && r.some(c => _norm(c) !== ''));
    let statusIdx = -1, best = 0;
    for (let c = 0; c < headers.length; c++) {
      let cnt = 0;
      for (const r of dataRows) { if (isAvailableStatus(r[c]) || isRentedStatus(r[c])) cnt++; }
      if (cnt > best) { best = cnt; statusIdx = c; }
    }
    const tally = { mutah_متاح: 0, muajjar_مؤجر: 0, blank: 0, other: {} };
    if (statusIdx >= 0) {
      for (const r of dataRows) {
        const v = _norm(r[statusIdx]);
        if (isAvailableStatus(v)) tally.mutah_متاح++;
        else if (isRentedStatus(v)) tally.muajjar_مؤجر++;
        else if (v === '') tally.blank++;
        else tally.other[v] = (tally.other[v] || 0) + 1;
      }
    }
    const ownerCols = headers.filter(h => OWNER_COL_RE.test(h));
    // Distinct trimmed values per column (small sheet) to reveal the real status vocabulary
    const distinctByHeader = {};
    headers.forEach((h, i) => {
      const counts = {};
      for (const r of dataRows) { const v = _norm(r[i]); counts[v] = (counts[v] || 0) + 1; }
      distinctByHeader[h || ('col' + i)] = counts;
    });
    const vacant = await getVacantProperties();
    res.json({
      tabs,
      distinctByHeader,
      headers,
      totalDataRows: dataRows.length,
      statusColumn: statusIdx >= 0 ? { index: statusIdx, header: headers[statusIdx] } : null,
      tally,
      ownerColumnsStripped: ownerCols,
      vacantCount_after_fix: vacant.length,
      vacantUnits: vacant.map(u => u.Unit),
      sampleVacant_ownerStripped: vacant[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: (e.stack || '').substring(0, 300) });
  }
});

// ===== TEMPORARY ADMIN: rent-report extraction + Status writer (remove after use) =====
function _colLetter(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
async function _gmailToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GMAIL_OAUTH_CLIENT_ID, client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET, refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const d = await r.json();
  if (!d.access_token) throw new Error('gmail token: ' + JSON.stringify(d).substring(0, 200));
  return d.access_token;
}
function _findPdfPart(parts) { for (const p of (parts || [])) { if (p.filename && p.filename.toLowerCase().endsWith('.pdf') && p.body && p.body.attachmentId) return p; if (p.parts) { const r = _findPdfPart(p.parts); if (r) return r; } } return null; }

// FAITHFUL extraction: returns raw per-row report data + the Properties map. No judgment.
app.get('/admin-rent-extract', async (req, res) => {
  try {
    const at = await _gmailToken();
    const q = encodeURIComponent('from:alamtyaz.wa.aljawada@gmail.com has:attachment newer_than:200d');
    const sd = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + q + '&maxResults=30', { headers: { Authorization: 'Bearer ' + at } })).json();
    const messages = sd.messages || [];
    const cands = [];
    for (const m of messages) {
      const md = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=Date', { headers: { Authorization: 'Bearer ' + at } })).json();
      const hs = (md.payload || {}).headers || [];
      cands.push({ id: m.id, subject: (hs.find(h => h.name === 'Subject') || {}).value || '', date: (hs.find(h => h.name === 'Date') || {}).value || '', internalDate: md.internalDate });
    }
    cands.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const RENT = ['ايجار', 'إيجار', 'محصل', 'المحصل', 'تحصيل', 'rent', 'collected'];
    const EXC = ['مصاريف', 'فاتور', 'expense', 'invoice'];
    const ranked = cands.filter(c => RENT.some(k => c.subject.includes(k)) && !EXC.some(k => c.subject.includes(k)));
    const chosen = ranked[0] || cands[0];
    if (!chosen) return res.json({ error: 'no emails', candidatesTop: cands.slice(0, 10) });
    const full = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + chosen.id + '?format=full', { headers: { Authorization: 'Bearer ' + at } })).json();
    const pdf = _findPdfPart((full.payload || {}).parts);
    if (!pdf) return res.json({ error: 'no pdf', chosen, parts: ((full.payload || {}).parts || []).map(p => p.filename) });
    const att = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + chosen.id + '/attachments/' + pdf.body.attachmentId, { headers: { Authorization: 'Bearer ' + at } })).json();
    const b64 = att.data.replace(/-/g, '+').replace(/_/g, '/');
    const ex = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 8000, thinking: { type: 'disabled' }, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: 'This is an Arabic monthly rent-collection report. Extract EVERY property/unit row VERBATIM. Do NOT decide vacant vs rented and do NOT omit rows. For each row output JSON {"row":N,"property":"<exact arabic property/unit text>","tenant":"<tenant text or empty>","rent_due":"<number or empty>","rent_received":"<number or empty>","remarks":"<the exact البيان/الملاحظات/الحالة cell text, or empty>"}. Return ONLY a JSON array.' }
      ] }]
    });
    const txt = ex.content[0].text;
    let rows = []; try { rows = JSON.parse((txt.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) {}
    const sheets = await getGoogleSheets();
    const pr = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:Z1000' });
    const prows = pr.data.values || []; const ph = (prows[0] || []);
    const iUnit = ph.indexOf('Unit'), iID = ph.indexOf('ID'), iType = ph.indexOf('Type'), iLoc = ph.indexOf('Location'), iStat = ph.indexOf('Status');
    const props = prows.slice(1).filter(r => r.some(c => _norm(c))).map((r, idx) => ({ rowNumber: idx + 2, ID: r[iID] || '', Unit: r[iUnit] || '', Type: r[iType] || '', Location: r[iLoc] || '', Status: r[iStat] || '' }));
    res.json({ chosen, pdfFile: pdf.filename, candidatesTop: cands.slice(0, 8).map(c => ({ subject: c.subject, date: c.date })), extractedRowCount: rows.length, rows, statusColumnLetter: _colLetter(iStat), properties: props });
  } catch (e) { res.status(500).json({ error: e.message, stack: (e.stack || '').substring(0, 400) }); }
});

// Status writer: writes متاح/مؤجر into the detected Status column for the units passed.
// Default is dry-run; pass ?apply=1 to commit. Only touches the Status column.
app.post('/admin-set-status', async (req, res) => {
  try {
    const apply = req.query.apply === '1';
    const updates = (req.body && req.body.updates) || [];
    if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'no updates' });
    const sheets = await getGoogleSheets();
    const pr = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Properties!A1:Z1000' });
    const prows = pr.data.values || []; const ph = (prows[0] || []);
    let iStat = ph.indexOf('Status');
    const iUnit = ph.indexOf('Unit'), iID = ph.indexOf('ID');
    if (iStat < 0) return res.status(500).json({ error: 'no Status header' });
    const letter = _colLetter(iStat);
    const find = (key) => { for (let r = 1; r < prows.length; r++) { if (_norm(prows[r][iUnit]) === key || _norm(prows[r][iID]) === key) return r + 1; } return -1; };
    const data = [], results = [];
    for (const u of updates) {
      const status = _norm(u.status);
      if (status !== 'متاح' && status !== 'مؤجر') { results.push({ unit: u.unit, error: 'bad status: ' + status }); continue; }
      const rowNum = find(_norm(u.unit));
      if (rowNum < 0) { results.push({ unit: u.unit, error: 'not found' }); continue; }
      data.push({ range: 'Properties!' + letter + rowNum, values: [[status]] });
      results.push({ unit: u.unit, row: rowNum, cell: letter + rowNum, status });
    }
    if (apply && data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
    res.json({ apply, statusColumn: letter, planned: data.length, written: apply ? data.length : 0, results });
  } catch (e) { res.status(500).json({ error: e.message, stack: (e.stack || '').substring(0, 300) }); }
});
// ===== END TEMPORARY ADMIN =====

// Manual vacancy sync trigger endpoint
app.post('/sync-vacancy', async (req, res) => {
  try {
    const result = await syncVacancy();
    res.json({ status: 'ok', ...result });
  } catch (error) {
    logError(error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ══════════════════════════════════════════════════════
// AD POSTER ENDPOINTS
// ══════════════════════════════════════════════════════

// POST /run-posting  → Run full posting for all vacant units
app.post('/run-posting', async (req, res) => {
  const { testOnly, limitToUnit, platforms } = req.body || {};
  res.json({ status: 'started', message: 'Ad posting run started. Check Ad_Log sheet for results.' });
  // Run async after response sent
  triggerManually({ testOnly: !!testOnly, limitToUnit, platforms }).catch(err =>
    logError(new Error('[run-posting] ' + err.message))
  );
});

// POST /test-posting  → Test post only the first vacant unit on both platforms
app.post('/test-posting', async (req, res) => {
  try {
    const result = await triggerManually({ testOnly: true });

    // After postAd, extract page data while browser is still alive
    res.json({ status: 'done', result });
  } catch (e) {
    logError(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// POST /run-posting-sync  → Run full posting synchronously, wait for result
app.post('/run-posting-sync', async (req, res) => {
  try {
    const { runPosting } = require('./poster');
    const result = await runPosting({ testOnly: false });
    res.json({ status: 'done', result });
  } catch (e) {
    logError(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// POST /post-unit  → Post a specific unit: body { unit: "A-101" }
app.post('/post-unit', async (req, res) => {
  const { unit, platforms } = req.body || {};
  if (!unit) return res.status(400).json({ error: 'unit is required' });
  res.json({ status: 'started', unit });
  triggerManually({ limitToUnit: unit, platforms }).catch(err =>
    logError(new Error('[post-unit] ' + err.message))
  );
});

// POST /broadcast-brokers  → Monthly vacant-unit broadcast to brokers via Twilio Content Template
//   body { dryRun?: boolean, testOnly?: boolean }
//   dryRun=true  → builds preview + recipient list WITHOUT sending
//   testOnly=true → sends only to the bot's own TWILIO_WHATSAPP_NUMBER (for QA)
app.post('/broadcast-brokers', async (req, res) => {
  try {
    const { broadcastToBrokers } = require('./broker-broadcast');
    const { dryRun, testOnly } = req.body || {};
    const result = await broadcastToBrokers({
      dryRun: !!dryRun,
      testOnly: !!testOnly,
      _trigger: 'manual_api',
    });
    res.json({ status: 'done', result });
  } catch (e) {
    logError(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});


// POST /patch-apps-script  → One-time: inject webhook call into Apps Script updateVacancySheet
app.post('/patch-apps-script', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const SCRIPT_ID = '1O8BXSyFR_SE5Tcj1mU_nrfcZDMsw8GNbIFtaAd4i2ec4en1-U-aOVCXL';
    const WEBHOOK_CODE = `
    // Auto-trigger Mzad ad posting after vacancy update
    try {
      var postUrl = 'https://alimtiaz-whatsapp-bot-production.up.railway.app/run-posting';
      var postOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ source: 'vacancy-script' }),
        muteHttpExceptions: true
      };
      var postResponse = UrlFetchApp.fetch(postUrl, postOptions);
      Logger.log('Mzad posting triggered: ' + postResponse.getResponseCode());
    } catch(triggerErr) {
      Logger.log('Failed to trigger Mzad posting: ' + triggerErr.message);
    }`;

    let credentials;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else {
      return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/script.projects',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    const scriptApi = google.script({ version: 'v1', auth });

    // Step 1: Read current content
    const contentRes = await scriptApi.projects.getContent({ scriptId: SCRIPT_ID });
    const files = contentRes.data.files || [];
    const codeFile = files.find(f => f.name === 'Code' || f.name === 'Code.gs') || files[0];
    if (!codeFile) return res.status(500).json({ error: 'Code.gs not found in script', files: files.map(f => f.name) });

    const originalSource = codeFile.source;

    // Step 2: Check if webhook already present
    if (originalSource.includes('alimtiaz-whatsapp-bot-production.up.railway.app/run-posting')) {
      return res.json({ status: 'already_patched', message: 'Webhook code already present in script' });
    }

    // Step 3: Inject before the final closing } of the second updateVacancySheet catch block
    // Use regex to handle any whitespace/newline variation
    const anchorRegex = /([ \t]*Logger\.log\('updateVacancySheet error: ' \+ e\.message\);[\r\n\s]*\}[\r\n\s]*\})/;
    if (!anchorRegex.test(originalSource)) {
      // Debug: return tail of source to diagnose
      return res.status(500).json({
        error: 'Anchor regex not found',
        tail: originalSource.slice(-300),
      });
    }

    // Replace LAST match to target the second (bottom) updateVacancySheet function
    let lastMatch, lastIndex;
    let tempRe = new RegExp(anchorRegex.source, 'g');
    let m;
    while ((m = tempRe.exec(originalSource)) !== null) { lastMatch = m[0]; lastIndex = m.index; }

    const patchedSource = originalSource.slice(0, lastIndex) +
      lastMatch.replace(/(\}\s*\})\s*$/, `\n${WEBHOOK_CODE}\n}`) +
      originalSource.slice(lastIndex + lastMatch.length);

    // Step 4: Push updated content
    codeFile.source = patchedSource;
    await scriptApi.projects.updateContent({
      scriptId: SCRIPT_ID,
      requestBody: { files },
    });

    res.json({ status: 'patched', message: 'Webhook code injected into updateVacancySheet successfully' });
  } catch (e) {
    logError(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// GET /poster-status  → Check scheduler status and next run
app.get('/poster-status', (req, res) => {
  res.json(getStatus());
});

// ══════════════════════════════════════════════════════

// Test Mzad login (CF bypass + auth)
app.get('/test-mzad-login', async (req, res) => {
  try {
    const { getSession } = require('./mzad');
    console.log('[test-mzad-login] Starting Mzad login test...');
    const session = await getSession();
    console.log('[test-mzad-login] Session result:', JSON.stringify(session ? { hasSession: true, keys: Object.keys(session) } : null));
    res.json({ status: 'ok', session: session ? { hasSession: true, keys: Object.keys(session) } : null });
  } catch (e) {
    console.error('[test-mzad-login] Error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Debug Mzad — uses Puppeteer-based postAd with a test property
app.get('/debug-mzad-steps', async (req, res) => {
  try {
    const mzad = require('./mzad');
    // Force fresh login if ?fresh=1
    if (req.query.fresh === '1') {
      console.log('[debug-mzad] Forcing fresh login...');
      delete process.env.MZAD_SESSION;
      delete process.env.MZAD_XSRF_TOKEN;
    }
    console.log('[debug-mzad] Getting session...');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });

    // Build a test property object
    const testProperty = {
      Unit: 'DEBUG-1',
      Type: 'Apartment',
      Location: 'Doha',
      Region: 'D-Ring',
      Bedrooms: '2',
      Bathrooms: '2',
      Size_sqm: '100',
      Floor: '1',
      Rent_QAR: '5000',
      Maps_Link: '',
      Notes: '',
    };

    console.log('[debug-mzad] Running Puppeteer postAd...');
    const result = await mzad.postAd(testProperty, session);

    // After postAd, extract page data while browser is still alive
    let pageData = null;
    try {
      pageData = await mzad.getGroupsData();
    } catch(e) { pageData = { error: e.message }; }

    res.json({ status: 'done', result, pageData });
  } catch (e) {
    console.error('[debug-mzad] Error:', e.message);
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// Test posting in "Others" category (productId=9) to check if account-wide issue
app.get('/test-other-cat', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });
    
    // Minimal property for "Others" category
    const testProp = {
      Unit: 'OTHER-TEST-1',
      Type: 'Other',
      Location: 'Doha',
      Region: 'Doha',
      Bedrooms: '0',
      Bathrooms: '0',
      Size_sqm: '0',
      Floor: '0',
      Rent_QAR: '100',
      Maps_Link: '',
      Notes: 'Test posting in Others category',
    };
    
    // Override category to "Others" (productId=9)
    testProp._overrideCategory = 9; // Others (free category)
    
    const result = await mzad.postAd(testProp, session);
    res.json({ status: 'done', result });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// Test posting via Inertia router (uses the real form code path)
app.get('/test-inertia-post', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const { postAdViaInertia } = require('./mzad-ui-post');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });

    // Get browser page from mzad module
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page. Login first via /mzad-send-otp + /mzad-verify-otp' });

    const catId = parseInt(req.query.cat) || 8494;
    const testProp = {
      Unit: 'INERTIA-TEST-1',
      Type: 'Apartment',
      Location: 'Doha',
      Region: 'D-Ring',
      Bedrooms: '2', Bathrooms: '2', Size_sqm: '100', Floor: '1',
      Rent_QAR: '5000', Maps_Link: '', Notes: '',
    };
    if (catId !== 8494) testProp._overrideCategory = catId;

    const result = await postAdViaInertia(page, testProp);
    res.json({ status: 'done', result });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// Diagnostic: Get category groups and subscription info
app.get('/debug-groups', async (req, res) => {
  try {
    const mzad = require('./mzad');
    console.log('[debug-groups] Getting session...');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });
    
    console.log('[debug-groups] Extracting groups data...');
    const groups = await mzad.getGroupsData(session);
    res.json({ status: 'done', groups });
  } catch (e) {
    console.error('[debug-groups] Error:', e.message);
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// Check if ad was posted by viewing user's ads via bot session
app.get('/check-my-ads', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const axios = require('axios');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });

    const { session: sess, xsrf, csrfToken, extraCookies } = session;
    const cookies = [`mzadqatar_session=${sess}`, `XSRF-TOKEN=${xsrf}`];
    if (extraCookies) {
      for (const [k, v] of Object.entries(extraCookies)) cookies.push(`${k}=${v}`);
    }

    const headers = {
      'Cookie': cookies.join('; '),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html, application/xhtml+xml',
    };

    // First get the page HTML to extract Inertia data
    const r = await axios.get('https://mzadqatar.com/en/user/profile/myads', {
      headers,
      validateStatus: s => s < 600,
    });

    // Parse Inertia props from HTML
    let props = {};
    if (typeof r.data === 'string') {
      const match = r.data.match(/data-page="([^"]+)"/);
      if (match) {
        try {
          const pageData = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
          props = pageData.props || {};
        } catch(e) {}
      }
    } else {
      props = r.data?.props || {};
    }

    const userData = props.classifiedUserData;
    const myAds = props.myProductsData || props.myAds;

    res.json({
      status: r.status,
      userName: userData?.name || userData?.phone,
      adsCount: myAds?.data?.length || myAds?.total || 0,
      ads: myAds?.data?.slice(0, 5).map(a => ({
        id: a.productId || a.id,
        title: a.productName || a.productNameEnglish || a.title,
        price: a.productPrice || a.price,
        status: a.status,
        createdAt: a.created_at || a.createdAt,
        url: a.productUrl || a.url,
      })) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test Gmail OTP reader
app.get('/test-gmail', async (req, res) => {
  try {
    const { readOtpFromGmail } = require('./gmail-otp');
    console.log('[test-gmail] Testing Gmail OAuth and OTP search...');
    const minTs = Date.now() - 10 * 60 * 1000; // last 10 min
    const otp = await readOtpFromGmail('mzad', 2, 3000, minTs);
    res.json({ ok: true, otp: otp || 'none found', timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[test-gmail] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message, stack: e.stack?.substring(0, 500) });
  }
});





// Health check endpoint
// Auto-sync vacancy on startup so cache is always populated
loadConfig().then(() => {
  setTimeout(() => {
    syncVacancy().then(r => console.log('[Startup] Vacancy synced:', r)).catch(e => console.error('[Startup] Sync failed:', e.message));
  }, 5000);
});


// TEST: Simulate vacancy bypass to see errors
app.get('/test-bypass', async (req, res) => {
  try {
    const units = cachedVacantUnits.length > 0 ? cachedVacantUnits : (await getVacantProperties());
    const lines = units.map((u, i) => {
      const id = (u && (u.unit || u.Unit)) || '?';
      const name = (u && (u.property || u.Property_Name || u.propertyName)) || '';
      const rent = (u && u.monthlyRent) ? ' - ' + u.monthlyRent : '';
      return (i+1) + '. ' + id + (name ? ' - ' + name : '') + rent;
    });
    const reply = 'Vacant (' + units.length + '):\n' + lines.join('\n');
    res.json({ 
      cacheLen: cachedVacantUnits.length, 
      propsLen: units.length,
      hasTwilioSid: !!getConfig('TWILIO_ACCOUNT_SID'),
      hasTwilioToken: !!getConfig('TWILIO_AUTH_TOKEN'),
      configKeys: Object.keys(configCache).slice(0,10),
      envTwilio: !!process.env.TWILIO_ACCOUNT_SID,
      reply: reply.substring(0, 500)
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0,500) });
  }
});


app.get('/check-twilio-webhooks', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const headers = { 'Authorization': 'Basic ' + auth };
    
    // Check Conversations service config
    const convRes = await fetch('https://conversations.twilio.com/v1/Configuration', { headers });
    const convData = await convRes.json();
    
    // Check Conversations webhooks
    const whRes = await fetch('https://conversations.twilio.com/v1/Configuration/Webhooks', { headers });
    const whData = await whRes.json();
    
    // List conversation services
    const svcRes = await fetch('https://conversations.twilio.com/v1/Services?PageSize=5', { headers });
    const svcData = await svcRes.json();
    
    res.json({ 
      defaultService: convData.default_conversation_service_sid,
      webhooks: whData,
      services: svcData.services?.map(s => ({ sid: s.sid, name: s.friendly_name })) || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/check-service-webhooks', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const headers = { 'Authorization': 'Basic ' + auth };
    
    // Get default service
    const confRes = await fetch('https://conversations.twilio.com/v1/Configuration', { headers });
    const confData = await confRes.json();
    const defaultSvc = confData.default_conversation_service_sid;
    
    // Get service-level webhooks
    const svcWhRes = await fetch('https://conversations.twilio.com/v1/Services/' + defaultSvc + '/Configuration/Webhooks', { headers });
    const svcWhData = await svcWhRes.json();
    
    // List recent conversations to see if messages are flowing
    const convRes = await fetch('https://conversations.twilio.com/v1/Services/' + defaultSvc + '/Conversations?PageSize=3', { headers });
    const convData = await convRes.json();
    
    // Check persistentVacancyPrompt
    const promptLen = (typeof persistentVacancyPrompt === 'string') ? persistentVacancyPrompt.length : 0;
    
    res.json({
      defaultServiceSid: defaultSvc,
      serviceWebhooks: svcWhData,
      recentConversations: convData.conversations?.map(c => ({ sid: c.sid, name: c.friendly_name || c.unique_name, state: c.state })) || [],
      persistentPromptLength: promptLen,
      persistentPromptPreview: (persistentVacancyPrompt || '').substring(0, 200)
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0,300) });
  }
});



app.get('/reset-webhook', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const webhookUrl = 'https://alimtiaz-whatsapp-bot-production.up.railway.app/conversations-webhook';
    const r = await fetch('https://conversations.twilio.com/v1/Configuration/Webhooks', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'PostWebhookUrl=' + encodeURIComponent(webhookUrl) + '&PreWebhookUrl=' + encodeURIComponent(webhookUrl) + '&Filters=onMessageAdded&Method=POST&Target=webhook'
    });
    const data = await r.json();
    res.json({ status: 'reset', result: data });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/check-sandbox', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const h = { 'Authorization': 'Basic ' + auth };
    // Check sandbox config
    const sbRes = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Sandbox.json', { headers: h });
    const sbData = await sbRes.json();
    // Check conversations config  
    const cvRes = await fetch('https://conversations.twilio.com/v1/Configuration/Webhooks', { headers: h });
    const cvData = await cvRes.json();
    res.json({ sandbox: sbData, conversationsWebhook: cvData });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/check-twilio-full', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const h = { 'Authorization': 'Basic ' + auth };
    
    // Check messaging services
    const msRes = await fetch('https://messaging.twilio.com/v1/Services?PageSize=5', { headers: h });
    const msData = await msRes.json();
    
    // Check Studio Flows
    const sfRes = await fetch('https://studio.twilio.com/v2/Flows?PageSize=5', { headers: h });
    const sfData = await sfRes.json();
    
    // Check incoming phone numbers (sandbox)
    const pnRes = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/IncomingPhoneNumbers.json?PageSize=5', { headers: h });
    const pnData = await pnRes.json();
    
    // Check WhatsApp senders
    const wsRes = await fetch('https://messaging.twilio.com/v1/Senders/whatsapp?PageSize=5', { headers: h }).catch(e => ({ json: async () => ({error: e.message}) }));
    const wsData = await wsRes.json();
    
    res.json({
      messagingServices: msData.services?.map(s => ({ sid: s.sid, name: s.friendly_name, webhook: s.status_callback })) || [],
      studioFlows: sfData.flows?.map(f => ({ sid: f.sid, name: f.friendly_name, status: f.status })) || [],
      phoneNumbers: pnData.incoming_phone_numbers?.map(p => ({ number: p.phone_number, smsUrl: p.sms_url, voiceUrl: p.voice_url })) || [],
      whatsappSenders: wsData
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/show-config', (req, res) => {
  const keys = Object.keys(configCache);
  const safe = {};
  keys.forEach(k => {
    const v = configCache[k] || '';
    // Show URLs fully, mask tokens/secrets
    if (k.includes('URL') || k.includes('WEBHOOK') || k.includes('NUMBER') || k.includes('NAME') || k.includes('RESULTS') || k.includes('MESSAGE')) {
      safe[k] = v;
    } else {
      safe[k] = v.substring(0, 6) + '***';
    }
  });
  // Also check env vars
  safe['ENV_DIALOG360_URL'] = process.env.DIALOG360_URL || 'not set';
  safe['ENV_META_WEBHOOK'] = process.env.META_WEBHOOK_URL || 'not set';
  res.json(safe);
});

app.get('/simulate-vacancy', async (req, res) => {
  try {
    const properties = await getVacantProperties();
    delete conversations['simulate'];
    const claudeResponse = await askClaude('simulate', 'what are the vacant units available', properties);
    res.json({ 
      propsCount: properties.length,
      cacheCount: cachedVacantUnits.length,
      promptLen: persistentVacancyPrompt.length,
      claudeResponse: claudeResponse.substring(0, 500)
    });
  } catch(e) {
    res.json({ error: e.message, stack: e.stack?.substring(0,300) });
  }
});


app.get('/check-address-config', async (req, res) => {
  try {
    const sid = getConfig('TWILIO_ACCOUNT_SID');
    const token = getConfig('TWILIO_AUTH_TOKEN');
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const headers = { 'Authorization': 'Basic ' + auth };
    
    // Check address configurations (maps WhatsApp numbers to Conversations)
    const addrRes = await fetch('https://conversations.twilio.com/v1/Configuration/Addresses?PageSize=20', { headers });
    const addrData = await addrRes.json();
    
    // Check conversation participants to find WhatsApp conversations  
    const convRes = await fetch('https://conversations.twilio.com/v1/Conversations?PageSize=5', { headers });
    const convData = await convRes.json();
    
    // Check webhooks on default service
    const whRes = await fetch('https://conversations.twilio.com/v1/Configuration/Webhooks', { headers });
    const whData = await whRes.json();
    
    res.json({
      addresses: addrData,
      conversations: convData.conversations?.map(c => ({ sid: c.sid, state: c.state, friendlyName: c.friendly_name, messagingServiceSid: c.messaging_service_sid })),
      webhooks: whData
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/webhook-log', (req, res) => {
  try { res.send(require('fs').readFileSync('/tmp/webhook.log', 'utf8')); } catch(e) { res.send('No webhook log yet'); }
});
app.get('/last-error', (req, res) => {
  res.json({ lastBypassError: lastBypassError || 'none', cacheLen: cachedVacantUnits.length, lastWebhookHit: lastWebhookHit || 'none', lastClaudeData: lastClaudeData || 'none' });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Al-Imtiaz WhatsApp Bot', timestamp: new Date().toISOString() });
});

// Extract page groups data using existing browser session
app.get('/page-data', async (req, res) => {
  try {
    const mzad = require('./mzad');
    // Try to get session (might reuse existing)
    const session = await mzad.getSession();
    if (!session) return res.json({ error: 'No session' });
    
    // Use getGroupsData which now creates browser if needed
    const data = await mzad.getGroupsData(session);
    res.json({ status: 'done', pageData: data });
  } catch(e) {
    res.json({ status: 'error', error: e.message });
  }
});


app.get('/check-subscription', async (req, res) => {
  try {
    const pageData = await mzad.getGroupsData();
    if (pageData.error) return res.status(500).json({ error: pageData.error });
    
    // Also try to navigate to ad-limit page for subscription info
    res.json({
      status: 'done',
      classifiedUserData: pageData.classifiedUserData || null,
      adsSelectedData: pageData.adsSelectedData || null,
      prevData: pageData.prevData || null,
      groups: pageData.groups || null,
      redirectBackData: pageData.redirectBackData || null,
      fullKeys: pageData ? Object.keys(pageData) : []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/account-status', async (req, res) => {
  try {
    const data = await mzad.getAccountStatus();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Manual OTP login (2-phase) ──
app.get('/mzad-send-otp', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const result = await mzad.sendOtpOnly();
    res.json(result);
  } catch (e) {
    logError(e);
    res.json({ error: e.message, stack: e.stack });
  }
});

app.get('/mzad-verify-otp', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.json({ error: 'Missing ?code=XXXXXX parameter' });
    const mzad = require('./mzad');
    const result = await mzad.verifyOtpOnly(code);
    res.json(result);
  } catch (e) {
    logError(e);
    res.json({ error: e.message, stack: e.stack });
  }
});

app.get('/version', (req, res) => {
  res.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'provider-abstraction-v4',
    deployed: new Date().toISOString(),
    build: 'vacancy-truth-properties-متاح+owner-privacy+no-forcefeed',
    model: CLAUDE_MODEL,
    provider: activeProvider(),
    mode: runMode(),
  });
});



// DELETE all ads from Mzad account (frees up ad slots)
app.get('/delete-all-ads', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page. Login first via /mzad-send-otp + /mzad-verify-otp' });

    // Navigate to My Ads page
    await page.goto('https://www.mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });
    const pageUrl = page.url();
    if (pageUrl.includes('/login')) return res.json({ error: 'Session expired - redirected to login' });

    // Extract ads from Inertia page data
    const adsData = await page.evaluate(() => {
      try {
        const el = document.querySelector('[data-page]');
        if (!el) return { error: 'no data-page' };
        const pd = JSON.parse(el.getAttribute('data-page'));
        const propsKeys = Object.keys(pd.props || {});
        let myProds = []; let foundKey = 'none';
        for (const key of propsKeys) { const val = pd.props[key]; if (val && typeof val === 'object') { if (Array.isArray(val.data) && val.data.length > 0) { myProds = val.data; foundKey = key + '.data'; break; } if (Array.isArray(val) && val.length > 0 && val[0] && val[0].productId) { myProds = val; foundKey = key; break; } } }
        return {
          component: pd.component, propsKeys, foundKey,
          totalAds: myProds.length,
          ads: myProds.map(a => ({
            id: a.productId || a.id,
            title: a.productName || a.productNameEnglish || '',
            price: a.productPrice || '',
            status: a.status,
            slug: a.productSlug || a.slug || '',
          })),
          rawPropsPreview: JSON.stringify(pd.props).substring(0, 2000)
        };
      } catch(e) { return { error: e.message }; }
    });

    if (adsData.error) return res.json({ error: adsData.error });
    if (!adsData.ads || adsData.ads.length === 0) return res.json({ status: 'no_ads', debug: { component: adsData.component, propsKeys: adsData.propsKeys, foundKey: adsData.foundKey, rawPreview: adsData.rawPropsPreview } });

    console.log('[delete-all-ads] Found', adsData.ads.length, 'ads:', JSON.stringify(adsData.ads));

    // Delete each ad
    const results = [];
    for (const ad of adsData.ads) {
      try {
        // Get XSRF token from cookies
        const cookies = await page.cookies();
        let xsrf = '';
        for (const c of cookies) { if (c.name === 'XSRF-TOKEN') xsrf = decodeURIComponent(c.value); }

        const delResult = await page.evaluate(async (adId, csrfToken) => {
          try {
            const res = await fetch('https://www.mzadqatar.com/en/delete_advertise/' + adId, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': csrfToken,
                'Accept': 'application/json',
              },
              body: JSON.stringify({ _method: 'DELETE' }),
              credentials: 'include',
            });
            const text = await res.text();
            return { status: res.status, body: text.substring(0, 500) };
          } catch(e) { return { error: e.message }; }
        }, ad.id, xsrf);

        console.log('[delete-all-ads] Delete ad', ad.id, ':', JSON.stringify(delResult));
        results.push({ id: ad.id, title: ad.title, ...delResult });
      } catch(e) {
        results.push({ id: ad.id, title: ad.title, error: e.message });
      }
    }

    // Navigate back to add_advertise for future operations
    await page.goto('https://www.mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });

    res.json({ status: 'done', adsFound: adsData.ads.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// DELETE a specific ad by navigating to it and using Inertia delete
app.get('/delete-ad', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page' });
    const adId = req.query.id;
    if (!adId) return res.status(400).json({ error: 'Missing ?id=XXXXX' });

    // Navigate to My Ads first
    await page.goto('https://www.mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });

    // Try approach 1: Inertia router delete
    const result = await page.evaluate(async (adId) => {
      try {
        // Get XSRF from cookie
        const cookies = document.cookie.split(';');
        let xsrf = '';
        for (const c of cookies) {
          const [k,v] = c.trim().split('=');
          if (k === 'XSRF-TOKEN') xsrf = decodeURIComponent(v);
        }

        // Try multiple delete URL patterns
        const urls = [
          'https://www.mzadqatar.com/en/delete_advertise/' + adId,
          'https://www.mzadqatar.com/delete_advertise/' + adId,
          'https://www.mzadqatar.com/en/user/delete_advertise/' + adId,
        ];
        const results = [];
        for (const url of urls) {
          try {
            const r = await fetch(url, {
              method: 'DELETE',
              headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': xsrf,
                'X-Inertia': 'true',
                'Accept': 'text/html, application/xhtml+xml',
              },
              credentials: 'include',
            });
            const t = await r.text();
            results.push({ url, status: r.status, body: t.substring(0,300) });
          } catch(e) {
            results.push({ url, error: e.message });
          }
        }

        // Also try POST with _method DELETE
        try {
          const r2 = await fetch('https://www.mzadqatar.com/en/delete_advertise/' + adId, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'X-XSRF-TOKEN': xsrf,
              'X-Inertia': 'true',
              'Accept': 'text/html, application/xhtml+xml',
            },
            body: JSON.stringify({ _method: 'DELETE' }),
            credentials: 'include',
          });
          const t2 = await r2.text();
          results.push({ url: 'POST+DELETE_METHOD', status: r2.status, body: t2.substring(0,300) });
        } catch(e) {
          results.push({ url: 'POST+DELETE_METHOD', error: e.message });
        }

        return { xsrf: xsrf ? 'present' : 'missing', results };
      } catch(e) { return { error: e.message }; }
    }, adId);

    // Navigate back to add_advertise
    await page.goto('https://www.mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });

    res.json({ status: 'done', adId, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// Diagnostic: navigate to ad page, find and click delete button
app.get('/delete-ad-ui', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page' });
    const slug = req.query.slug || 'i-need-one-94313102';

    // Navigate to the actual ad page
    await page.goto('https://www.mzadqatar.com/en/products/' + slug, { waitUntil: 'networkidle2', timeout: 30000 });
    const pageUrl = page.url();

    // Extract Inertia page data and find delete mechanism
    const pageData = await page.evaluate(() => {
      const el = document.querySelector('[data-page]');
      if (!el) return { error: 'no data-page' };
      const pd = JSON.parse(el.getAttribute('data-page'));
      const props = pd.props || {};
      // Look for product data with delete info
      const keys = Object.keys(props);
      let productData = null;
      for (const k of keys) {
        if (props[k] && (props[k].productId || props[k].id)) {
          productData = { key: k, id: props[k].productId || props[k].id };
          break;
        }
      }
      // Look for delete buttons/links in DOM
      const deleteEls = [];
      document.querySelectorAll('button, a, [onclick]').forEach(el => {
        const text = el.textContent || '';
        const onclick = el.getAttribute('onclick') || '';
        const href = el.getAttribute('href') || '';
        if (text.toLowerCase().includes('delete') || onclick.includes('delete') || href.includes('delete')) {
          deleteEls.push({ tag: el.tagName, text: text.trim().substring(0,50), href, onclick: onclick.substring(0,100) });
        }
      });
      return {
        component: pd.component,
        propsKeys: keys,
        productData,
        deleteElements: deleteEls,
        isOwner: props.isOwner || props.isMyProduct || props.getProductData?.isOwner || 'unknown',
        rawSnippet: JSON.stringify(pd.props).substring(0, 1500)
      };
    });

    // Also test if fetch works at all from this page
    const fetchTest = await page.evaluate(async () => {
      try {
        const r = await fetch('/en/user/profile/myads', { credentials: 'include' });
        return { fetchWorks: true, status: r.status };
      } catch(e) { return { fetchWorks: false, error: e.message }; }
    });

    res.json({ pageUrl, pageData, fetchTest });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0,500) });
  }
});


// Ultimate delete: navigate to ad page (where fetch proven working), try every delete approach
app.get('/nuke-ad', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page' });
    const slug = req.query.slug || 'i-need-one-94313102';
    const adId = req.query.id || '94313102';

    // Navigate to the ad page (diagnostic proved fetch works here)
    await page.goto('https://mzadqatar.com/en/products/' + slug, { waitUntil: 'networkidle2', timeout: 30000 });
    const currentUrl = page.url();

    const result = await page.evaluate(async (adId) => {
      const results = [];
      // Get cookies
      const cookies = document.cookie.split(';');
      let xsrf = '';
      for (const ck of cookies) { const [k,v] = ck.trim().split('='); if (k === 'XSRF-TOKEN') xsrf = decodeURIComponent(v); }
      let csrfMeta = '';
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) csrfMeta = meta.content;

      // Test 1: simple GET to the delete URL
      try {
        const r = await fetch('/en/delete_advertise/' + adId, { credentials: 'include' });
        results.push({ test: 'GET', status: r.status, body: (await r.text()).substring(0,200) });
      } catch(e) { results.push({ test: 'GET', err: e.message }); }

      // Test 2: POST with form data and _token
      try {
        const fd = new FormData();
        fd.append('_method', 'DELETE');
        if (csrfMeta) fd.append('_token', csrfMeta);
        const r = await fetch('/en/delete_advertise/' + adId, { method: 'POST', body: fd, credentials: 'include' });
        results.push({ test: 'POST-FormData', status: r.status, body: (await r.text()).substring(0,200) });
      } catch(e) { results.push({ test: 'POST-FormData', err: e.message }); }

      // Test 3: POST JSON with XSRF
      try {
        const r = await fetch('/en/delete_advertise/' + adId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ _method: 'DELETE' }),
          credentials: 'include'
        });
        results.push({ test: 'POST-JSON-XSRF', status: r.status, body: (await r.text()).substring(0,200) });
      } catch(e) { results.push({ test: 'POST-JSON-XSRF', err: e.message }); }

      // Test 4: Inertia-style POST
      try {
        const r = await fetch('/en/delete_advertise/' + adId, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-XSRF-TOKEN': xsrf,
            'X-Inertia': 'true',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/html, application/xhtml+xml'
          },
          body: JSON.stringify({ _method: 'DELETE' }),
          credentials: 'include'
        });
        results.push({ test: 'POST-Inertia', status: r.status, body: (await r.text()).substring(0,200) });
      } catch(e) { results.push({ test: 'POST-Inertia', err: e.message }); }

      // Test 5: XHR approach
      try {
        const xhrRes = await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/en/delete_advertise/' + adId, true);
          xhr.setRequestHeader('X-XSRF-TOKEN', xsrf);
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText.substring(0,200) });
          xhr.onerror = () => resolve({ err: 'xhr_network_error' });
          const fd = new FormData();
          fd.append('_method', 'DELETE');
          if (csrfMeta) fd.append('_token', csrfMeta);
          xhr.send(fd);
        });
        results.push({ test: 'XHR-FormData', ...xhrRes });
      } catch(e) { results.push({ test: 'XHR-FormData', err: e.message }); }

      return { xsrf: xsrf ? xsrf.substring(0,20) + '...' : 'MISSING', csrfMeta: csrfMeta ? 'present' : 'MISSING', results };
    }, adId);

    // Navigate back to add_advertise
    await page.goto('https://mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });

    res.json({ currentUrl, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// Extract full product data to find internal ID
app.get('/get-ad-info', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No browser page' });
    const slug = req.query.slug || 'i-need-one-94313102';
    await page.goto('https://mzadqatar.com/en/products/' + slug, { waitUntil: 'networkidle2', timeout: 30000 });
    const data = await page.evaluate(() => {
      const el = document.querySelector('[data-page]');
      if (!el) return { error: 'no data-page' };
      const pd = JSON.parse(el.getAttribute('data-page'));
      const ads = pd.props?.ads;
      const adsJSON = JSON.stringify(ads).substring(0, 3000);
      // Find all IDs in the page
      const allIDs = {};
      for (const [key, val] of Object.entries(pd.props || {})) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          if (val.id || val.productId) allIDs[key] = { id: val.id, productId: val.productId };
        }
      }
      return { component: pd.component, adsType: typeof ads, adsIsArray: Array.isArray(ads), adsJSON, allIDs };
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST a specific vacant unit from the properties sheet
app.get('/post-vacant', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });

    const unit = req.query.unit; // e.g., P26, P48, P49
    if (!unit) return res.status(400).json({ error: 'Missing ?unit=P26 parameter' });

    // Vacant properties data (from March 2026 report + Google Sheet)
    const vacantProperties = {
      'P26': { Unit: 'P26', Type: 'Labor Camp', Location: 'سكن عمال الصناعية 24', Rent_QAR: '', Maps_Link: 'https://maps.app.goo.gl/bsVeGSo9JQwpH4kY8', Notes: 'Remaining room to be rented' },
      'P48': { Unit: 'P48', Type: 'Commercial', Location: 'شقة - تم إرجاعها', Rent_QAR: '', Maps_Link: '', Notes: 'Apartment returned' },
      'P49': { Unit: 'P49', Type: 'Commercial', Location: 'غرفة شاغرة', Rent_QAR: '', Maps_Link: '', Notes: 'Room vacant - searching for new tenant' },
      'P6A': { Unit: 'P6A', Type: 'Warehouse', Location: 'مخزن بركة العوامر', Rent_QAR: '', Maps_Link: 'https://goo.gl/maps/opk6AP9dXuW8WZeE8', Notes: 'Payment not received' },
    };

    const prop = vacantProperties[unit.toUpperCase()];
    if (!prop) return res.status(400).json({ error: 'Unknown unit: ' + unit, available: Object.keys(vacantProperties) });

    // Override to category 9 (Others - free category)
    // prop._overrideCategory = 9; // disabled - try real category first

    console.log('[post-vacant] Posting unit', unit, ':', JSON.stringify(prop));

    // Pre-delete: navigate to My Ads and use form submission to delete
    const page = mzad._getPage ? mzad._getPage() : null;
    if (page) {
      try {
        // Navigate to My Ads page
        await page.goto('https://mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });
        // Try to delete via hidden form submission (like Laravel/Inertia does)
        const delRes = await page.evaluate(async () => {
          const knownIds = [94313102];
          const results = [];
          for (const id of knownIds) {
            try {
              // Create a hidden form like Inertia does
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = '/en/delete_advertise/' + id;
              form.style.display = 'none';
              // Add CSRF token
              const meta = document.querySelector('meta[name="csrf-token"]');
              if (meta) {
                const csrf = document.createElement('input');
                csrf.type = 'hidden'; csrf.name = '_token'; csrf.value = meta.content;
                form.appendChild(csrf);
              }
              // Add _method DELETE
              const method = document.createElement('input');
              method.type = 'hidden'; method.name = '_method'; method.value = 'DELETE';
              form.appendChild(method);
              document.body.appendChild(form);
              // Use XMLHttpRequest instead of fetch
              const xhr = new XMLHttpRequest();
              xhr.open('POST', '/en/delete_advertise/' + id, true);
              const formData = new FormData(form);
              const xhrResult = await new Promise((resolve) => {
                xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText.substring(0, 300) });
                xhr.onerror = (e) => resolve({ error: 'xhr_error', msg: e.type });
                xhr.send(formData);
              });
              document.body.removeChild(form);
              results.push({ id, ...xhrResult });
            } catch(e) { results.push({ id, err: e.message }); }
          }
          return results;
        });
        console.log('[post-vacant] Pre-delete result:', JSON.stringify(delRes));
      } catch(e) { console.log('[post-vacant] Pre-delete error:', e.message); }
    }

    const result = await mzad.postAd(prop, session);
    res.json({ status: 'done', unit, result });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: 'v4-provider-abstraction',
    model: CLAUDE_MODEL,
    provider: activeProvider(),
    mode: runMode(),                                  // "production" | "sandbox"
    cache: cachedVacantUnits.length,
    lastInboundWebhookAt: botState.lastInboundAt,
    lastInbound: botState.lastInbound,
    lastOutboundDelivery: botState.lastOutboundDelivery,
    lastSuccess: botState.lastSuccess,                // { rule, claude } timestamps
    lastClaudeError: botState.lastClaudeError,        // {kind,status,message,at} or null
    lastAlert: botState.lastAlert,
    ledgerSize: deliveryLedger.size,
    startedAt: botState.startedAt,
  });
});

// Recent delivery ledger entries (debug / verification)
app.get('/ledger', (req, res) => {
  const items = Array.from(deliveryLedger.entries()).slice(-50).map(([id, rec]) => ({ id, ...rec }));
  res.json({ count: deliveryLedger.size, items });
});

// === SELFTEST: prove the whole engine headlessly (no phone / WhatsApp Web) ===
// Exercises BOTH the rule path and the Claude path end-to-end through the same
// shared business logic the live webhooks use. This is the test trap guard:
// it does NOT pass on the 47-unit reply alone — the Claude path must produce a
// real reply, not the fallback.
async function runSelftestMatrix() {
  const results = [];
  const FB = getConfig('FALLBACK_MESSAGE') || ARABIC_FALLBACK;
  async function run(test, fn, assertFn) {
    const t0 = Date.now();
    try {
      const out = await fn();
      const v = assertFn(out);
      results.push({ test, status: v.pass ? 'pass' : 'fail', detail: v.detail, latency: Date.now() - t0 });
    } catch (e) {
      const c = classifyError(e);
      results.push({ test, status: 'fail', detail: c.kind + ': ' + c.message, latency: Date.now() - t0 });
    }
  }
  const P = 'selftest_' + Date.now() + '_';
  // Rule path
  await run('rule:vacant-units', () => generateReply('وحدات شاغرة', P + 'rule'),
    r => ({ pass: r.path === 'rule' && /[0-9٠-٩]/.test(r.reply), detail: 'path=' + r.path + ' len=' + r.reply.length }));
  // Claude path (Arabic greeting) — the exact case that was broken
  await run('claude:greeting-ar', () => generateReply('مرحبا', P + 'gar'),
    r => ({ pass: r.path === 'claude' && !r.errorKind && r.reply && r.reply !== FB, detail: (r.errorKind ? 'ERR ' + r.errorKind : 'ok') + ' :: ' + r.reply.substring(0, 90) }));
  // Claude path (Arabic identity)
  await run('claude:identity-ar', () => generateReply('من انت', P + 'idar'),
    r => ({ pass: r.path === 'claude' && !r.errorKind && r.reply !== FB, detail: (r.errorKind || 'ok') + ' :: ' + r.reply.substring(0, 90) }));
  // Claude path (English)
  await run('claude:greeting-en', () => generateReply('hello', P + 'gen'),
    r => ({ pass: r.path === 'claude' && !r.errorKind && /[a-zA-Z]/.test(r.reply) && r.reply !== FB, detail: (r.errorKind || 'ok') + ' :: ' + r.reply.substring(0, 90) }));
  // Direct Claude credential probe (classifies auth/quota/model distinctly)
  await run('claude:credential', async () => {
    const resp = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'ping' }] });
    return resp.content[0].text;
  }, r => ({ pass: !!r, detail: 'model=' + CLAUDE_MODEL + ' reply=' + String(r).substring(0, 40) }));
  // Meta provider readiness (config present so production migration can flip on)
  await run('meta:config-ready', async () => ({ token: !!getConfig('META_ACCESS_TOKEN'), pid: !!getConfig('META_PHONE_NUMBER_ID'), verify: getConfig('META_VERIFY_TOKEN') || DEFAULT_VERIFY_TOKEN }),
    r => ({ pass: r.token && r.pid, detail: 'access_token=' + r.token + ' phone_number_id=' + r.pid + ' verify_token=' + r.verify }));
  return results;
}

app.post('/selftest', async (req, res) => {
  const expected = process.env.SELFTEST_SECRET || getConfig('SELFTEST_SECRET');
  const provided = req.get('x-selftest-secret') || (req.query && req.query.secret) || (req.body && req.body.secret);
  if (!expected) return res.status(503).json({ error: 'SELFTEST_SECRET not configured in env' });
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });
  const results = await runSelftestMatrix();
  const ok = results.every(r => r.status === 'pass');
  if (!ok) maybeAlert('selftest-failed', 'SELFTEST failures: ' + results.filter(r => r.status !== 'pass').map(r => r.test + '(' + r.detail + ')').join(' | '));
  res.json({ ok, mode: runMode(), provider: activeProvider(), model: CLAUDE_MODEL, ranAt: new Date().toISOString(), results });
});

// CATCH-ALL: Log ANY unmatched POST
app.use((req, res, next) => { if (req.method !== 'POST') return next();
  const log = new Date().toISOString() + ' | UNMATCHED | PATH:' + req.path + ' | KEYS:' + Object.keys(req.body||{}).join(',') + '\n';
  console.log('[UNMATCHED POST]', req.path);
  try { require('fs').appendFileSync('/tmp/webhook.log', log); } catch(e) {}
  res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;

// ── DELETE AD VIA UI CLICK (diagnostic) ──
app.get('/delete-ad-ui-click', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    
    await page.goto('https://mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Get page HTML
    const html = await page.content();
    
    // Extract all links
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        text: (a.textContent || '').trim().substring(0, 100),
        href: a.getAttribute('href') || '',
        classes: a.className || ''
      })).filter(l => l.href || l.text);
    });
    
    // Look for delete-related elements
    const deleteElements = await page.evaluate(() => {
      const all = document.querySelectorAll('a, button, [onclick], [data-action]');
      const results = [];
      all.forEach(el => {
        const text = (el.textContent || '').toLowerCase();
        const html = el.outerHTML || '';
        if (text.includes('delete') || text.includes('حذف') || text.includes('remove') || 
            html.includes('delete') || html.includes('trash') || html.includes('remove')) {
          results.push({
            tag: el.tagName,
            text: (el.textContent || '').trim().substring(0, 200),
            href: el.getAttribute('href') || '',
            onclick: el.getAttribute('onclick') || '',
            outerHTML: el.outerHTML.substring(0, 500)
          });
        }
      });
      return results;
    });
    
    // Get Inertia data
    const inertiaData = await page.evaluate(() => {
      try {
        const appEl = document.getElementById('app');
        if (!appEl || !appEl.dataset.page) return { error: 'no app element or dataset.page' };
        const pd = JSON.parse(appEl.dataset.page);
        const propsKeys = Object.keys(pd.props || {});
        let adsData = null;
        let adsKey = 'none';
        for (const key of propsKeys) {
          const val = pd.props[key];
          if (val && typeof val === 'object') {
            if (Array.isArray(val)) {
              adsData = val.slice(0, 5);
              adsKey = key + ' (array)';
              break;
            }
            if (val.data && Array.isArray(val.data)) {
              adsData = val.data.slice(0, 5);
              adsKey = key + '.data';
              break;
            }
          }
        }
        return {
          component: pd.component,
          url: pd.url,
          propsKeys: propsKeys,
          adsKey: adsKey,
          adsData: adsData,
          propsPreview: JSON.stringify(pd.props).substring(0, 2000)
        };
      } catch(e) {
        return { error: e.message };
      }
    });
    
    // Also check for any product cards or ad listings
    const adCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('.product-card, .ad-card, .my-ad, [class*="product"], [class*="advert"]');
      return Array.from(cards).slice(0, 10).map(c => ({
        classes: c.className,
        text: (c.textContent || '').trim().substring(0, 200),
        html: c.outerHTML.substring(0, 500)
      }));
    });
    
    res.json({
      html_length: html.length,
      links_count: links.length,
      links: links.slice(0, 50),
      deleteElements: deleteElements,
      inertiaData: inertiaData,
      adCards: adCards
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});




// ── CLICK DELETE ALL ADS ──
app.get('/click-delete-all', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    
    await page.goto('https://mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Find all delete buttons (with deletead.svg icon, not share.svg)
    const deleteButtons = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button.delete');
      const deleteOnes = [];
      buttons.forEach((btn, i) => {
        const img = btn.querySelector('img');
        if (img && img.src && img.src.includes('deletead')) {
          deleteOnes.push({ index: i, outerHTML: btn.outerHTML.substring(0, 200) });
        }
      });
      return deleteOnes;
    });
    
    const results = [];
    
    for (let i = 0; i < deleteButtons.length; i++) {
      try {
        // Re-find buttons each time since page may re-render
        const clicked = await page.evaluate((idx) => {
          const buttons = document.querySelectorAll('button.delete');
          let deleteIdx = 0;
          for (let j = 0; j < buttons.length; j++) {
            const img = buttons[j].querySelector('img');
            if (img && img.src && img.src.includes('deletead')) {
              if (deleteIdx === idx) {
                buttons[j].click();
                return { clicked: true, buttonIndex: j };
              }
              deleteIdx++;
            }
          }
          return { clicked: false };
        }, i);
        
        results.push({ step: 'clicked_delete_' + i, ...clicked });
        await new Promise(r => setTimeout(r, 1500));
        
        // Look for confirmation dialog and click the confirm/delete button
        const confirmed = await page.evaluate(() => {
          // Look for modal/dialog with delete confirmation
          const allButtons = document.querySelectorAll('button, a');
          for (const btn of allButtons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'delete' || text === 'حذف' || text === 'confirm' || text === 'yes') {
              // Check if it's in a modal/dialog context
              const parent = btn.closest('.modal, .dialog, .popup, .swal2-container, [class*="modal"], [class*="dialog"], [role="dialog"]');
              if (parent || btn.classList.contains('swal2-confirm') || btn.classList.contains('confirm')) {
                btn.click();
                return { confirmed: true, text: btn.textContent.trim(), tag: btn.tagName };
              }
            }
          }
          // Try swal2 specific buttons
          const swalConfirm = document.querySelector('.swal2-confirm, .swal2-actions button:first-child');
          if (swalConfirm) {
            swalConfirm.click();
            return { confirmed: true, text: swalConfirm.textContent.trim(), method: 'swal2' };
          }
          // Try any visible delete/confirm button
          for (const btn of allButtons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if ((text === 'delete' || text === 'حذف') && btn.offsetParent !== null) {
              btn.click();
              return { confirmed: true, text: btn.textContent.trim(), method: 'visible_delete' };
            }
          }
          return { confirmed: false, visibleButtons: Array.from(allButtons).filter(b => b.offsetParent !== null).map(b => b.textContent.trim().substring(0, 50)).slice(0, 20) };
        });
        
        results.push({ step: 'confirm_' + i, ...confirmed });
        await new Promise(r => setTimeout(r, 2000));
        
      } catch(e) {
        results.push({ step: 'error_' + i, error: e.message });
      }
    }
    
    // Check remaining ads
    await page.goto('https://mzadqatar.com/en/user/profile/myads', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const remaining = await page.evaluate(() => {
      const cards = document.querySelectorAll('.product');
      return Array.from(cards).map(c => (c.textContent || '').trim().substring(0, 100));
    });
    
    res.json({ deleteButtonsFound: deleteButtons.length, results, remainingAds: remaining });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});


// ── FRESH POST (navigate home first to clear cache) ──
app.get('/fresh-post', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    const unit = req.query.unit || 'P49';
    
    // First navigate to homepage to reset any session cache
    await page.goto('https://mzadqatar.com/en', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Check if logged in by looking at page
    const isLoggedIn = await page.evaluate(() => {
      const appEl = document.getElementById('app');
      if (!appEl || !appEl.dataset.page) return false;
      const pd = JSON.parse(appEl.dataset.page);
      return pd.props?.isLoggedIn || false;
    });
    
    if (!isLoggedIn) return res.status(401).json({ error: 'Not logged in' });
    
    // Navigate to add_advertise
    await page.goto('https://mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Extract page state
    const pageState = await page.evaluate(() => {
      const appEl = document.getElementById('app');
      if (!appEl || !appEl.dataset.page) return { error: 'no app data' };
      const pd = JSON.parse(appEl.dataset.page);
      return {
        component: pd.component,
        url: pd.url,
        propsKeys: Object.keys(pd.props || {}),
        errors: pd.props?.errors,
        isLoggedIn: pd.props?.isLoggedIn,
        step: pd.props?.getAddAdvertiseData?.step,
        apiData: pd.props?.getAddAdvertiseData?.apiData ? Object.keys(pd.props.getAddAdvertiseData.apiData) : null
      };
    });
    
    // Now try step1 with category 9 (Others - free)
    const step1Res = await page.evaluate(async () => {
      try {
        const resp = await fetch('/en/add_advertise', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Inertia': 'true',
            'X-Inertia-Version': document.querySelector('meta[name="inertia-version"]')?.content || '',
            'X-XSRF-TOKEN': decodeURIComponent(document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=') || ''),
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/html, application/xhtml+xml'
          },
          body: JSON.stringify({
            step: 1,
            step1Data: { categoryId: 9, lang: 'aren', mzadyUserNumber: '' }
          })
        });
        const data = await resp.json();
        return { status: resp.status, component: data.component, step: data.props?.getAddAdvertiseData?.step, apiDataKeys: data.props?.getAddAdvertiseData?.apiData ? Object.keys(data.props.getAddAdvertiseData.apiData) : null, freeProductId: data.props?.getAddAdvertiseData?.apiData?.freeProductId };
      } catch(e) { return { error: e.message }; }
    });
    
    res.json({ isLoggedIn, pageState, step1Res, unit });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});



// ── CHECK PACKAGES ──
app.get('/check-packages', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    
    // Navigate to ads packages page
    await page.goto('https://mzadqatar.com/en/user/profile/packages', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    const pkgData = await page.evaluate(() => {
      const appEl = document.getElementById('app');
      if (!appEl || !appEl.dataset.page) return { error: 'no app data' };
      const pd = JSON.parse(appEl.dataset.page);
      return {
        component: pd.component,
        url: pd.url,
        propsKeys: Object.keys(pd.props || {}),
        propsPreview: JSON.stringify(pd.props).substring(0, 3000)
      };
    });
    
    // Also get page text
    const pageText = await page.evaluate(() => {
      return document.body?.innerText?.substring(0, 2000) || '';
    });
    
    // Also try account overview
    await page.goto('https://mzadqatar.com/en/user/profile/account-overview', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    const acctData = await page.evaluate(() => {
      const appEl = document.getElementById('app');
      if (!appEl || !appEl.dataset.page) return { error: 'no app data' };
      const pd = JSON.parse(appEl.dataset.page);
      return {
        component: pd.component,
        propsKeys: Object.keys(pd.props || {}),
        propsPreview: JSON.stringify(pd.props).substring(0, 3000)
      };
    });
    
    const acctText = await page.evaluate(() => {
      return document.body?.innerText?.substring(0, 2000) || '';
    });
    
    res.json({ pkgData, pageText: pageText.substring(0, 1000), acctData, acctText: acctText.substring(0, 1000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── TRY DIFFERENT CATEGORY ──
app.get('/try-category', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    const catId = parseInt(req.query.cat || '9');
    
    // Navigate to add_advertise
    await page.goto('https://mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 1 with given category
    const step1 = await page.evaluate(async (cid) => {
      try {
        const xsrf = decodeURIComponent(document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=') || '');
        const resp = await fetch('/en/add_advertise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true', 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, application/xhtml+xml' },
          body: JSON.stringify({ step: 1, step1Data: { categoryId: cid, lang: 'aren', mzadyUserNumber: '' } })
        });
        const d = await resp.json();
        return { status: resp.status, step: d.props?.getAddAdvertiseData?.step, apiKeys: d.props?.getAddAdvertiseData?.apiData ? Object.keys(d.props.getAddAdvertiseData.apiData) : null, freeProductId: d.props?.getAddAdvertiseData?.apiData?.freeProductId };
      } catch(e) { return { error: e.message }; }
    }, catId);
    
    // If step1 went to step 2 (no subcategory needed), try step 3
    // For category 9 (Others), step1 goes directly to step3-ready
    const step3Test = await page.evaluate(async (cid) => {
      try {
        const xsrf = decodeURIComponent(document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=') || '');
        
        // Build minimal step3 form data
        const fd = new FormData();
        fd.append('step', '3');
        fd.append('step1Data[categoryId]', String(cid));
        fd.append('step1Data[lang]', 'aren');
        fd.append('step1Data[mzadyUserNumber]', '');
        fd.append('step3Data[productPrice]', '100');
        fd.append('step3Data[productNameEnglish]', 'Test post');
        fd.append('step3Data[productDescriptionEnglish]', 'Test posting to check free ads limit');
        fd.append('step3Data[productNameArabic]', 'اختبار');
        fd.append('step3Data[productDescriptionArabic]', 'اختبار نشر الاعلان');
        fd.append('step3Data[autoRenew]', '0');
        fd.append('step3Data[agree_commission]', '1');
        
        const resp = await fetch('/en/add_advertise', {
          method: 'POST',
          headers: { 'X-Inertia': 'true', 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, application/xhtml+xml' },
          body: fd
        });
        const d = await resp.json();
        const apiData = d.props?.getAddAdvertiseData?.apiData || {};
        return { status: resp.status, didNotSaved: apiData.didNotSaved, message: apiData.statusMsg || apiData.message, errorType: apiData.errorType, step: d.props?.getAddAdvertiseData?.step };
      } catch(e) { return { error: e.message }; }
    }, catId);
    
    res.json({ catId, step1, step3Test });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── MEGA DIAGNOSTIC + POST VIA UI ──
app.get('/mega-post', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage ? mzad._getPage() : null;
    if (!page) return res.status(500).json({ error: 'No Puppeteer page' });
    const unit = req.query.unit || 'P49';
    const results = {};

    // 1. Check account overview
    try {
      await page.goto('https://mzadqatar.com/en/user/profile/account-overview', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
      results.accountText = await page.evaluate(() => document.body?.innerText?.substring(0, 1500) || '');
      results.accountData = await page.evaluate(() => {
        const el = document.getElementById('app');
        if (!el) return null;
        const pd = JSON.parse(el.dataset.page);
        return { component: pd.component, propsKeys: Object.keys(pd.props || {}), preview: JSON.stringify(pd.props).substring(0, 2000) };
      });
    } catch(e) { results.accountError = e.message; }

    // 2. Check packages page
    try {
      await page.goto('https://mzadqatar.com/en/user/profile/packages', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
      results.packagesText = await page.evaluate(() => document.body?.innerText?.substring(0, 1500) || '');
    } catch(e) { results.packagesError = e.message; }

    // 3. Navigate to add_advertise page via UI
    try {
      await page.goto('https://mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));
      
      // Get the page state and look for category 9 (Others) button
      results.addPageText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
      
      // Click on "Others" category in the UI
      const clickedCat = await page.evaluate(() => {
        // Find all category links/buttons
        const allEls = document.querySelectorAll('a, button, div[class*="category"], div[class*="product"], [data-category-id]');
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (text === 'Others' || text.includes('Others') || el.getAttribute('data-category-id') === '9') {
            el.click();
            return { clicked: true, text: text.substring(0, 50), tag: el.tagName };
          }
        }
        return { clicked: false, count: allEls.length };
      });
      results.clickedCategory = clickedCat;
      await new Promise(r => setTimeout(r, 2000));
      
      // Check new page state after category click
      results.afterCatClick = await page.evaluate(() => {
        const el = document.getElementById('app');
        if (!el) return null;
        const pd = JSON.parse(el.dataset.page);
        const gAAD = pd.props?.getAddAdvertiseData || {};
        return { step: gAAD.step, apiKeys: gAAD.apiData ? Object.keys(gAAD.apiData) : null, freeProductId: gAAD.apiData?.freeProductId, prevStep: gAAD.prevData?.step };
      });
      
      // 4. Try posting directly via the Inertia form with an image
      const postResult = await page.evaluate(async () => {
        try {
          const xsrf = decodeURIComponent(document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=') || '');
          const inertiaVer = document.querySelector('meta[name="inertia-version"]')?.content || '';
          
          // Create a tiny 1x1 pixel JPEG
          const canvas = document.createElement('canvas');
          canvas.width = 100; canvas.height = 100;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#cccccc';
          ctx.fillRect(0, 0, 100, 100);
          ctx.fillStyle = '#333333';
          ctx.font = '12px Arial';
          ctx.fillText('For Rent', 10, 50);
          
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
          const file = new File([blob], 'property.jpg', { type: 'image/jpeg' });
          
          const fd = new FormData();
          fd.append('step', '3');
          fd.append('step1Data[categoryId]', '9');
          fd.append('step1Data[lang]', 'aren');
          fd.append('step1Data[mzadyUserNumber]', '');
          fd.append('step3Data[productPrice]', '100');
          fd.append('step3Data[productNameEnglish]', 'Room for rent Doha');
          fd.append('step3Data[productDescriptionEnglish]', 'Vacant room available for rent in Doha Qatar. Contact for details.');
          fd.append('step3Data[productNameArabic]', 'غرفة للإيجار الدوحة');
          fd.append('step3Data[productDescriptionArabic]', 'غرفة شاغرة للإيجار في الدوحة قطر. تواصل للتفاصيل.');
          fd.append('step3Data[autoRenew]', '0');
          fd.append('step3Data[agree_commission]', '1');
          fd.append('step3Data[images][0][id]', '0');
          fd.append('step3Data[images][0][type]', 'image/jpeg');
          fd.append('step3Data[images][0][url]', '');
          fd.append('step3Data[images][0][tempFile]', file, 'property.jpg');
          
          const resp = await fetch('/en/add_advertise', {
            method: 'POST',
            headers: { 'X-Inertia': 'true', 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, application/xhtml+xml', 'X-Inertia-Version': inertiaVer },
            body: fd
          });
          const d = await resp.json();
          const apiData = d.props?.getAddAdvertiseData?.apiData || {};
          return { status: resp.status, didNotSaved: apiData.didNotSaved, message: apiData.statusMsg || apiData.message, errorType: apiData.errorType, step: d.props?.getAddAdvertiseData?.step, component: d.component, url: d.url, allApiKeys: Object.keys(apiData) };
        } catch(e) { return { error: e.message }; }
      });
      results.postResult = postResult;
      
    } catch(e) { results.addError = e.message; }

    res.json(results);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// Inject session cookies from outside (e.g., from Chrome browser)
app.get('/set-session', (req, res) => {
  const session = req.query.session;
  const xsrf = req.query.xsrf;
  if (!session || !xsrf) return res.json({ error: 'Missing ?session=...&xsrf=... params' });
  process.env.MZAD_SESSION = session;
  process.env.MZAD_XSRF_TOKEN = xsrf;
  res.json({ success: true, message: 'Session injected', sessionLen: session.length, xsrfLen: xsrf.length });
});


// Auto-login: send OTP, wait, read from Gmail, verify - all in one call
app.get('/auto-login', async (req, res) => {
  try {
    const mzad = require('./mzad');
    
    // Step 1: Send OTP
    console.log('[auto-login] Sending OTP...');
    const otpResult = await mzad.sendOtpOnly();
    if (!otpResult.success) {
      return res.json({ step: 'send-otp', error: otpResult.error });
    }
    console.log('[auto-login] OTP sent successfully');
    
    // Step 2: Wait 15 seconds for SMS to arrive
    console.log('[auto-login] Waiting 15s for SMS forwarding...');
    await new Promise(r => setTimeout(r, 15000));
    
    // Step 3: Read OTP from Gmail (try multiple times)
    const gmailOtp = require('./gmail-otp');
    let otpCode = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log('[auto-login] Gmail check attempt', attempt);
      try {
        const gmailResult = await gmailOtp.readOtpFromGmail('mzad', 1, 5000, Date.now() - 300000);
        if (gmailResult) {
          otpCode = gmailResult;
          console.log('[auto-login] OTP found:', otpCode);
          break;
        }
      } catch (e) {
        console.log('[auto-login] Gmail error:', e.message);
      }
      if (attempt < 6) {
        console.log('[auto-login] Waiting 10s before retry...');
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    
    if (!otpCode) {
      return res.json({ step: 'gmail-read', error: 'Could not find OTP in Gmail after 6 attempts' });
    }
    
    // Step 4: Verify OTP immediately
    console.log('[auto-login] Verifying OTP:', otpCode);
    const verifyResult = await mzad.verifyOtpOnly(otpCode);
    
    res.json({ 
      step: 'complete',
      success: verifyResult.success,
      message: verifyResult.message || verifyResult.error,
      otpCode: otpCode
    });
  } catch (e) {
    console.error('[auto-login] Error:', e.message);
    res.status(500).json({ step: 'error', error: e.message });
  }
});

// Post all vacant units in sequence (call after login)
app.get('/post-all-vacant', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const units = ['P49', 'P26', 'P48'];
    const vacantProperties = {
      'P26': { Unit: 'P26', Type: 'Labor Camp', Location: 'سكن عمال الصناعية 24', Rent_QAR: '', Maps_Link: 'https://maps.app.goo.gl/bsVeGSo9JQwpH4kY8', Notes: 'Remaining room to be rented' },
      'P48': { Unit: 'P48', Type: 'Commercial', Location: 'شقة - تم إرجاعها', Rent_QAR: '', Maps_Link: '', Notes: 'Apartment returned' },
      'P49': { Unit: 'P49', Type: 'Commercial', Location: 'غرفة شاغرة', Rent_QAR: '', Maps_Link: '', Notes: 'Room vacant - searching for new tenant' },
    };
    const results = [];
    for (const unit of units) {
      console.log('[post-all] Posting unit', unit);
      try {
        const session = await mzad.getSession();
        if (!session) { results.push({ unit, error: 'No session' }); continue; }
        const result = await mzad.postAd(vacantProperties[unit], session);
        results.push({ unit, success: result.success, method: result.method, adUrl: result.step3?.url });
      } catch (e) {
        results.push({ unit, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════ POST AD VIA BROWSER UI ═══════
app.get('/post-via-ui', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const page = mzad._getPage();
    if (!page) return res.json({ error: 'No browser page. Call /auto-login first.' });

    const unit = req.query.unit || 'P49';
    const catId = parseInt(req.query.cat) || 200; // Default: Job Vacancies (FREE)
    console.log('[UI-Post] Starting UI post for unit', unit, 'cat', catId);

    // Navigate to add_advertise
    await page.goto('https://mzadqatar.com/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });
    const url1 = page.url();
    if (url1.includes('/login')) return res.json({ error: 'Not logged in', url: url1 });
    console.log('[UI-Post] On add_advertise page');

    // Wait for Vue app to mount
    await page.waitForSelector('[data-page]', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 2000));

    // STEP 1: Use Inertia router.post for step 1 (category selection)
    const step1Result = await page.evaluate(async (catId) => {
      return new Promise((resolve) => {
        const app = document.querySelector('#app').__vue_app__;
        if (!app) return resolve({ error: 'No Vue app found' });
        
        // Access the Inertia router
        const router = app.config.globalProperties.$inertia || app.config.globalProperties.$page;
        if (!router) {
          // Try direct Inertia import
          if (typeof window.Inertia !== 'undefined') {
            window.Inertia.post('/en/add_advertise', {
              step: 1,
              step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
            }, {
              preserveState: true,
              preserveScroll: true,
              onSuccess: (page) => resolve({ success: true, url: page.url, component: page.component }),
              onError: (errors) => resolve({ errors }),
            });
          } else {
            return resolve({ error: 'No Inertia router found' });
          }
        } else {
          router.post('/en/add_advertise', {
            step: 1,
            step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
          }, {
            preserveState: true,
            preserveScroll: true,
            onSuccess: (page) => resolve({ success: true, url: page.url, component: page.component }),
            onError: (errors) => resolve({ errors }),
          });
        }
        // Timeout
        setTimeout(() => resolve({ timeout: true }), 15000);
      });
    }, catId);
    console.log('[UI-Post] Step 1 result:', JSON.stringify(step1Result).substring(0, 500));
    
    // Wait for page to update
    await new Promise(r => setTimeout(r, 2000));

    // STEP 2: Submit step 2 via Inertia router
    const step2Result = await page.evaluate(async (catId) => {
      return new Promise((resolve) => {
        const doPost = (poster) => {
          poster.post('/en/add_advertise', {
            step: 2,
            step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
            step2Data: {
              cityId: 3, regionId: '38', numberOfRooms: 3,
              location: '', categoryAdvertiseTypeId: '3',
              furnishedTypeId: 107, properterylevel: 97,
              lands_area: 150, properteryfinishing: 366,
              properterybathrooms: 99, salesref: '',
              rentaltype: 791, subCategoryId: 96,
            },
            step3Data: {},
          }, {
            preserveState: true,
            preserveScroll: true,
            onSuccess: (page) => resolve({ success: true, url: page.url }),
            onError: (errors) => resolve({ errors }),
          });
        };
        
        const app = document.querySelector('#app').__vue_app__;
        const router = app && app.config.globalProperties.$inertia;
        if (router) doPost(router);
        else if (typeof window.Inertia !== 'undefined') doPost(window.Inertia);
        else resolve({ error: 'No router' });
        setTimeout(() => resolve({ timeout: true }), 15000);
      });
    }, catId);
    console.log('[UI-Post] Step 2 result:', JSON.stringify(step2Result).substring(0, 500));
    
    await new Promise(r => setTimeout(r, 2000));

    // STEP 3: Submit with title, description, price, image
    const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');
    const vacantProperties = {
      'P26': { Unit: 'P26', Type: 'Labor Camp', Location: 'Industrial 24 Labor Camp', Rent_QAR: '' },
      'P48': { Unit: 'P48', Type: 'Commercial', Location: 'Returned Apartment', Rent_QAR: '' },
      'P49': { Unit: 'P49', Type: 'Commercial', Location: 'Vacant Room', Rent_QAR: '' },
    };
    const prop = vacantProperties[unit] || vacantProperties['P49'];
    const titleEn = buildTitleEn(prop);
    const titleAr = buildTitleAr(prop);
    const desc = buildDescription(prop);
    const price = parseInt(prop.Rent_QAR) || 5000;

    // Read placeholder image as base64
    const imgPath = require('path').join(__dirname, 'placeholder.jpg');
    let imgB64 = '';
    if (require('fs').existsSync(imgPath)) {
      imgB64 = require('fs').readFileSync(imgPath).toString('base64');
    }

    const step3Result = await page.evaluate(async (catId, titleEn, titleAr, desc, price, imgB64) => {
      return new Promise((resolve) => {
        // Create image blob from base64
        let blob = null;
        if (imgB64) {
          const byteChars = atob(imgB64);
          const byteArr = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
          blob = new Blob([byteArr], { type: 'image/jpeg' });
        }

        const formData = {
          step: 3,
          step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
          step2Data: {
            cityId: 3, regionId: '38', numberOfRooms: 3,
            location: '', categoryAdvertiseTypeId: '3',
            furnishedTypeId: 107, properterylevel: 97,
            lands_area: 150, properteryfinishing: 366,
            properterybathrooms: 99, salesref: '',
            rentaltype: 791, subCategoryId: 96,
          },
          step3Data: {
            productPrice: price,
            productNameEnglish: titleEn,
            productDescriptionEnglish: desc,
            productNameArabic: titleAr,
            productDescriptionArabic: desc,
            productNameArEn: '',
            productDescriptionArEn: '',
            autoRenew: false,
            agree_commission: 1,
            currencyId: 1,
            isResetImages: 0,
            productId: '',
            images: blob ? [{ id: 0, type: 'image/jpeg', url: '', tempFile: blob }] : [],
          },
        };

        const doPost = (poster) => {
          poster.post('/en/add_advertise', formData, {
            forceFormData: true,
            preserveState: false,
            onSuccess: (page) => resolve({ success: true, url: page.url, component: page.component }),
            onError: (errors) => resolve({ errors }),
            onFinish: () => {},
          });
        };

        const app = document.querySelector('#app').__vue_app__;
        const router = app && app.config.globalProperties.$inertia;
        if (router) doPost(router);
        else if (typeof window.Inertia !== 'undefined') doPost(window.Inertia);
        else resolve({ error: 'No router' });
        setTimeout(() => resolve({ timeout: true }), 30000);
      });
    }, catId, titleEn, titleAr, desc, price, imgB64);
    console.log('[UI-Post] Step 3 result:', JSON.stringify(step3Result).substring(0, 1000));

    // Check final URL
    const finalUrl = page.url();
    console.log('[UI-Post] Final URL:', finalUrl);

    res.json({ 
      success: true, unit, catId,
      step1: step1Result, step2: step2Result, step3: step3Result,
      finalUrl 
    });
  } catch (e) {
    console.error('[UI-Post] Error:', e);
    res.json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

app.listen(PORT, () => {
  console.log(`Al-Imtiaz WhatsApp Bot running on port ${PORT}`);

  // Load config (Twilio creds) from Config sheet
  loadConfig().catch(err => console.error('[Config] Startup load failed:', err.message));

  // Run vacancy sync on startup
  syncVacancy().catch(err => console.error('[VacancySync] Startup sync failed:', err.message));

  // Run vacancy sync every hour
  setInterval(() => {
    syncVacancy().catch(err => console.error('[VacancySync] Scheduled sync failed:', err.message));
  }, 60 * 60 * 1000);

  // Start the ad poster scheduler (monthly cron + vacancy change monitor)
  startScheduler();

  // === HEARTBEAT: daily self-test of BOTH paths; email on failure ===
  try {
    const cron = require('node-cron');
    // 06:00 UTC = 09:00 Doha, daily
    cron.schedule('0 6 * * *', async () => {
      console.log('[Heartbeat] Running daily self-test...');
      try {
        const results = await runSelftestMatrix();
        const failed = results.filter(r => r.status !== 'pass');
        if (failed.length) {
          await maybeAlert('heartbeat-failed',
            'Daily heartbeat FAILED for: ' + failed.map(r => r.test + ' [' + r.detail + ']').join(' | ') +
            '\nprovider=' + activeProvider() + ' mode=' + runMode() + ' model=' + CLAUDE_MODEL);
        } else {
          console.log('[Heartbeat] All paths healthy (' + results.length + ' checks)');
        }
      } catch (e) {
        await maybeAlert('heartbeat-error', 'Heartbeat crashed: ' + e.message);
      }
    });
    // === CREDENTIAL EXPIRY: monthly reminder (1st @ 08:00 UTC) ===
    cron.schedule('0 8 1 * *', async () => {
      await maybeAlert('credential-expiry-monthly',
        'Monthly credential review due. Check CREDENTIALS.md for ANTHROPIC_API_KEY, META_ACCESS_TOKEN ' +
        '(60-day tokens expire!), MZAD_SESSION/XSRF, Gmail OAuth refresh token, TWILIO_AUTH_TOKEN. ' +
        'Rotate anything within ~7 days of expiry.');
    });
    console.log('[Heartbeat] Daily self-test + monthly expiry cron scheduled');
  } catch (e) {
    console.error('[Heartbeat] Failed to schedule cron:', e.message);
  }
});
