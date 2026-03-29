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
  res.json({ commit: 'next-push', deployed: new Date().toISOString(), build: 'fix-step2data-from-step1-prevdata' });
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
    prop._overrideCategory = 9;

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
  res.json({ status: 'healthy', version: 'v3-ad-poster' });
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

\n
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

\napp.listen(PORT, () => {
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
