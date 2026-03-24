/**
 * qatarsale.js – QatarSale API integration
 *
 * Auth strategy (no reCAPTCHA needed after initial setup):
 *   1. Use QS_JWT_TOKEN if set and not expired
 *   2. Use QS_REFRESH_TOKEN to get a fresh JWT (no reCAPTCHA required)
 *   3. If both fail → fall back to 2captcha login with credentials
 *
 * Environment variables:
 *   QS_JWT_TOKEN       – Bearer JWT (expires after ~24h–1yr)
 *   QS_REFRESH_TOKEN   – Refresh token (long-lived, no reCAPTCHA)
 *   QS_USERNAME        – Login username/phone (default: 6311425554212)
 *   QS_PASSWORD        – Login password (default: CSHW2BT4)
 *   CAPSOLVER_API_KEY  – Optional, for reCAPTCHA Enterprise solving (preferred)
 *   TWOCAPTCHA_API_KEY – Optional, for reCAPTCHA Enterprise solving (fallback)
 *
 * API Base: https://production-api.qatarsale.com
 */

const axios = require('axios');
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

const BASE_URL = 'https://production-api.qatarsale.com';
const QS_RECAPTCHA_SITE_KEY = '6LeDzAYqAAAAADbAVLOP8T-O62zGRuNH4ID3wBWr';

const BASE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Origin': 'https://qatarsale.com',
  'Referer': 'https://qatarsale.com/',
  'X-Tenant-ID': 'Qatarsale',
  'accept-language': 'en',
  'platform': '0',
  'version': '6.11.0',
};

// ─────────────────────────────────────────────
// Category ID mapping (from API capture)
// ─────────────────────────────────────────────
const CATEGORY_MAP = [
  { keywords: ['villa'],          id: 264 },
  { keywords: ['apartment', 'flat', 'room'], id: 265 },
  { keywords: ['building', 'tower', 'compound'], id: 319 },
  { keywords: ['land', 'farm', 'resort'],        id: 320 },
  { keywords: ['warehouse', 'labor camp', 'factory', 'grocery', 'commercial', 'shop', 'office'], id: 317 },
];

function getCategoryId(type) {
  if (!type) return 265;
  const lower = type.toLowerCase();
  for (const { keywords, id } of CATEGORY_MAP) {
    if (keywords.some(k => lower.includes(k))) return id;
  }
  return 265; // Default: Apartments
}

// ─────────────────────────────────────────────
// reCAPTCHA solving via CapSolver / 2captcha
// ─────────────────────────────────────────────
async function solveRecaptchaEnterprise(pageUrl) {
  // Strategy 1: CapSolver (better success rate for reCAPTCHA Enterprise)
  if (process.env.CAPSOLVER_API_KEY) {
    try {
      return await solveWithCapSolver(pageUrl);
    } catch (e) {
      console.warn('[QS CapSolver] Failed:', e.message, '- trying 2captcha...');
    }
  }

  // Strategy 2: 2Captcha (fallback)
  if (process.env.TWOCAPTCHA_API_KEY) {
    return await solveWith2Captcha(pageUrl);
  }

  throw new Error('No captcha solver configured. Set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY');
}

async function solveWithCapSolver(pageUrl) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  console.log('[QS CapSolver] Submitting reCAPTCHA Enterprise task...');
  const createRes = await axios.post('https://api.capsolver.com/createTask', {
    appId: '9E6BC9E4-B5E6-4709-BF81-E6CECF5ED706',
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV3EnterpriseTaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: QS_RECAPTCHA_SITE_KEY,
      pageAction: 'login',
    },
  });

  if (createRes.data.errorId !== 0) {
    throw new Error('CapSolver create failed: ' + (createRes.data.errorDescription || JSON.stringify(createRes.data)));
  }

  const taskId = createRes.data.taskId;
  console.log('[QS CapSolver] Task created:', taskId);

  for (let i = 0; i < 30; i++) {
    await delay(3000);
    const resultRes = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId,
    });
    if (resultRes.data.status === 'ready') {
      console.log('[QS CapSolver] reCAPTCHA Enterprise solved!');
      return resultRes.data.solution.gRecaptchaResponse;
    }
    if (resultRes.data.errorId !== 0) {
      throw new Error('CapSolver error: ' + resultRes.data.errorDescription);
    }
  }
  throw new Error('CapSolver: timeout');
}

