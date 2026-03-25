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

// Error logging
const logError = (error) => {
  const msg = `[${new Date().toISOString()}] ${error.stack || error}\n`;
  fs.appendFileSync(path.join(__dirname, 'errors.log'), msg);
  console.error(msg);
};

// --- Google Sheets Setup ---
let sheetsClient;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
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

// --- Vacancy Sync (replaces Apps Script dependency) ---
async function syncVacancy() {
  console.log('[VacancySync] Starting sync...');
  const sheets = await getGoogleSheets();

  // Read Properties tab
  const propRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Properties!A1:K1000',
  });
  const propRows = propRes.data.values || [];
  if (propRows.length < 2) {
    console.log('[VacancySync] No properties found');
    return;
  }

  const headers = propRows[0];
  const unitIdx = headers.indexOf('Unit');
  const statusIdx = headers.indexOf('Status');
  const notesIdx = headers.indexOf('Notes') !== -1 ? headers.indexOf('Notes') : headers.indexOf('Location');

  const now = new Date().toISOString();
  const vacancyData = [
    ['Unit', 'Status', 'Property_Name', 'Available_From', 'Updated_At'],
    ...propRows.slice(1).map(row => {
      const unit = row[unitIdx] || '';
      const propStatus = (row[statusIdx] || '').trim().toLowerCase();
      const propertyName = notesIdx >= 0 ? (row[notesIdx] || '') : '';
      // Map property status to vacancy status
      const isVacant = !propStatus || propStatus === 'available' || propStatus === 'vacant';
      return [
        unit,
        isVacant ? 'Vacant' : 'Occupied',
        propertyName,
        isVacant ? now : '',
        now,
      ];
    }),
  ];

  // Ensure Vacancy tab exists
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: 'Vacancy' } } }],
      },
    });
    console.log('[VacancySync] Created Vacancy tab');
  } catch (e) {
    // Tab already exists
  }

  // Clear and write
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Vacancy!A:E',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Vacancy!A1:E' + vacancyData.length,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: vacancyData },
  });

  const vacantCount = vacancyData.slice(1).filter(r => r[1] === 'Vacant').length;
  const totalCount = vacancyData.length - 1;
  console.log(`[VacancySync] Done: ${vacantCount} vacant / ${totalCount} total units`);
  return { vacant: vacantCount, total: totalCount };
}

// --- Property Retrieval (filtered by vacancy) ---
async function getVacantProperties() {
  const sheets = await getGoogleSheets();

  const [propsResponse, vacancyResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Properties!A1:K1000',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Vacancy!A1:E1000',
    }).catch(() => ({ data: { values: [] } })),
  ]);

  const propRows = propsResponse.data.values || [];
  const vacancyRows = vacancyResponse.data.values || [];
  if (propRows.length < 2) return [];

  const vacHeaders = vacancyRows[0] || [];
  const vacUnitIdx = vacHeaders.indexOf('Unit');
  const vacStatusIdx = vacHeaders.indexOf('Status');
  const vacNameIdx = vacHeaders.indexOf('Property_Name');
  const vacancyMap = {};
  vacancyRows.slice(1).forEach(row => {
    const unit = row[vacUnitIdx];
    const status = row[vacStatusIdx];
    const propertyName = vacNameIdx >= 0 ? (row[vacNameIdx] || '') : '';
    if (unit) vacancyMap[unit] = { status, propertyName };
  });

  const propHeaders = propRows[0];
  return propRows.slice(1)
    .map(row => {
      const obj = {};
      propHeaders.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    })
    .map(prop => {
      const vac = vacancyMap[prop.Unit];
      if (vac && vac.propertyName && !prop.Notes) prop.Property_Name = vac.propertyName;
      return prop;
    })
    .filter(prop => {
      const vac = vacancyMap[prop.Unit];
      if (!vac) return true;
      return vac.status === 'Vacant' || vac.status === 'Available';
    });
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

const SYSTEM_PROMPT = `You are a bilingual real estate agent for Al-Imtiaz Wal-Jawada in Qatar.
- Reply in same language as customer (Arabic or English)
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
- Always respond as JSON: {"reply":"...","interested_unit":"...","collected_name":"..."}`;

// Simple in-memory conversation store (keyed by phone number)
const conversations = {};

async function askClaude(phone, userMessage, properties) {
  const propertyData = JSON.stringify(properties, null, 2);

  if (!conversations[phone]) {
    conversations[phone] = [];
  }

  conversations[phone].push({ role: 'user', content: userMessage });

  // Keep only last 10 messages to avoid token limits
  if (conversations[phone].length > 10) {
    conversations[phone] = conversations[phone].slice(-10);
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: `${SYSTEM_PROMPT}\n\nAvailable Properties:\n${propertyData}`,
    messages: conversations[phone],
  });

  const assistantText = response.content[0].text;
  conversations[phone].push({ role: 'assistant', content: assistantText });

  return assistantText;
}

