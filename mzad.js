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
 *   TWOCAPTCHA_API_KEY  – For reCAPTCHA v3 solving (optional)
 *
 * API Base: https://mzadqatar.com
 */

const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = 'https://mzadqatar.com';
const MZAD_RECAPTCHA_SITE_KEY = '6Lc-0vApAAAAAFu7_SOXa6yJIDgm6qAl9LY1vYVI';

// ─────────────────────────────────────────────
// Category mapping
// Residential rent = category 2 (fetched dynamically; fallback based on capture data)
// Commercial rent  = category 3
// ─────────────────────────────────────────────
function isCommercialType(type) {
  const lower = (type || '').toLowerCase();
  return ['warehouse', 'shop', 'labor camp', 'factory', 'grocery', 'commercial', 'office'].some(k => lower.includes(k));
}

function getCategoryIdFromList(type, categories) {
  if (!categories || categories.length === 0) {
    return isCommercialType(type) ? 3 : 4; // Fallback from captured example (apartment=4)
  }

  const isComm = isCommercialType(type);
  const keyword = isComm ? 'commercial' : 'residential';

  const match = categories.find(c => {
    const name = (c.name || '').toLowerCase();
    return name.includes(keyword) && name.includes('rent');
  });

  return match?.id || (isComm ? 3 : 4);
}

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
    return res.status === 200;
  } catch {
    return false;
  }
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

  return await loginWithOtp();
}

// ─────────────────────────────────────────────
// Fetch categories from the add form
// ─────────────────────────────────────────────
async function fetchCategories(session, xsrf) {
  try {
    const res = await axios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf),
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
    });
    return res.data?.props?.allCategoriesData?.classified || [];
  } catch (e) {
    console.warn('[Mzad] Could not fetch categories:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// Ad content builders
// ─────────────────────────────────────────────
function buildDescriptionAr(property) {
  return [
    property.Property_Name && `${property.Property_Name}`,
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
    property.Rent_QAR && `الإيجار: ${property.Rent_QAR} ريال قطري شهرياً`,
    property.Notes && property.Notes,
    '',
    'للاستفسار: شركة الامتياز والجودة العقارية | +974 70297066',
  ].filter(v => v !== false && v !== null && v !== undefined).join('\n');
}

function buildDescriptionEn(property) {
  return [
    property.Property_Name && `${property.Property_Name}`,
    property.Unit && `Unit: ${property.Unit}`,
    property.Type && `Type: ${property.Type}`,
    property.Size_sqm && `Size: ${property.Size_sqm} sqm`,
    property.Bedrooms && `Bedrooms: ${property.Bedrooms}`,
    property.Bathrooms && `Bathrooms: ${property.Bathrooms}`,
    property.Floor && `Floor: ${property.Floor}`,
    property.Location && `Location: ${property.Location}`,
    property.Zone && `Zone: ${property.Zone}`,
    property.Street && `Street: ${property.Street}`,
    property.Building && `Building: ${property.Building}`,
    property.Rent_QAR && `Rent: QAR ${property.Rent_QAR}/month`,
    property.Notes && property.Notes,
    '',
    'Contact: Al-Imtiaz Wal-Jawada Real Estate | +974 70297066',
  ].filter(v => v !== false && v !== null && v !== undefined).join('\n');
}

// ─────────────────────────────────────────────
// Main post function
// ─────────────────────────────────────────────
/**
 * Post a property ad on Mzad Qatar.
 * @param {Object} property  – Property row from Google Sheets
 * @param {Object} sessionData – { session, xsrf, csrfToken }
 * @returns {Object} Inertia response data
 */
async function postAd(property, sessionData) {
  const { session, xsrf, csrfToken } = sessionData;
  const isComm = isCommercialType(property.Type);

  // Fetch categories to get correct IDs
  const categories = await fetchCategories(session, xsrf);
  const categoryId = getCategoryIdFromList(property.Type, categories);

  const titleAr = `${property.Property_Name || property.Unit} - للإيجار - ${property.Location || 'الدوحة'}`;
  const titleEn = `${property.Type || 'Property'} For Rent - ${property.Location || 'Doha'} - Qatar`;

  const form = new FormData();
  form.append('_token', csrfToken);
  form.append('language', 'both');
  form.append('category_id', String(categoryId));
  form.append('city_id', '2');    // Doha = 2
  form.append('region_id', '1');  // Default region
  form.append('price', String(parseInt(property.Rent_QAR) || 0));
  form.append('ad_type', '1');
  form.append('rental_type', '1'); // Monthly
  form.append('title_ar', titleAr);
  form.append('title_en', titleEn);
  form.append('description_ar', buildDescriptionAr(property));
  form.append('description_en', buildDescriptionEn(property));
  form.append('auto_renew', '0');

  // Residential-specific fields
  if (!isComm) {
    if (property.Bedrooms) form.append('number_of_rooms', String(property.Bedrooms));
    if (property.Bathrooms) form.append('bathrooms', String(property.Bathrooms));
    if (property.Size_sqm) form.append('area', String(property.Size_sqm));
    if (property.Floor) form.append('levels', String(property.Floor));
    form.append('furnishing', '1');   // Unfurnished
    form.append('finishing', '1');    // Standard
  } else {
    if (property.Size_sqm) form.append('area', String(property.Size_sqm));
  }

  if (property.Maps_Link) form.append('location', property.Maps_Link);

  console.log(`[Mzad] Posting ad for unit ${property.Unit} (category ${categoryId})...`);

  const res = await axios.post(`${BASE_URL}/en/add_advertise`, form, {
    headers: {
      ...form.getHeaders(),
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'Cookie': buildCookieStr(session, xsrf),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/add_advertise`,
      'Accept': 'application/json',
    },
    validateStatus: s => s < 500,
  });

  console.log(`[Mzad] Ad submitted for unit ${property.Unit}. Status: ${res.status}`);

  // Check for validation errors in Inertia response
  if (res.data?.props?.errors && Object.keys(res.data.props.errors).length > 0) {
    throw new Error('Mzad validation errors: ' + JSON.stringify(res.data.props.errors));
  }

  return res.data;
}

module.exports = { getSession, postAd };