async function solveWith2Captcha(pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const submitRes = await axios.post('http://2captcha.com/in.php', null, {
    params: {
      key: apiKey,
      method: 'userrecaptcha',
      googlekey: QS_RECAPTCHA_SITE_KEY,
      pageurl: pageUrl,
      enterprise: 1,
      action: 'login',
      json: 1,
    },
  });

  if (!submitRes.data.request || submitRes.data.status !== 1) {
    throw new Error('2captcha submit failed: ' + JSON.stringify(submitRes.data));
  }

  const taskId = submitRes.data.request;
  console.log('[QS 2captcha] Task submitted:', taskId);

  for (let i = 0; i < 24; i++) {
    await delay(5000);
    const pollRes = await axios.get('http://2captcha.com/res.php', {
      params: { key: apiKey, action: 'get', id: taskId, json: 1 },
    });
    if (pollRes.data.status === 1) {
      console.log('[QS 2captcha] reCAPTCHA solved');
      return pollRes.data.request;
    }
    if (String(pollRes.data.request).startsWith('ERROR')) {
      throw new Error('2captcha error: ' + pollRes.data.request);
    }
  }
  throw new Error('2captcha: timeout waiting for solution');
}

// ─────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────
function isJwtValid(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.exp > Date.now() / 1000 + 300; // 5 min buffer
  } catch {
    return false;
  }
}

async function refreshJwt(refreshToken) {
  console.log('[QatarSale] Refreshing JWT with refresh token...');
  const res = await axios.post(
    `${BASE_URL}/api/Authenticate/RefreshToken`,
    { refreshToken },
    { headers: BASE_HEADERS }
  );
  if (!res.data?.token) throw new Error('Refresh token response missing token');
  // Persist in env for this process lifetime
  process.env.QS_JWT_TOKEN = res.data.token;
  if (res.data.refreshToken) process.env.QS_REFRESH_TOKEN = res.data.refreshToken;
  console.log('[QatarSale] JWT refreshed successfully');
  return res.data.token;
}

async function loginWithCredentials() {
  console.log('[QatarSale] Logging in with credentials + reCAPTCHA...');
  const recaptchaToken = await solveRecaptchaEnterprise('https://qatarsale.com/en/login');

  const res = await axios.post(
    `${BASE_URL}/api/v2/Authenticate/RequestToken`,
    {
      username: process.env.QS_USERNAME || '6311425554212',
      password: process.env.QS_PASSWORD || 'CSHW2BT4',
      authType: 0,
    },
    {
      headers: {
        ...BASE_HEADERS,
        ReCAPTCHAEnterprise: recaptchaToken,
      },
    }
  );

  if (!res.data?.token) throw new Error('Login response missing token');

  process.env.QS_JWT_TOKEN = res.data.token;
  if (res.data.refreshToken) process.env.QS_REFRESH_TOKEN = res.data.refreshToken;
  console.log('[QatarSale] Login successful');
  return res.data.token;
}

/**
 * Get a valid QatarSale JWT token.
 * Tries: stored JWT → refresh token → full login (reCAPTCHA)
 */
async function login() {
  // 1. Try stored JWT
  const storedJwt = process.env.QS_JWT_TOKEN;
  if (storedJwt && isJwtValid(storedJwt)) {
    console.log('[QatarSale] Using stored JWT token');
    return storedJwt;
  }

  // 2. Try refresh token (no reCAPTCHA needed)
  const storedRefresh = process.env.QS_REFRESH_TOKEN;
  if (storedRefresh) {
    try {
      return await refreshJwt(storedRefresh);
    } catch (e) {
      console.warn('[QatarSale] Refresh token failed:', e.message);
    }
  }

  // 3. Full login with reCAPTCHA solving
  return await loginWithCredentials();
}

// ─────────────────────────────────────────────
// Hardcoded definition IDs (from /api/v2/Category/GetCategories)
// cityDefinitionId and addressDefinitionId per category
// ─────────────────────────────────────────────
const CATEGORY_DEFINITIONS = {
  264: { cityDef: 5351, addressDef: 5352 },  // Villas
  265: { cityDef: 5371, addressDef: 5372 },  // Apartments
  317: { cityDef: 6245, addressDef: 6246 },  // Commercial Shops
  318: { cityDef: 6234, addressDef: 6235 },  // Commercial Offices
  319: { cityDef: 6622, addressDef: 6623 },  // Buildings/Towers (parent defs)
  320: { cityDef: 6622, addressDef: 6623 },  // Lands
  321: { cityDef: 6622, addressDef: 6623 },  // Farms & Resorts
};

