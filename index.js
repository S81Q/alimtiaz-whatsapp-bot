require('dotenv').config();
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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

  const now = new Date().toISOString();
  const vacancyData = [
    ['Unit', 'Status', 'Available_From', 'Updated_At'],
    ...propRows.slice(1).map(row => {
      const unit = row[unitIdx] || '';
      const propStatus = (row[statusIdx] || '').trim().toLowerCase();
      // Map property status to vacancy status
      const isVacant = !propStatus || propStatus === 'available' || propStatus === 'vacant';
      return [
        unit,
        isVacant ? 'Vacant' : 'Occupied',
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
    range: 'Vacancy!A:D',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Vacancy!A1:D' + vacancyData.length,
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
      range: 'Vacancy!A1:D1000',
    }).catch(() => ({ data: { values: [] } })),
  ]);

  const propRows = propsResponse.data.values || [];
  const vacancyRows = vacancyResponse.data.values || [];
  if (propRows.length < 2) return [];

  const vacHeaders = vacancyRows[0] || [];
  const vacancyMap = {};
  vacancyRows.slice(1).forEach(row => {
    const unit = row[vacHeaders.indexOf('Unit')];
    const status = row[vacHeaders.indexOf('Status')];
    if (unit) vacancyMap[unit] = status;
  });

  const propHeaders = propRows[0];
  return propRows.slice(1)
    .map(row => {
      const obj = {};
      propHeaders.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    })
    .filter(prop => {
      const status = vacancyMap[prop.Unit];
      return !status || status === 'Vacant' || status === 'Available';
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
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Al-Imtiaz WhatsApp Bot', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: 'v2-vacancy-sync' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Al-Imtiaz WhatsApp Bot running on port ${PORT}`);

  // Run vacancy sync on startup
  syncVacancy().catch(err => console.error('[VacancySync] Startup sync failed:', err.message));

  // Run vacancy sync every hour
  setInterval(() => {
    syncVacancy().catch(err => console.error('[VacancySync] Scheduled sync failed:', err.message));
  }, 60 * 60 * 1000);
});
