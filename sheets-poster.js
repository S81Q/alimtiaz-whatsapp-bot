/**
 * sheets-poster.js – Google Sheets operations for the ad poster
 *
 * Reads:  Vacancy tab  → units where Status = Vacant
 *         Properties tab → full property details
 *
 * Writes: Ad_Log tab   → Timestamp | Unit | Platform | Status | Ad_URL | Error
 *
 * Sheet ID: 1IQzdhv7FcD6XQnJJ61uWUvO_tMoaRquH5GOs7bXwTyQ
 *           (override with POSTER_SHEET_ID env var)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID = process.env.POSTER_SHEET_ID
  || process.env.GOOGLE_SHEET_ID
  || '1IQzdhv7FcD6XQnJJ61uWUvO_tMoaRquH5GOs7bXwTyQ';

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────
let _sheetsClient = null;

async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  let credentials;
  const saPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)) {
    credentials = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    throw new Error('No Google service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON env var.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ─────────────────────────────────────────────
// Ensure Ad_Log tab exists with headers
// ─────────────────────────────────────────────
async function ensureAdLogTab(sheets) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: 'Ad_Log' } } }],
      },
    });
    // Write header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Ad_Log!A1:F1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['Timestamp', 'Unit', 'Platform', 'Status', 'Ad_URL', 'Error']],
      },
    });
    console.log('[Sheets] Created Ad_Log tab with headers');
  } catch (e) {
    // Tab already exists – ignore
    if (!e.message?.includes('already exists') && !e.message?.includes('duplicate')) {
      console.warn('[Sheets] ensureAdLogTab warning:', e.message);
    }
  }
}

// ─────────────────────────────────────────────
// Read vacant units with full property details
// ─────────────────────────────────────────────
/**
 * Returns array of property objects where Status = Vacant.
 * Each object has all columns from Properties tab merged with
 * Property_Name from Vacancy tab.
 */
async function getVacantUnits() {
  const sheets = await getSheetsClient();

  const [vacancyRes, propRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Vacancy!A1:E1000',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Properties!A1:O1000', // A–O covers all 15 columns
    }),
  ]);

  const vacRows = vacancyRes.data.values || [];
  const propRows = propRes.data.values || [];

  if (vacRows.length < 2) {
    console.warn('[Sheets] Vacancy tab is empty or missing headers');
    return [];
  }

  // Build vacancy map: unit → { status, propertyName, availableFrom }
  const vacHeaders = vacRows[0];
  const vi = {
    unit: vacHeaders.indexOf('Unit'),
    status: vacHeaders.indexOf('Status'),
    name: vacHeaders.indexOf('Property_Name'),
    from: vacHeaders.indexOf('Available_From'),
  };

  const vacantMap = {}; // unit → { propertyName, availableFrom }
  for (const row of vacRows.slice(1)) {
    const unit = (row[vi.unit] || '').trim();
    const status = (row[vi.status] || '').trim();
    if (unit && status === 'Vacant') {
      vacantMap[unit] = {
        Property_Name: vi.name >= 0 ? (row[vi.name] || '') : '',
        Available_From: vi.from >= 0 ? (row[vi.from] || '') : '',
      };
    }
  }

  if (Object.keys(vacantMap).length === 0) {
    console.log('[Sheets] No vacant units found');
    return [];
  }

  // Build properties list filtered by vacant units
  if (propRows.length < 2) {
    // No properties data – return minimal objects from vacancy
    return Object.entries(vacantMap).map(([unit, vac]) => ({
      Unit: unit,
      ...vac,
    }));
  }

  const propHeaders = propRows[0];

  return propRows.slice(1)
    .map(row => {
      const obj = {};
      propHeaders.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
      return obj;
    })
    .filter(prop => prop.Unit && vacantMap[prop.Unit])
    .map(prop => {
      const vac = vacantMap[prop.Unit];
      // Use Vacancy property name if Properties has none
      if (!prop.Property_Name && vac.Property_Name) prop.Property_Name = vac.Property_Name;
      if (vac.Available_From) prop.Available_From = vac.Available_From;
      return prop;
    });
}

// ─────────────────────────────────────────────
// Log ad result to Ad_Log tab
// ─────────────────────────────────────────────
/**
 * Append a row to Ad_Log tab.
 * @param {Object} params
 * @param {string} params.unit
 * @param {string} params.platform   – 'QatarSale' | 'Mzad'
 * @param {string} params.status     – 'Success' | 'Failed' | 'Skipped'
 * @param {string} [params.adUrl]
 * @param {string} [params.error]
 */
async function logAdResult({ unit, platform, status, adUrl = '', error = '' }) {
  try {
    const sheets = await getSheetsClient();
    await ensureAdLogTab(sheets);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Ad_Log!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          unit || '',
          platform || '',
          status || '',
          adUrl || '',
          error ? String(error).substring(0, 500) : '',
        ]],
      },
    });
  } catch (e) {
    console.error('[Sheets] Error writing to Ad_Log:', e.message);
  }
}

module.exports = { getVacantUnits, logAdResult, ensureAdLogTab, getSheetsClient };