// --- Twilio Conversations Webhook (onMessageAdded POST) ---
app.post('/conversations-webhook', async (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.status(200).send('{}');

  try {
    const eventType = req.body.EventType;
    if (eventType !== 'onMessageAdded') return;

    const conversationSid = req.body.ConversationSid;
    const author = req.body.Author || '';
    const participantSid = req.body.ParticipantSid || '';
    const userMessage = req.body.Body || '';

    // Ignore messages sent by the bot itself (no ParticipantSid = system/bot)
    // Bot messages come without a phone number author
    if (!author || author.startsWith('bot') || !userMessage) return;
    // Skip if this looks like it was sent by us (no ParticipantSid usually means bot message)
    if (!participantSid) return;

    const phone = author.replace('whatsapp:', '').replace(/^\+/, '');

    console.log(`[CONV] ConvSid: ${conversationSid} | From: ${author} | Msg: ${userMessage}`);

    const properties = await getVacantProperties();
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
  try {
    const incomingMsg = req.body.Body || '';
    const from = req.body.From || '';
    const phone = from.replace('whatsapp:', '');

    console.log(`[MSG] From: ${phone} | Message: ${incomingMsg}`);

    // Get only vacant/available properties from Google Sheets
    const properties = await getVacantProperties();

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

    // Send reply via Twilio TwiML
    const twiml = new MessagingResponse();
    twiml.message(replyText);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    logError(error);
    const twiml = new MessagingResponse();
    twiml.message('Sorry, something went wrong. Please try again.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

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

// Debug Mzad step-by-step to diagnose step 3 failure
app.get('/debug-mzad-steps', async (req, res) => {
  try {
    const mzad = require('./mzad');
    const session = await mzad.getSession();
    if (!session) return res.status(500).json({ error: 'No session' });

    const axios = require('axios');
    const BASE_URL = 'https://mzadqatar.com';
    const { session: sess, xsrf, csrfToken, extraCookies } = session;

    // Build cookie string
    const cookies = [`mzadqatar_session=${sess}`, `XSRF-TOKEN=${xsrf}`];
    if (extraCookies) {
      for (const [k, v] of Object.entries(extraCookies)) {
        cookies.push(`${k}=${v}`);
      }
    }

    const decodedXsrf = decodeURIComponent(csrfToken || xsrf);

    // Get Inertia version
    let inertiaVersion = '';
    try {
      const pageRes = await axios.get(`${BASE_URL}/en/add_advertise`, {
        headers: {
          'Cookie': cookies.join('; '),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
        validateStatus: s => s < 500,
      });
      const match = typeof pageRes.data === 'string' && pageRes.data.match(/version&quot;:&quot;([^&]+)&quot;/);
      if (match) inertiaVersion = match[1];
    } catch (e) {}

    const commonHeaders = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'X-Inertia-Version': inertiaVersion,
      'X-XSRF-TOKEN': decodedXsrf,
      'Cookie': cookies.join('; '),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/add_advertise`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html, application/xhtml+xml',
    };

    const step1Data = { categoryId: 8494, lang: 'en', mzadyUserNumber: null };
    const step2Data = {
      cityId: 3, regionId: '30', numberOfRooms: 2, location: '',
      categoryAdvertiseTypeId: '3', furnishedTypeId: 107,
      properterylevel: 346, lands_area: 100, properteryfinishing: 366,
      properterybathrooms: 358, salesref: 'DEBUG-1', rentaltype: 791,
      subCategoryId: 88,
    };

    // Step 1
    const s1 = await axios.post(`${BASE_URL}/en/add_advertise`, {
      step1Data, step2Data: {}, step3Data: { autoRenew: false, currencyId: 1, isResetImages: false }, step: 1,
    }, { headers: commonHeaders, validateStatus: s => s < 600 });

    // Update cookies from step 1
    const sc1 = s1.headers['set-cookie'] || [];
    for (const c of sc1) {
      const m = c.match(/XSRF-TOKEN=([^;]+)/);
      if (m) commonHeaders['X-XSRF-TOKEN'] = decodeURIComponent(m[1]);
      const m2 = c.match(/mzadqatar_session=([^;]+)/);
      if (m2) { /* update session cookie in header */ }
    }
    // Rebuild cookie from set-cookie
    const newCookies = [...cookies];
    for (const c of sc1) {
      const parts = c.split(';')[0].split('=');
      if (parts[0] === 'XSRF-TOKEN' || parts[0] === 'mzadqatar_session') {
        const idx = newCookies.findIndex(ck => ck.startsWith(parts[0] + '='));
        if (idx >= 0) newCookies[idx] = c.split(';')[0];
        else newCookies.push(c.split(';')[0]);
      }
    }
    commonHeaders['Cookie'] = newCookies.join('; ');

    // Step 2
    const s2 = await axios.post(`${BASE_URL}/en/add_advertise`, {
      step1Data, step2Data, step3Data: { autoRenew: false, currencyId: 1, isResetImages: false }, step: 2,
    }, { headers: commonHeaders, validateStatus: s => s < 600 });

    // Update cookies from step 2
    const sc2 = s2.headers['set-cookie'] || [];
    for (const c of sc2) {
      const m = c.match(/XSRF-TOKEN=([^;]+)/);
      if (m) commonHeaders['X-XSRF-TOKEN'] = decodeURIComponent(m[1]);
      const parts = c.split(';')[0].split('=');
      if (parts[0] === 'XSRF-TOKEN' || parts[0] === 'mzadqatar_session') {
        const idx = newCookies.findIndex(ck => ck.startsWith(parts[0] + '='));
        if (idx >= 0) newCookies[idx] = c.split(';')[0];
        else newCookies.push(c.split(';')[0]);
      }
    }
    commonHeaders['Cookie'] = newCookies.join('; ');

    // Get full step 2 response props
    const s2Props = s2.data?.props || {};
    const s2PropsKeys = Object.keys(s2Props);

    // Step 3 attempt - minimal JSON
    const step3Data = {
      title: 'Apartment For Rent Doha',
      description: 'Nice apartment for rent in Doha Qatar. 2 bedrooms, fully finished. Contact us for viewing.',
      price: 5000,
      autoRenew: false,
      currencyId: 1,
      isResetImages: false,
      images: [],
    };

    const s3 = await axios.post(`${BASE_URL}/en/add_advertise`, {
      step1Data, step2Data, step3Data, step: 3,
    }, { headers: commonHeaders, validateStatus: s => s < 600 });

    // Update cookies and try with acceptTerms if first attempt failed
    let s3b = null;
    if (s3.status >= 400) {
      const sc3 = s3.headers['set-cookie'] || [];
      for (const c of sc3) {
        const m = c.match(/XSRF-TOKEN=([^;]+)/);
        if (m) commonHeaders['X-XSRF-TOKEN'] = decodeURIComponent(m[1]);
        const parts = c.split(';')[0].split('=');
        if (parts[0] === 'XSRF-TOKEN' || parts[0] === 'mzadqatar_session') {
          const idx = newCookies.findIndex(ck => ck.startsWith(parts[0] + '='));
          if (idx >= 0) newCookies[idx] = c.split(';')[0];
          else newCookies.push(c.split(';')[0]);
        }
      }
      commonHeaders['Cookie'] = newCookies.join('; ');

      // Try with acceptTerms and title/description in step2Data
      const step2DataV2 = { ...step2Data, title: 'Apartment For Rent Doha', description: 'Nice apartment for rent in Doha. 2BR. Contact us.' };
      const step3DataV2 = { price: 5000, autoRenew: false, currencyId: 1, isResetImages: false, images: [], acceptTerms: true };

      s3b = await axios.post(`${BASE_URL}/en/add_advertise`, {
        step1Data, step2Data: step2DataV2, step3Data: step3DataV2, step: 3,
      }, { headers: commonHeaders, validateStatus: s => s < 600 });
    }

    const s3Data = typeof s3.data === 'string' ? s3.data.substring(0, 1000) : s3.data;
    const s3bData = s3b ? (typeof s3b.data === 'string' ? s3b.data.substring(0, 1000) : s3b.data) : null;

    res.json({
      step1: { status: s1.status },
      step2: {
        status: s2.status,
        propsKeys: s2PropsKeys,
        errors: s2Props.errors,
        getAddAdvertiseData: s2Props.getAddAdvertiseData ? {
          keys: Object.keys(s2Props.getAddAdvertiseData),
          prevData: s2Props.getAddAdvertiseData.prevData,
          isCompleted: s2Props.getAddAdvertiseData.isCompleted,
        } : null,
      },
      step3_attempt1: { status: s3.status, data: s3Data },
      step3_attempt2: s3b ? { status: s3b.status, data: s3bData } : 'skipped',
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Al-Imtiaz WhatsApp Bot', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: 'v3-ad-poster' });
});

const PORT = process.env.PORT || 3000;
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
});
