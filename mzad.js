/**
 * mzad.js – Mzad Qatar API integration
 *
 * Auth: Session-based (PHP Laravel + Inertia.js)
 *   1. Restore stored session from env vars
 *   2. If expired → OTP login:
 *      a. GET /en/login → get CSRF + session cookies
 *      b. POST /en/login {phone, recaptchaToken} → trigger OTP
 *      c. Read OTP from Gmail
 *      d. POST /en/login {phone, otp, recaptchaToken} → authenticated session
 *
 * Environment variables:
 *   MZAD_SESSION        – Stored mzadqatar_session cookie value
 *   MZAD_XSRF_TOKEN     – Stored XSRF-TOKEN cookie value
 *   MZAD_PHONE          – Phone number (default: 70297066)
 *   MZAD_PASSWORD       – Account password (preferred login method)
 *   TWOCAPTCHA_API_KEY  – For reCAPTCHA v3 solving (optional)
 *
 * API Base: https://mzadqatar.com
 */

const axios = require('axios');
const FormData = require('form-data');
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

const BASE_URL = 'https://mzadqatar.com';
const MZAD_RECAPTCHA_SITE_KEY = '6Lc-0vApAAAAAFu7_SOXa6yJIDgm6qAl9LY1vYVI';

// ─────────────────────────────────────────────
// Category mapping (from mzadqatar.com Inertia props)
// Residential Properties for Rent = categoryId 8494
// Commercial Properties for Rent  = categoryId 8493
// ─────────────────────────────────────────────
function isCommercialType(type) {
  const lower = (type || '').toLowerCase();
  return ['warehouse', 'shop', 'labor camp', 'factory', 'grocery', 'commercial', 'office'].some(k => lower.includes(k));
}

// Dropdown value IDs (from mzadqatar.com API - filterListValues)
const MZAD_VALUES = {
  cities: { 'Doha': 3, 'Al Khor': 2, 'Al Shamal': 4, 'Lusail': 5, 'Al Wakra': 6, 'Dukhan': 7, 'Mesaieed': 8, 'Al Shahania': 9 },
  furnishing: { 'Semi Furnished': 106, 'Not Furnished': 107, 'Furnished': 105 },
  finishing: { 'Fully Finished': 366, 'Semi-Finished': 367, 'Core & Shell': 368 },
  rentalType: { 'Daily': 790, 'Monthly': 791, 'Yearly': 792 },
  adType: { 'Rent': '3', 'Required': '1', 'Sharing Apartment': '16' },
  subcategory: { 'Apartments': 88, 'Villas': 87, 'Building & Towers': 86, 'Traditional Houses': 89, 'Other property': 90 },
  bathrooms: { '1': 357, '2': 358, '3': 359, '4': 360, '5': 361, '6': 362, '7': 363, '8': 364, 'N/A': 365 },
  levels: { '1': 346, '2': 347, '3': 348, '4': 349, '5': 350, '6': 351, '7': 352, '8': 353, '9': 354, '10': 355, 'N/A': 356 },
  // Common Doha region IDs
  regions: { 'D-Ring': '30', 'C-Ring': '29', 'B-Ring Road': '28', 'West Bay': '18', 'The Pearl': '25', 'Al Sadd': '24', 'Al Wakra': '6' },
};

