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
const VACANCY_SHEET_ID = '1IQzdhv7FcD6XQnJJ61uWUvO_tMoaRquH5GOs7bXwTyQ';

async function getGoogleSheets() {
  if (sheetsClient) return sheetsClient;

  // Try loading from file first, then from env
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

async function getVacancyData() {
  const sheets = await getGoogleSheets();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: VACANCY_SHEET_ID,
      range: 'Vacancy!A1:D',
    });
    const rows = res.data.values;
    if (!rows || rows.length < 2) return {};
    const vacancyMap = {};
    rows.slice(1).forEach(row => {
      const unit = (row[0] || '').toString().trim();
      const status = (row[1] || '').toString().trim();
      if (unit) vacancyMap[unit] = status;
    });
    console.log('[Vacancy] Loaded ' + Object.keys(vacancyMap).length + ' units from Vacancy tab');
    return vacancyMap;
  } catch (err) {
    console.error('[Vacancy] Failed to load vacancy data:', err.message);
    return {};
  }
}

async function getProperties() {
  const sheets = await getGoogleSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Properties!A1:K',
  });
  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  const allProperties = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
  // Load vacancy data and filter to only show VACANT/AVAILABLE units
  const vacancyMap = await getVacancyData();
  if (Object.keys(vacancyMap).length === 0) {
    // If vacancy sheet is empty or unavailable, return all properties
    console.log('[Vacancy] No vacancy data available, returning all properties');
    return allProperties;
  }
  const vacantProperties = allProperties.filter(prop => {
    const unitKey = (prop['Unit'] || prop['unit'] || prop['Unit Number'] || '').toString().trim();
    if (!unitKey) return true; // include if no unit key found
    const status = vacancyMap[unitKey];
    if (!status) return true; // include if not in vacancy sheet
    return status.toLowerCase() === 'vacant' || status.toLowerCase() === 'available';
  });
  console.log('[Vacancy] Filtered: ' + vacantProperties.length + ' vacant out of ' + allProperties.length + ' total');
  return vacantProperties;
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

// --- Twilio WhatsApp Webhook ---
app.post('/webhook', async (req, res) => {
  try {
    const incomingMsg = req.body.Body || '';
    const from = req.body.From || ''; // e.g. whatsapp:+974...
    const phone = from.replace('whatsapp:', '');

    console.log(`[MSG] From: ${phone} | Message: ${incomingMsg}`);

    // Get properties from Google Sheets
    const properties = await getProperties();

    // Ask Claude
    const claudeResponse = await askClaude(phone, incomingMsg, properties);

    // Parse Claude's JSON response
    let parsed;
    try {
      // Try to extract JSON from the response
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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Al-Imtiaz WhatsApp Bot', timestamp: new Date().toISOString() });
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Al-Imtiaz WhatsApp Bot running on port ${PORT}`);
});
