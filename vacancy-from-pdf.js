/**
 * vacancy-from-pdf.js – Port of the Google Apps Script vacancy detector.
 *
 * Flow (mirrors the original Apps Script):
 *   1. Search Gmail for the latest "rent report" PDF from approved senders.
 *   2. Download the PDF attachment.
 *   3. Send PDF bytes to Claude Vision (claude-sonnet-4) with the same prompt.
 *   4. Parse JSON response → array of vacant units.
 *
 * Public export:
 *   async getVacantUnitsFromPdf({ debug = false } = {}) -> Promise<Array>
 *     Each item: { unit, property, propertyEn, monthlyRent, status }
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY      – Claude API key
 *   - Gmail auth (either):
 *       • GOOGLE_SERVICE_ACCOUNT_JSON with domain-wide delegation + GMAIL_OTP_USER
 *         (or service-account.json on disk)
 *       • GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN
 *   - Optional: REPORT_SENDERS env var — comma-separated override for allowed senders.
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Configuration – preserves Apps Script constants
// ─────────────────────────────────────────────
const DEFAULT_REPORT_SENDERS = [
  'alamtyaz.wa.aljawada@gmail.com',
  'ahmad55513389@hotmail.com',
  'hamo_200639@yahoo.com',
];

const RENT_KEYWORDS = [
  'تقرير الايجارات',
  'كشف الايجارات',
  'الايجارات المحصلة',
  'ايجار',
  'محصل',
  'rent',
  'تحصيل',
];

const EXCLUDE_KEYWORDS = [
  'صور',
  'ايصال',
  'مصروفات',
  'فواتير',
  'expenses',
  'invoice',
  'voucher',
  'summary',
  'صيانة',
];

const GMAIL_USER = process.env.GMAIL_OTP_USER || 'alamtyaz.wa.aljawada@gmail.com';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// ─────────────────────────────────────────────
// Gmail client (re-uses auth pattern from gmail-otp.js)
// ─────────────────────────────────────────────
async function getGmailClient() {
  // OAuth2 path (personal Gmail)
  if (process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_OAUTH_CLIENT_ID,
      process.env.GMAIL_OAUTH_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  // Service account with domain-wide delegation
  let credentials;
  const saPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)) {
    credentials = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    throw new Error('No Gmail credentials available');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: GMAIL_USER,
  });

  return google.gmail({ version: 'v1', auth });
}

// ─────────────────────────────────────────────
// Search queries (mirrors Apps Script)
// ─────────────────────────────────────────────
function buildQueries() {
  const senders = (process.env.REPORT_SENDERS
    ? process.env.REPORT_SENDERS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_REPORT_SENDERS
  );

  const queries = [];
  for (const sender of senders) {
    queries.push(`from:${sender} has:attachment newer_than:60d subject:تقرير الايجارات`);
    queries.push(`from:${sender} has:attachment newer_than:60d subject:الايجارات المحصلة`);
    queries.push(`from:${sender} has:attachment newer_than:60d subject:كشف الايجارات`);
    queries.push(`from:${sender} has:attachment newer_than:60d (subject:ايجار OR subject:محصل)`);
    queries.push(`from:${sender} has:attachment newer_than:60d (subject:ايجار OR subject:تقرير)`);
  }
  // Fallback: sent mail
  queries.push('in:sent has:attachment newer_than:60d subject:تقرير الايجارات');
  queries.push('in:sent has:attachment newer_than:60d subject:كشف الايجارات');
  queries.push('in:sent has:attachment newer_than:60d subject:الايجارات المحصلة');
  return queries;
}

// ─────────────────────────────────────────────
// Gmail helpers
// ─────────────────────────────────────────────
async function searchMessages(gmail, q, maxResults = 20) {
  const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });
  return res.data.messages || [];
}

async function getMessage(gmail, id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

function getHeader(payload, name) {
  const h = (payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function collectAttachments(payload) {
  const out = [];
  function walk(parts) {
    for (const p of parts || []) {
      const filename = p.filename;
      const mime = p.mimeType || '';
      const attId = p.body?.attachmentId;
      const isPdf = mime === 'application/pdf' || (filename && filename.toLowerCase().endsWith('.pdf'));
      if (filename && attId && isPdf) {
        out.push({
          partId: p.partId,
          filename,
          mimeType: mime,
          attachmentId: attId,
          size: p.body?.size || 0,
        });
      }
      if (p.parts) walk(p.parts);
    }
  }
  if (payload?.parts) walk(payload.parts);
  return out;
}

async function downloadAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  // Gmail returns URL-safe base64
  const dataB64 = (res.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(dataB64, 'base64');
}

// ─────────────────────────────────────────────
// Find the most recent rent report PDF (mirrors Apps Script logic)
// ─────────────────────────────────────────────
async function findRentReportPdf({ debug = false } = {}) {
  const gmail = await getGmailClient();
  const queries = buildQueries();

  let latestPdf = null; // { buffer, filename, mimeType, messageId, date }
  let latestDate = 0;

  for (const q of queries) {
    let msgs;
    try {
      msgs = await searchMessages(gmail, q, 20);
    } catch (e) {
      if (debug) console.warn('[VacancyPDF] Search error:', q, '→', e.message);
      continue;
    }
    if (debug) console.log(`[VacancyPDF] "${q.substring(0, 70)}..." → ${msgs.length} msgs`);
    if (!msgs.length) continue;

    for (const m of msgs) {
      const full = await getMessage(gmail, m.id);
      const subject = (getHeader(full.payload, 'Subject') || '').toLowerCase();

      // Subject-level filter
      const subjectIncluded = RENT_KEYWORDS.some(k => subject.includes(k));
      const subjectExcluded = EXCLUDE_KEYWORDS.some(k => subject.includes(k));
      if (subjectExcluded) {
        if (debug) console.log('[VacancyPDF]   Skip excluded subject:', subject);
        continue;
      }

      const attachments = collectAttachments(full.payload);
      if (!attachments.length) continue;

      // Prefer PDFs whose filename contains a rent keyword and no exclude keyword
      let selected = null;
      for (const att of attachments) {
        const name = att.filename.toLowerCase();
        const hasRent = RENT_KEYWORDS.some(k => name.includes(k));
        const excluded = EXCLUDE_KEYWORDS.some(k => name.includes(k));
        if (hasRent && !excluded) { selected = att; break; }
      }

      // Fallback: subject matches → pick largest non-excluded PDF
      if (!selected && subjectIncluded) {
        let biggest = null;
        for (const att of attachments) {
          const name = att.filename.toLowerCase();
          const excluded = EXCLUDE_KEYWORDS.some(k => name.includes(k));
          if (excluded) continue;
          if (!biggest || att.size > biggest.size) biggest = att;
        }
        if (biggest) selected = biggest;
      }

      if (!selected) continue;

      const internalDate = Number(full.internalDate || 0);
      if (internalDate > latestDate) {
        const buffer = await downloadAttachment(gmail, m.id, selected.attachmentId);
        latestDate = internalDate;
        latestPdf = {
          buffer,
          filename: selected.filename,
          mimeType: selected.mimeType || 'application/pdf',
          messageId: m.id,
          date: new Date(internalDate).toISOString(),
          subject: getHeader(full.payload, 'Subject') || '',
        };
        if (debug) console.log('[VacancyPDF]   Candidate:', selected.filename, '| date:', latestPdf.date);
      }
    }
  }

  return latestPdf;
}

// ─────────────────────────────────────────────
// Vacancy prompt (identical to Apps Script)
// ─────────────────────────────────────────────
function getVacancyPrompt() {
  return (
    'Analyze this Arabic rent report. Find ALL vacant/available units for broker advertising.\n' +
    '\n' +
    'A unit is VACANT if ANY of these apply:\n' +
    '1. Remark says شاغر/شاغرة/vacant/empty/البحث عن مؤجر (even if الاستلام = تم)\n' +
    '2. Remark says تم إرجاع or returned or surrendered (even if الاستلام = تم)\n' +
    '3. Received Amount < 50% of Monthly Rent AND remark mentions unrented rooms/will be rented/remaining\n' +
    '4. الاستلام is EMPTY and Received is ZERO and remark has NO bounced check keywords\n' +
    '\n' +
    'EXCLUDE these — they have tenants, NOT vacant:\n' +
    '- Rows with شيك مرتجع or مرتجع or إجراءات قضائية (bounced check disputes)\n' +
    '- Rows with عقد جديد (new contract assigned)\n' +
    '- Rows where الاستلام = نعم/تم AND full rent received AND no vacancy words in remark\n' +
    '\n' +
    'Read the Remarks column on EVERY row. Check all pages.\n' +
    '\n' +
    'Return ONLY a JSON array:\n' +
    '[{"unit": "P49", "property": "غرفة السد", "propertyEn": "Room Al Sadd", "monthlyRent": "QAR 1,100", "status": "شاغرة"}]\n' +
    'If no vacant units: []\n' +
    'JSON only, no other text.'
  );
}

// ─────────────────────────────────────────────
// Claude Vision analysis
// ─────────────────────────────────────────────
async function analyzeWithVision(pdfBuffer) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const base64 = pdfBuffer.toString('base64');
  if (base64.length > 20_000_000) {
    console.warn('[VacancyPDF] PDF too large for Vision API (>20MB base64)');
    return null;
  }

  const resp = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: getVacancyPrompt() },
      ],
    }],
  });

  const text = (resp.content?.[0]?.text) || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('[VacancyPDF] JSON parse failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────
/**
 * Returns vacant units parsed from the most recent rent-report PDF.
 * Objects use the same field names as the Apps Script for continuity:
 *   { unit, property, propertyEn, monthlyRent, status }
 */
async function getVacantUnitsFromPdf(opts = {}) {
  const { debug = false } = opts;

  console.log('[VacancyPDF] Searching Gmail for rent report PDF...');
  const pdf = await findRentReportPdf({ debug });
  if (!pdf) {
    console.warn('[VacancyPDF] No rent-report PDF found in the last 60 days');
    return [];
  }
  console.log(`[VacancyPDF] Using PDF: "${pdf.filename}" (${pdf.buffer.length} bytes) from ${pdf.date}`);

  const units = await analyzeWithVision(pdf.buffer);
  if (!Array.isArray(units)) {
    console.warn('[VacancyPDF] Vision analysis returned no usable result');
    return [];
  }
  console.log(`[VacancyPDF] Claude extracted ${units.length} vacant unit(s)`);
  return units;
}

module.exports = {
  getVacantUnitsFromPdf,
  findRentReportPdf,     // exported for diagnostics
  analyzeWithVision,     // exported for unit tests
};
