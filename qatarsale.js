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
 *   TWOCAPTCHA_API_KEY – Optional, for reCAPTCHA Enterprise solving
 *
 * API Base: https://production-api.qatarsale.com
 */

const axios = require('axios');

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
// reCAPTCHA solving via 2captcha (optional)
// ─────────────────────────────────────────────
async function solveRecaptchaEnterprise(pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    throw new Error('TWOCAPTCHA_API_KEY not set – cannot solve reCAPTCHA Enterprise');
  }

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

  for (let i = 0; i < 24; i++) { // up to 2 min
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
// Category field definitions
// ─────────────────────────────────────────────
async function getFieldDefinitions(categoryId, token) {
  try {
    const res = await axios.post(
      `${BASE_URL}/api/Products/Mapping`,
      { categoryId },
      { headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` } }
    );
    return res.data;
  } catch (e) {
    console.warn('[QatarSale] Could not fetch field definitions:', e.message);
    return null;
  }
}

function buildDefinitions(mappingData, property) {
  const definitions = [];
  if (!mappingData?.definitions) return definitions;

  for (const def of mappingData.definitions) {
    const name = (def.name || '').toLowerCase();
    let value = null;

    if (name.includes('bedroom') || name.includes('room')) {
      value = property.Bedrooms;
    } else if (name.includes('bathroom')) {
      value = property.Bathrooms;
    } else if (name.includes('floor')) {
      value = property.Floor;
    } else if (name.includes('size') || name.includes('area')) {
      value = property.Size_sqm;
    } else if (name.includes('furnish')) {
      value = 'Unfurnished';
    } else if (name.includes('type') || name.includes('kind')) {
      value = property.Type;
    }

    if (value !== null && value !== undefined && value !== '') {
      // Try to match to definition values if they exist
      if (def.values && def.values.length > 0) {
        const strVal = String(value).toLowerCase();
        const match = def.values.find(v =>
          String(v.name || v.value || '').toLowerCase().includes(strVal) ||
          strVal.includes(String(v.name || v.value || '').toLowerCase())
        );
        if (match) {
          definitions.push({ definitionId: def.id, value: String(match.id || match.value || value) });
        }
      } else {
        definitions.push({ definitionId: def.id, value: String(value) });
      }
    }
  }

  return definitions;
}

// ─────────────────────────────────────────────
// Ad content builders
// ─────────────────────────────────────────────
function buildTitleAr(property) {
  const name = property.Property_Name || property.Unit || '';
  const location = property.Location || 'قطر';
  return `${name} - للإيجار - ${location}`;
}

function buildTitleEn(property) {
  const type = property.Type || 'Property';
  const location = property.Location || 'Qatar';
  return `${type} For Rent - ${location} - Qatar`;
}

function buildDescription(property) {
  const lines = [
    property.Property_Name && `الاسم: ${property.Property_Name}`,
    property.Unit && `رقم الوحدة: ${property.Unit}`,
    property.Type && `النوع: ${property.Type}`,
    property.Size_sqm && `المساحة: ${property.Size_sqm} م²`,
    property.Bedrooms && `غرف النوم: ${property.Bedrooms}`,
    property.Bathrooms && `دورات المياه: ${property.Bathrooms}`,
    property.Floor && `الطابق: ${property.Floor}`,
    property.Location && `الموقع: ${property.Location}`,
    property.Zone && `المنطقة: ${property.Zone}`,
    property.Street && `الشارع: ${property.Street}`,
    property.Building && `المبنى: ${property.Building}`,
    property.Rent_QAR && `الإيجار الشهري: ${property.Rent_QAR} ريال قطري`,
    property.Available_From && `متاح من: ${property.Available_From}`,
    property.Notes && `ملاحظات: ${property.Notes}`,
    '',
    'للاستفسار والتواصل: شركة الامتياز والجودة العقارية | +974 70297066',
  ].filter(v => v !== false && v !== null && v !== undefined);

  return lines.join('\n');
}

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
  const definitions = buildDefinitions(mapping, property);

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