// ─────────────────────────────────────────────
// reCAPTCHA v3 solving via 2captcha
// ─────────────────────────────────────────────
async function solveRecaptchaV3(action = 'login') {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    console.warn('[Mzad 2captcha] TWOCAPTCHA_API_KEY not set – attempting login without reCAPTCHA token');
    return null;
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    const submitRes = await axios.post('http://2captcha.com/in.php', null, {
      params: {
        key: apiKey,
        method: 'userrecaptcha',
        googlekey: MZAD_RECAPTCHA_SITE_KEY,
        pageurl: `${BASE_URL}/en/login`,
        version: 'v3',
        action,
        score: 0.7,
        json: 1,
      },
    });

    if (submitRes.data.status !== 1) {
      throw new Error('Submit failed: ' + JSON.stringify(submitRes.data));
    }

    const taskId = submitRes.data.request;
    console.log('[Mzad 2captcha] Task submitted:', taskId);

    for (let i = 0; i < 24; i++) {
      await delay(5000);
      const pollRes = await axios.get('http://2captcha.com/res.php', {
        params: { key: apiKey, action: 'get', id: taskId, json: 1 },
      });
      if (pollRes.data.status === 1) {
        console.log('[Mzad 2captcha] reCAPTCHA v3 solved');
        return pollRes.data.request;
      }
      if (String(pollRes.data.request).startsWith('ERROR')) {
        throw new Error('2captcha error: ' + pollRes.data.request);
      }
    }
    throw new Error('2captcha: timeout');
  } catch (e) {
    console.error('[Mzad 2captcha] Error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Cookie utilities
// ─────────────────────────────────────────────
function parseCookies(setCookieHeaders) {
  const result = {};
  for (const cookie of setCookieHeaders || []) {
    const main = cookie.split(';')[0];
    const eqIdx = main.indexOf('=');
    if (eqIdx > 0) {
      const key = main.substring(0, eqIdx).trim();
      const val = main.substring(eqIdx + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

function buildCookieStr(session, xsrf) {
  return `XSRF-TOKEN=${xsrf}; mzadqatar_session=${session}; selectedCountry=QA; currentLang=en`;
}

function decodedXsrf(xsrf) {
  try { return decodeURIComponent(xsrf); } catch { return xsrf; }
}

// ─────────────────────────────────────────────
// Initial page fetch (get fresh CSRF + session)
// ─────────────────────────────────────────────
async function getInitialCookies() {
  console.log('[Mzad] Fetching initial cookies from login page...');
  const res = await axios.get(`${BASE_URL}/en/login`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
    withCredentials: true,
  });

  const cookies = parseCookies(res.headers['set-cookie']);
  const csrfMeta = String(res.data).match(/name="csrf-token"\s+content="([^"]+)"/);

  return {
    session: cookies['mzadqatar_session'] || '',
    xsrf: cookies['XSRF-TOKEN'] || '',
    csrf: csrfMeta ? csrfMeta[1] : decodedXsrf(cookies['XSRF-TOKEN'] || ''),
  };
}

// ─────────────────────────────────────────────
// Check if current session is still valid
// ─────────────────────────────────────────────
async function isSessionValid(session, xsrf) {
  if (!session || !xsrf) return false;
  try {
    const res = await axios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf),
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'X-Inertia-Version': '1',
      },
      maxRedirects: 0,
      validateStatus: s => s < 500,
    });
    return res.status === 200 || res.status === 409;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Login with password
// ─────────────────────────────────────────────
async function loginWithPassword() {
  const password = process.env.MZAD_PASSWORD;
  if (!password) throw new Error('MZAD_PASSWORD not set');

  const phone = process.env.MZAD_PHONE || '70297066';

  // Step 1: Get fresh cookies
  const initial = await getInitialCookies();
  let { session, xsrf, csrf } = initial;

  // Step 2: Solve reCAPTCHA v3
  const recaptchaToken = await solveRecaptchaV3('login');

  console.log('[Mzad] Logging in with password for phone', phone, '...');
  const loginRes = await axios.post(`${BASE_URL}/en/login`, {
    phone,
    password,
    recaptchaToken: recaptchaToken || 'placeholder-token',
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'Cookie': buildCookieStr(session, xsrf),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
    },
    maxRedirects: 0,
    validateStatus: s => s < 500,
  });

  const resCookies = parseCookies(loginRes.headers['set-cookie']);
  const finalSession = resCookies['mzadqatar_session'] || session;
  const finalXsrf = resCookies['XSRF-TOKEN'] || xsrf;
  const finalCsrf = decodedXsrf(finalXsrf);

  console.log('[Mzad] Password login status:', loginRes.status);

  const valid = await isSessionValid(finalSession, finalXsrf);
  if (!valid) throw new Error('Mzad: Password login failed – session not authenticated');

  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;

  console.log('[Mzad] Password login successful! Session established.');
  console.log('[Mzad] Update Railway env vars:');
  console.log(`  MZAD_SESSION=${finalSession.substring(0, 40)}...`);
  console.log(`  MZAD_XSRF_TOKEN=${finalXsrf.substring(0, 40)}...`);

  return { session: finalSession, xsrf: finalXsrf, csrfToken: finalCsrf };
}

// ─────────────────────────────────────────────
// Login with OTP
// ─────────────────────────────────────────────
async function loginWithOtp() {
  const { readOtpFromGmail } = require('./gmail-otp');
  const phone = process.env.MZAD_PHONE || '70297066';

  // Step 1: Get fresh cookies
  const initial = await getInitialCookies();
  let { session, xsrf, csrf } = initial;

  // Step 2: Solve reCAPTCHA v3 for OTP request
  const recaptchaToken1 = await solveRecaptchaV3('login');

  const otpBody = { phone, recaptchaToken: recaptchaToken1 || 'placeholder-token' };

  console.log('[Mzad] Sending OTP request to phone', phone, '...');
  const otpReqRes = await axios.post(`${BASE_URL}/en/login`, otpBody, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': buildCookieStr(xsrf ? encodeURIComponent(csrf) : '', session),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
    },
    validateStatus: s => s < 500,
  });

  // Update cookies from response
  const cookies2 = parseCookies(otpReqRes.headers['set-cookie']);
  if (cookies2['mzadqatar_session']) session = cookies2['mzadqatar_session'];
  if (cookies2['XSRF-TOKEN']) xsrf = cookies2['XSRF-TOKEN'];
  csrf = decodedXsrf(xsrf);

  console.log('[Mzad] OTP request status:', otpReqRes.status);

  // Step 3: Wait for OTP, then read from Gmail
  console.log('[Mzad] Waiting 8s for OTP delivery...');
  await new Promise(r => setTimeout(r, 8000));

  const otp = await readOtpFromGmail('mzad');
  if (!otp) {
    throw new Error('Mzad: Could not retrieve OTP from Gmail. Check Gmail API setup.');
  }

  // Step 4: Solve reCAPTCHA v3 again for OTP verification
  const recaptchaToken2 = await solveRecaptchaV3('login');

  const verifyBody = {
    phone,
    otp,
    recaptchaToken: recaptchaToken2 || 'placeholder-token',
  };

  console.log('[Mzad] Verifying OTP', otp, '...');
  const verifyRes = await axios.post(`${BASE_URL}/en/login`, verifyBody, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'Cookie': buildCookieStr(xsrf, session),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
    },
    maxRedirects: 0,
    validateStatus: s => s < 500,
  });

  const finalCookies = parseCookies(verifyRes.headers['set-cookie']);
  const finalSession = finalCookies['mzadqatar_session'] || session;
  const finalXsrf = finalCookies['XSRF-TOKEN'] || xsrf;
  const finalCsrf = decodedXsrf(finalXsrf);

  // Store for this process and log for Railway env var update
  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;

  console.log('[Mzad] Login successful! Session established.');
  console.log('[Mzad] Update Railway env vars:');
  console.log(`  MZAD_SESSION=${finalSession.substring(0, 40)}...`);
  console.log(`  MZAD_XSRF_TOKEN=${finalXsrf.substring(0, 40)}...`);

  return { session: finalSession, xsrf: finalXsrf, csrfToken: finalCsrf };
}