// City name → definition value ID (QatarSale city IDs)
// Doha is the primary city; fallback to Doha if unknown
const CITY_DEF_VALUES = {
  'doha': '1',
  'al wakra': '2',
  'al khor': '3',
  'lusail': '4',
  'dukhan': '5',
  'mesaieed': '6',
  'al shamal': '7',
};

function getCityDefValue(location) {
  if (!location) return '1'; // Doha default
  const lower = location.toLowerCase();
  for (const [city, val] of Object.entries(CITY_DEF_VALUES)) {
    if (lower.includes(city)) return val;
  }
  return '1'; // Default: Doha
}

async function getFieldDefinitions(categoryId, token) {
  // Try the Mapping endpoint first (may return 500 on server side)
  try {
    const res = await axios.post(
      `${BASE_URL}/api/Products/Mapping`,
      { categoryId },
      {
        headers: {
          ...BASE_HEADERS,
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
      }
    );
    if (res.data && res.data.definitions) {
      return res.data;
    }
  } catch (e) {
    console.warn('[QatarSale] Mapping endpoint failed (will use hardcoded defs):', e.response?.status || e.message);
  }
  return null; // Will fall through to hardcoded definitions
}

function buildDefinitions(mappingData, property, categoryId) {
  const definitions = [];

  // If we have mapping data from the API, use it
  if (mappingData?.definitions) {
    for (const def of mappingData.definitions) {
      const name = (def.name || '').toLowerCase();
      let value = null;

      if (name.includes('bedroom') || name.includes('room')) value = property.Bedrooms;
      else if (name.includes('bathroom')) value = property.Bathrooms;
      else if (name.includes('floor')) value = property.Floor;
      else if (name.includes('size') || name.includes('area')) value = property.Size_sqm;
      else if (name.includes('furnish')) value = 'Unfurnished';
      else if (name.includes('city')) value = getCityDefValue(property.Location);
      else if (name.includes('address') || name.includes('location')) value = property.Location || 'Doha';

      if (value !== null && value !== undefined && value !== '') {
        definitions.push({ definitionId: def.id, value: String(value) });
      }
    }
    return definitions;
  }

  // Fallback: use hardcoded definition IDs from GetCategories response
  const catDefs = CATEGORY_DEFINITIONS[categoryId] || CATEGORY_DEFINITIONS[265];
  const cityValue = getCityDefValue(property.Location);
  const address = [property.Zone, property.Street, property.Building, property.Location]
    .filter(Boolean).join(', ') || 'Doha, Qatar';

  definitions.push({ definitionId: catDefs.cityDef, value: cityValue });
  definitions.push({ definitionId: catDefs.addressDef, value: address });

  return definitions;
}

// Ad content builders — imported from poster.js (buildTitleAr, buildTitleEn, buildDescription)

// ─────────────────────────────────────────────
// Main post function
// ─────────────────────────────────────────────
/**
 * Post a property ad on QatarSale.
 * @param {Object} property - Property object from Google Sheets
 * @param {string} token - Valid JWT bearer token
 * @returns {Object} API response with ad ID
 */
async function postAd(property, token) {
  const categoryId = getCategoryId(property.Type);

  // Fetch field definitions for this category
  const mapping = await getFieldDefinitions(categoryId, token);
  const definitions = buildDefinitions(mapping, property, categoryId);

  const body = {
    title: buildTitleAr(property),
    titleEn: buildTitleEn(property),
    description: buildDescription(property),
    price: parseInt(property.Rent_QAR) || 0,
    startPrice: parseInt(property.Rent_QAR) || 0,
    categoryId,
    images: [],
    definitions,
    defValueItems: [],
    location: {
      latitude: 25.2854,
      longitude: 51.5310,
      address: property.Location ? `${property.Location}, Qatar` : 'Doha, Qatar',
    },
  };

  console.log(`[QatarSale] Posting ad for unit ${property.Unit} (category ${categoryId})...`);

  const res = await axios.post(
    `${BASE_URL}/api/Auction/Post?categoryId=${categoryId}&type=1`,
    body,
    { headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` } }
  );

  console.log(`[QatarSale] Ad posted for unit ${property.Unit}. Response:`, JSON.stringify(res.data).substring(0, 200));
  return res.data;
}

module.exports = { login, postAd, getCategoryId };