// ─────────────────────────────────────────────
// Get (or restore) session
// ─────────────────────────────────────────────
async function getSession() {
  const session = process.env.MZAD_SESSION;
  const xsrf = process.env.MZAD_XSRF_TOKEN;

  if (session && xsrf) {
    const valid = await isSessionValid(session, xsrf);
    if (valid) {
      console.log('[Mzad] Stored session is valid');
      return { session, xsrf, csrfToken: decodedXsrf(xsrf) };
    }
    console.log('[Mzad] Stored session expired, re-logging in...');
  } else {
    console.log('[Mzad] No stored session, logging in...');
  }

  if (process.env.MZAD_PASSWORD) {
    try {
      return await loginWithPassword();
    } catch (e) {
      console.warn('[Mzad] Password login failed, falling back to OTP:', e.message);
    }
  }

  return await loginWithOtp();
}

// ─────────────────────────────────────────────
// Fetch Inertia version from the add_advertise page
// ─────────────────────────────────────────────
async function getInertiaVersion(session, xsrf) {
  try {
    const res = await axios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf),
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    });
    const html = String(res.data);
    const dataPageMatch = html.match(/data-page="([^"]+)"/);
    if (dataPageMatch) {
      const pageData = JSON.parse(dataPageMatch[1].replace(/&quot;/g, '"'));
      return pageData.version || '';
    }
    return '';
  } catch (e) {
    console.warn('[Mzad] Could not fetch Inertia version:', e.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// Generate a minimal valid JPEG placeholder image
// ─────────────────────────────────────────────
function generatePlaceholderImage() {
  // Minimal valid 1x1 blue JPEG (smallest possible valid JPEG)
  // Created from hex: SOI + APP0 + DQT + SOF0 + DHT + SOS + image data + EOI
  const hex = 'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc40000ffd9';
  // Use a simple solid-color 2x2 JPEG instead
  // This is a pre-built minimal JPEG that renders as a small blue square
  const jpegBytes = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0xFF, 0xC0, 0x00, 0x0B, 0x08,
    0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F,
    0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00,
    0x00, 0x3F, 0x00, 0x7B, 0x40, 0x1B, 0xFF, 0xD9
  ]);
  return jpegBytes;
}

// ─────────────────────────────────────────────
// Convert nested object to FormData (Inertia-style bracket notation)
// e.g., { step1Data: { categoryId: 8494 } } → step1Data[categoryId] = 8494
// ─────────────────────────────────────────────
function objectToFormData(obj, form, parentKey) {
  form = form || new FormData();
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}[${key}]` : key;
    const value = obj[key];
    if (value === null || value === undefined) {
      form.append(fullKey, '');
    } else if (typeof value === 'boolean') {
      form.append(fullKey, value ? '1' : '0');
    } else if (typeof value === 'object' && !(value instanceof Buffer) && !Array.isArray(value)) {
      objectToFormData(value, form, fullKey);
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (item instanceof Buffer) {
          form.append(`${fullKey}[${idx}]`, item, { filename: 'property.jpg', contentType: 'image/jpeg' });
        } else {
          form.append(`${fullKey}[${idx}]`, item);
        }
      });
    } else {
      form.append(fullKey, String(value));
    }
  }
  return form;
}

// Ad content builders — imported from ad-builders.js

// ─────────────────────────────────────────────
// Main post function (Inertia JSON format)
// ─────────────────────────────────────────────
/**
 * Post a property ad on Mzad Qatar.
 *
 * mzadqatar.com form submission format (reverse-engineered):
 *   POST /en/add_advertise
 *   Content-Type: application/json
 *   Headers: X-Inertia, X-Inertia-Version, X-Requested-With, X-XSRF-TOKEN
 *   Body: { step1Data, step2Data, step3Data, step }
 *
 * Multi-step: step=1 validates step1, step=2 validates step2, step=3 submits the ad
 *
 * @param {Object} property  – Property row from Google Sheets
 * @param {Object} sessionData – { session, xsrf, csrfToken }
 * @returns {Object} Inertia response data
 */
async function postAd(property, sessionData) {
  const { session, xsrf, csrfToken } = sessionData;
  const isComm = isCommercialType(property.Type);

  // Get Inertia version for headers
  const inertiaVersion = await getInertiaVersion(session, xsrf);

  // Determine category ID
  const categoryId = isComm ? 8493 : 8494; // Commercial=8493, Residential=8494

  // Build step data using correct mzadqatar.com field IDs
  const step1Data = {
    categoryId,
    lang: 'en',
    mzadyUserNumber: null,
  };

  // Map property fields to mzadqatar.com dropdown value IDs
  const bedrooms = parseInt(property.Bedrooms) || 2;
  const bathrooms = String(parseInt(property.Bathrooms) || 2);
  const area = parseInt(property.Size_sqm) || 100;
  const floor = String(parseInt(property.Floor) || 1);
  const price = parseInt(property.Rent_QAR) || 0;

  // Determine subcategory based on property type
  let subCategoryId = MZAD_VALUES.subcategory['Apartments']; // Default
  const typeLower = (property.Type || '').toLowerCase();
  if (typeLower.includes('villa')) subCategoryId = MZAD_VALUES.subcategory['Villas'];
  else if (typeLower.includes('building') || typeLower.includes('tower')) subCategoryId = MZAD_VALUES.subcategory['Building & Towers'];

  // Map region name to ID (default D-Ring)
  let regionId = '30'; // D-Ring default
  if (property.Region) {
    const regionEntry = Object.entries(MZAD_VALUES.regions).find(([name]) =>
      property.Region.toLowerCase().includes(name.toLowerCase()));
    if (regionEntry) regionId = regionEntry[1];
  }

  const step2Data = {
    cityId: MZAD_VALUES.cities['Doha'],                  // 3
    regionId,
    numberOfRooms: bedrooms,
    location: property.Maps_Link || '',
    categoryAdvertiseTypeId: MZAD_VALUES.adType['Rent'],  // '3'
    furnishedTypeId: MZAD_VALUES.furnishing['Not Furnished'], // 107
    properterylevel: MZAD_VALUES.levels[floor] || MZAD_VALUES.levels['1'],
    lands_area: area,
    properteryfinishing: MZAD_VALUES.finishing['Fully Finished'], // 366
    properterybathrooms: MZAD_VALUES.bathrooms[bathrooms] || MZAD_VALUES.bathrooms['2'],
    salesref: property.Unit || '',
    rentaltype: MZAD_VALUES.rentalType['Monthly'],        // 791
    subCategoryId,
  };

  const desc = buildDescription(property);
  const titleEn = buildTitleEn(property);
  // Mzad title max 33 chars
  const title = titleEn.substring(0, 33);

  const step3Data = {
    title,
    description: desc.substring(0, 700),
    price,
    autoRenew: false,
    currencyId: 1,  // QAR
    isResetImages: false,
  };

  const commonHeaders = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Inertia': 'true',
    'X-Inertia-Version': inertiaVersion,
    'X-XSRF-TOKEN': xsrf,
    'Cookie': buildCookieStr(session, xsrf),
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/en/add_advertise`,
    'Accept': 'text/html, application/xhtml+xml',
  };

  // ── Step 1: Submit category selection ──
  console.log(`[Mzad] Step 1: Submitting category ${categoryId} for unit ${property.Unit}...`);
  const step1Res = await axios.post(`${BASE_URL}/en/add_advertise`, {
    step1Data,
    step2Data: {},
    step3Data: { autoRenew: false, currencyId: 1, isResetImages: false },
    step: 1,
  }, { headers: commonHeaders, validateStatus: s => s < 500 });

  // Update cookies if server sends new ones
  const cookies1 = parseCookies(step1Res.headers['set-cookie']);
  if (cookies1['XSRF-TOKEN']) commonHeaders['X-XSRF-TOKEN'] = cookies1['XSRF-TOKEN'];
  if (cookies1['mzadqatar_session']) {
    commonHeaders['Cookie'] = buildCookieStr(
      cookies1['mzadqatar_session'] || session,
      cookies1['XSRF-TOKEN'] || xsrf
    );
  }

  console.log(`[Mzad] Step 1 status: ${step1Res.status}`);

  // ── Step 2: Submit property details ──
  console.log(`[Mzad] Step 2: Submitting property details for unit ${property.Unit}...`);
  const step2Res = await axios.post(`${BASE_URL}/en/add_advertise`, {
    step1Data,
    step2Data,
    step3Data: { autoRenew: false, currencyId: 1, isResetImages: false },
    step: 2,
  }, { headers: commonHeaders, validateStatus: s => s < 500 });

  const cookies2 = parseCookies(step2Res.headers['set-cookie']);
  if (cookies2['XSRF-TOKEN']) commonHeaders['X-XSRF-TOKEN'] = cookies2['XSRF-TOKEN'];
  if (cookies2['mzadqatar_session']) {
    commonHeaders['Cookie'] = buildCookieStr(
      cookies2['mzadqatar_session'] || session,
      cookies2['XSRF-TOKEN'] || xsrf
    );
  }

  console.log(`[Mzad] Step 2 status: ${step2Res.status}`);

  // Check for validation errors
  if (step2Res.data?.props?.errors && Object.keys(step2Res.data.props.errors).length > 0) {
    throw new Error('Mzad step 2 validation: ' + JSON.stringify(step2Res.data.props.errors));
  }

  // ── Step 3: Submit ad content and publish (multipart with image) ──
  console.log(`[Mzad] Step 3: Publishing ad for unit ${property.Unit} (multipart with image)...`);

  // Generate placeholder image
  const imageBuffer = generatePlaceholderImage();

  // Add image to step3Data
  step3Data.images = [imageBuffer];

  // Build FormData with Inertia-style bracket notation
  const formPayload = { step1Data, step2Data, step3Data, step: 3 };
  const fd = objectToFormData(formPayload);

  // Step 3 headers: multipart (let form-data set Content-Type with boundary)
  const step3Headers = { ...commonHeaders };
  delete step3Headers['Content-Type']; // form-data sets its own
  Object.assign(step3Headers, fd.getHeaders());

  const step3Res = await axios.post(`${BASE_URL}/en/add_advertise`, fd, {
    headers: step3Headers,
    validateStatus: s => s < 500,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  console.log(`[Mzad] Ad submitted for unit ${property.Unit}. Status: ${step3Res.status}`);

  // If step 3 returns 500 with multipart, retry with JSON (no image) as fallback
  if (step3Res.status >= 400) {
    console.log(`[Mzad] Step 3 multipart failed (${step3Res.status}), retrying with JSON...`);
    delete step3Data.images;
    const step3JsonRes = await axios.post(`${BASE_URL}/en/add_advertise`, {
      step1Data, step2Data, step3Data, step: 3,
    }, { headers: { ...commonHeaders, 'Content-Type': 'application/json' }, validateStatus: s => s < 600 });

    console.log(`[Mzad] Step 3 JSON fallback status: ${step3JsonRes.status}`);

    if (step3JsonRes.data?.props?.errors && Object.keys(step3JsonRes.data.props.errors).length > 0) {
      throw new Error('Mzad step 3 validation: ' + JSON.stringify(step3JsonRes.data.props.errors));
    }
    return step3JsonRes.data;
  }

  // Check for validation errors
  if (step3Res.data?.props?.errors && Object.keys(step3Res.data.props.errors).length > 0) {
    throw new Error('Mzad step 3 validation: ' + JSON.stringify(step3Res.data.props.errors));
  }

  return step3Res.data;
}

module.exports = { getSession, postAd };
