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
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://mzadqatar.com';
const MZAD_RECAPTCHA_SITE_KEY = '6Lc-0vApAAAAAFu7_SOXa6yJIDgm6qAl9LY1vYVI';

// Use plain axios for mzadqatar.com requests.
// Cloudflare bypass is handled by Puppeteer (getCfClearance) which
// obtains cf_clearance cookies on Railway's IP, enabling axios requests.
const mzadAxios = axios;

// ─────────────────────────────────────────────
// Category mapping (from mzadqatar.com Inertia props)
// Residential Properties for Rent = categoryId 8494
// Commercial Properties for Rent  = categoryId 14897
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
// Cloudflare bypass via Puppeteer + Stealth
// Launches headless Chrome to solve CF JS challenge,
// extracts cf_clearance cookie for reuse with axios.
// ─────────────────────────────────────────────
let cachedCfData = null; // { cookies, userAgent, timestamp }
const CF_CLEARANCE_TTL = 15 * 60 * 1000; // 15 minutes

async function getCfClearance(url, forceRefresh = false) {
  // Return cached if still fresh
  if (!forceRefresh && cachedCfData && (Date.now() - cachedCfData.timestamp) < CF_CLEARANCE_TTL) {
    console.log('[Mzad CF] Using cached cf_clearance (age:', Math.round((Date.now() - cachedCfData.timestamp) / 1000), 's)');
    return cachedCfData;
  }

  console.log('[Mzad CF] Launching Puppeteer to solve Cloudflare challenge...');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });

    const page = await browser.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    console.log('[Mzad CF] Browser User-Agent:', userAgent);

    // Navigate to the target URL
    console.log('[Mzad CF] Navigating to', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for CF challenge to clear (look for the page to change from "Just a moment")
    const maxWait = 20000;
    const start = Date.now();
    let resolved = false;
    while (Date.now() - start < maxWait) {
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
      if (!title.includes('Just a moment') && !bodyText.includes('Checking your browser')) {
        resolved = true;
        console.log('[Mzad CF] Challenge resolved! Page title:', title);
        break;
      }
      console.log('[Mzad CF] Still on challenge page... (', Math.round((Date.now() - start) / 1000), 's)');
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!resolved) {
      const finalTitle = await page.title();
      console.warn('[Mzad CF] Challenge did NOT resolve after', maxWait / 1000, 's. Title:', finalTitle);
    }

    // Extract ALL cookies from the browser
    const browserCookies = await page.cookies();
    const cookieObj = {};
    for (const c of browserCookies) {
      cookieObj[c.name] = c.value;
    }
    console.log('[Mzad CF] Extracted cookies:', Object.keys(cookieObj).join(', '));
    console.log('[Mzad CF] cf_clearance:', cookieObj['cf_clearance'] ? 'FOUND' : 'NOT FOUND');

    cachedCfData = {
      cookies: cookieObj,
      userAgent,
      timestamp: Date.now(),
    };

    return cachedCfData;
  } catch (e) {
    console.error('[Mzad CF] Puppeteer error:', e.message);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
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

function buildCookieStr(session, xsrf, extraCookies) {
  let str = `XSRF-TOKEN=${xsrf}; mzadqatar_session=${session}; selectedCountry=QA; currentLang=en`;
  // Forward any extra cookies (e.g. cf_clearance, __cf_bm) for Cloudflare
  if (extraCookies && typeof extraCookies === 'object') {
    for (const [k, v] of Object.entries(extraCookies)) {
      if (!['XSRF-TOKEN', 'mzadqatar_session', 'selectedCountry', 'currentLang'].includes(k) && v) {
        str += `; ${k}=${v}`;
      }
    }
  }
  return str;
}

function decodedXsrf(xsrf) {
  try { return decodeURIComponent(xsrf); } catch { return xsrf; }
}

// ─────────────────────────────────────────────
// Initial page fetch (get fresh CSRF + session)
// Uses Puppeteer CF bypass if Cloudflare blocks
// ─────────────────────────────────────────────
async function getInitialCookies() {
  console.log('[Mzad] Fetching initial cookies from login page...');

  // First try: get CF clearance via Puppeteer (proactive bypass)
  const cfData = await getCfClearance(`${BASE_URL}/en/login`);
  const cfUserAgent = cfData?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const cfCookieStr = cfData?.cookies
    ? Object.entries(cfData.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  const res = await mzadAxios.get(`${BASE_URL}/en/login`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': cfUserAgent,
      ...(cfCookieStr ? { 'Cookie': cfCookieStr } : {}),
    },
    withCredentials: true,
    validateStatus: s => s < 500,
  });

  const cookies = parseCookies(res.headers['set-cookie']);
  const csrfMeta = String(res.data).match(/name="csrf-token"\s+content="([^"]+)"/);

  // Merge CF cookies with response cookies
  const allCookies = { ...(cfData?.cookies || {}), ...cookies };
  const cookieNames = Object.keys(allCookies);
  console.log('[Mzad] Initial GET status:', res.status, '| Cookies received:', cookieNames.join(', '));

  const html = String(res.data);
  if (html.includes('Just a moment') || html.includes('cf-challenge') || res.status === 403) {
    console.warn('[Mzad] Initial GET STILL returned Cloudflare challenge after Puppeteer bypass! Status:', res.status);
  }

  return {
    session: cookies['mzadqatar_session'] || allCookies['mzadqatar_session'] || '',
    xsrf: cookies['XSRF-TOKEN'] || allCookies['XSRF-TOKEN'] || '',
    csrf: csrfMeta ? csrfMeta[1] : decodedXsrf(cookies['XSRF-TOKEN'] || allCookies['XSRF-TOKEN'] || ''),
    allCookies,
    cfUserAgent,
  };
}

// ─────────────────────────────────────────────
// Check if current session is still valid
// ─────────────────────────────────────────────
async function isSessionValid(session, xsrf) {
  if (!session || !xsrf) { console.log('[Mzad] isSessionValid: missing session or xsrf'); return false; }
  try {
    const cfExtra = cachedCfData?.cookies || {};
    const ua = cachedCfData?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const res = await mzadAxios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf, cfExtra),
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'X-Inertia-Version': '1',
        'User-Agent': ua,
      },
      maxRedirects: 0,
      validateStatus: s => s < 500,
    });
    console.log('[Mzad] isSessionValid: status=', res.status, 'valid=', res.status === 200 || res.status === 409);
    return res.status === 200 || res.status === 409;
  } catch (e) {
    console.log('[Mzad] isSessionValid: error=', e.message);
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

  // Step 1: Get fresh cookies (including Cloudflare cookies)
  const initial = await getInitialCookies();
  let { session, xsrf, csrf, allCookies, cfUserAgent } = initial;
  let extraCookies = { ...allCookies };
  const ua = cfUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

  // Step 2: Solve reCAPTCHA v3
  const recaptchaToken = await solveRecaptchaV3('login');

  console.log('[Mzad] Logging in with password for phone', phone, '...');
  const loginRes = await mzadAxios.post(`${BASE_URL}/en/login`, {
    phone,
    password,
    recaptchaToken: recaptchaToken || 'placeholder-token',
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'Cookie': buildCookieStr(session, xsrf, extraCookies),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
      'User-Agent': ua,
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

  Object.assign(extraCookies, resCookies);
  return { session: finalSession, xsrf: finalXsrf, csrfToken: finalCsrf, extraCookies };
}

// ─────────────────────────────────────────────
// Login with OTP
// ─────────────────────────────────────────────
async function loginWithOtp() {
  const { readOtpFromGmail } = require('./gmail-otp');
  const phone = process.env.MZAD_PHONE || '70297066';

  // Step 1: Get fresh cookies (including Cloudflare cookies via Puppeteer)
  const initial = await getInitialCookies();
  let { session, xsrf, csrf, allCookies, cfUserAgent } = initial;
  let extraCookies = { ...allCookies };
  const ua = cfUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

  // Step 2: Solve reCAPTCHA v3 for OTP request
  const recaptchaToken1 = await solveRecaptchaV3('login');

  const otpBody = { phone, recaptchaToken: recaptchaToken1 || 'placeholder-token' };

  console.log('[Mzad] Sending OTP request to phone', phone, '...');
  console.log('[Mzad] reCAPTCHA token1:', recaptchaToken1 ? `${recaptchaToken1.substring(0, 30)}... (len=${recaptchaToken1.length})` : 'NULL (using placeholder)');
  console.log('[Mzad] All cookies being sent:', Object.keys(extraCookies).join(', '));
  const otpReqRes = await mzadAxios.post(`${BASE_URL}/en/login`, otpBody, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': buildCookieStr(session, xsrf, extraCookies),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
      'User-Agent': ua,
    },
    validateStatus: s => s < 500,
  });

  // Update ALL cookies from response
  const cookies2 = parseCookies(otpReqRes.headers['set-cookie']);
  Object.assign(extraCookies, cookies2);
  if (cookies2['mzadqatar_session']) session = cookies2['mzadqatar_session'];
  if (cookies2['XSRF-TOKEN']) xsrf = cookies2['XSRF-TOKEN'];
  csrf = decodedXsrf(xsrf);

  console.log('[Mzad] OTP request status:', otpReqRes.status);
  console.log('[Mzad] OTP request response body:', JSON.stringify(otpReqRes.data).substring(0, 500));
  console.log('[Mzad] OTP response cookies:', Object.keys(cookies2).join(', ') || 'none');

  // If Cloudflare blocked us, force-refresh CF clearance and retry
  if (otpReqRes.status === 403 && String(otpReqRes.data).includes('Just a moment')) {
    console.log('[Mzad] Cloudflare challenge on POST! Force-refreshing CF clearance via Puppeteer...');
    const cfResult = await getCfClearance(`${BASE_URL}/en/login`, true);
    if (cfResult) {
      Object.assign(extraCookies, cfResult.cookies);
      // Re-fetch initial cookies with new CF clearance
      const freshRes = await mzadAxios.get(`${BASE_URL}/en/login`, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': cfResult.userAgent,
          'Cookie': Object.entries(extraCookies).map(([k, v]) => `${k}=${v}`).join('; '),
        },
        validateStatus: s => s < 500,
      });
      const freshCookies = parseCookies(freshRes.headers['set-cookie']);
      Object.assign(extraCookies, freshCookies);
      if (freshCookies['mzadqatar_session']) session = freshCookies['mzadqatar_session'];
      if (freshCookies['XSRF-TOKEN']) xsrf = freshCookies['XSRF-TOKEN'];
      const freshCsrfMeta = String(freshRes.data).match(/name="csrf-token"\s+content="([^"]+)"/);
      csrf = freshCsrfMeta ? freshCsrfMeta[1] : decodedXsrf(xsrf);

      console.log('[Mzad] Retrying OTP request with fresh CF cookies...');
      const retryRes = await mzadAxios.post(`${BASE_URL}/en/login`, otpBody, {
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrf,
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': buildCookieStr(session, xsrf, extraCookies),
          'Origin': BASE_URL,
          'Referer': `${BASE_URL}/en/login`,
          'Accept': 'application/json',
          'User-Agent': cfResult.userAgent,
        },
        validateStatus: s => s < 500,
      });
      const retryCookies = parseCookies(retryRes.headers['set-cookie']);
      Object.assign(extraCookies, retryCookies);
      if (retryCookies['mzadqatar_session']) session = retryCookies['mzadqatar_session'];
      if (retryCookies['XSRF-TOKEN']) xsrf = retryCookies['XSRF-TOKEN'];
      csrf = decodedXsrf(xsrf);
      console.log('[Mzad] Retry OTP request status:', retryRes.status);
      console.log('[Mzad] Retry response body:', JSON.stringify(retryRes.data).substring(0, 300));
    } else {
      console.error('[Mzad] Could not get CF clearance via Puppeteer');
    }
  }

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
  console.log('[Mzad] reCAPTCHA token2:', recaptchaToken2 ? `${recaptchaToken2.substring(0, 30)}... (len=${recaptchaToken2.length})` : 'NULL (using placeholder)');
  console.log('[Mzad] Verify all cookies:', Object.keys(extraCookies).join(', '));
  const verifyRes = await mzadAxios.post(`${BASE_URL}/en/login`, verifyBody, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'Cookie': buildCookieStr(session, xsrf, extraCookies),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/login`,
      'Accept': 'application/json',
      'User-Agent': ua,
    },
    maxRedirects: 0,
    validateStatus: s => s < 500,
  });

  const finalCookies = parseCookies(verifyRes.headers['set-cookie']);
  Object.assign(extraCookies, finalCookies);
  const finalSession = finalCookies['mzadqatar_session'] || session;
  const finalXsrf = finalCookies['XSRF-TOKEN'] || xsrf;
  const finalCsrf = decodedXsrf(finalXsrf);

  console.log('[Mzad] OTP verify status:', verifyRes.status);
  console.log('[Mzad] OTP verify response body:', JSON.stringify(verifyRes.data).substring(0, 500));
  console.log('[Mzad] OTP verify set-cookie count:', (verifyRes.headers['set-cookie'] || []).length);
  console.log('[Mzad] Final session changed?', finalSession !== session);
  console.log('[Mzad] Final xsrf changed?', finalXsrf !== xsrf);

  // Validate the session actually works
  const valid = await isSessionValid(finalSession, finalXsrf);
  if (!valid) throw new Error('Mzad: OTP login failed – session not authenticated after OTP verify');

  // Store for this process and log for Railway env var update
  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;

  console.log('[Mzad] Login successful! Session established.');
  console.log('[Mzad] Update Railway env vars:');
  console.log(`  MZAD_SESSION=${finalSession.substring(0, 40)}...`);
  console.log(`  MZAD_XSRF_TOKEN=${finalXsrf.substring(0, 40)}...`);

  return { session: finalSession, xsrf: finalXsrf, csrfToken: finalCsrf, extraCookies };
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
      return { session, xsrf, csrfToken: decodedXsrf(xsrf), extraCookies: {} };
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
    const cfExtra = cachedCfData?.cookies || {};
    const ua = cachedCfData?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const res = await mzadAxios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf, cfExtra),
        'Accept': 'text/html',
        'User-Agent': ua,
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
// Build form data for a property
// ─────────────────────────────────────────────
function buildFormData(property) {
  const isComm = isCommercialType(property.Type);
  const categoryId = isComm ? 14897 : 8494;

  const step1Data = { categoryId, lang: 'en', mzadyUserNumber: null };

  const bedrooms = parseInt(property.Bedrooms) || 2;
  const bathrooms = String(parseInt(property.Bathrooms) || 2);
  const area = parseInt(property.Size_sqm) || 100;
  const floor = String(parseInt(property.Floor) || 1);
  const price = parseInt(property.Rent_QAR) || 1000;

  let subCategoryId = MZAD_VALUES.subcategory['Apartments'];
  const typeLower = (property.Type || '').toLowerCase();
  if (typeLower.includes('villa')) subCategoryId = MZAD_VALUES.subcategory['Villas'];
  else if (typeLower.includes('building') || typeLower.includes('tower')) subCategoryId = MZAD_VALUES.subcategory['Building & Towers'];

  let regionId = '30';
  if (property.Region) {
    const regionEntry = Object.entries(MZAD_VALUES.regions).find(([name]) =>
      property.Region.toLowerCase().includes(name.toLowerCase()));
    if (regionEntry) regionId = regionEntry[1];
  }

  const step2Data = {
    cityId: MZAD_VALUES.cities['Doha'],
    regionId,
    numberOfRooms: bedrooms,
    location: property.Maps_Link || '',
    categoryAdvertiseTypeId: MZAD_VALUES.adType['Rent'],
    furnishedTypeId: MZAD_VALUES.furnishing['Not Furnished'],
    properterylevel: MZAD_VALUES.levels[floor] || MZAD_VALUES.levels['1'],
    lands_area: area,
    properteryfinishing: MZAD_VALUES.finishing['Fully Finished'],
    properterybathrooms: MZAD_VALUES.bathrooms[bathrooms] || MZAD_VALUES.bathrooms['2'],
    salesref: property.Unit || '',
    rentaltype: MZAD_VALUES.rentalType['Monthly'],
    subCategoryId,
  };

  const desc = buildDescription(property);
  const titleEn = buildTitleEn(property);
  const titleAr = buildTitleAr(property);

  const productNameEnglish = titleEn.substring(0, 100);
  const productNameArabic = titleAr.substring(0, 100);

  const safeDesc = desc
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[━─═╔╗╚╝║│┌┐└┘├┤┬┴┼]/g, '-')
    .replace(/\n{3,}/g, '\n\n')
    .substring(0, 1500);

  const step3Data = {
    productNameEnglish,
    productNameArabic,
    productNameArEn: productNameEnglish,
    productDescriptionEnglish: safeDesc,
    productDescriptionArabic: safeDesc,
    productDescriptionArEn: safeDesc,
    productPrice: price,
    autoRenew: false,
    currencyId: 1,
    isResetImages: false,
    images: [],
    productId: null,
    agree_commission: true,
  };

  return { step1Data, step2Data, step3Data };
}

// ─────────────────────────────────────────────
// Main post function — Puppeteer-based browser submission
// Uses real browser to submit the Inertia form, ensuring
// correct cookies, CSRF, headers, and data format.
// ─────────────────────────────────────────────
async function postAd(property, sessionData) {
  const { session, xsrf, csrfToken, extraCookies } = sessionData;
  const { step1Data, step2Data, step3Data } = buildFormData(property);

  console.log(`[Mzad] Puppeteer postAd for unit ${property.Unit}...`);
  console.log(`[Mzad] Category: ${step1Data.categoryId}, SubCat: ${step2Data.subCategoryId}, Price: ${step3Data.productPrice}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });

    const page = await browser.newPage();

    // Set cookies for authenticated session
    const cookiesToSet = [
      { name: 'mzadqatar_session', value: session, domain: 'mzadqatar.com', path: '/' },
      { name: 'XSRF-TOKEN', value: xsrf, domain: 'mzadqatar.com', path: '/' },
      { name: 'selectedCountry', value: 'QA', domain: 'mzadqatar.com', path: '/' },
      { name: 'currentLang', value: 'en', domain: 'mzadqatar.com', path: '/' },
    ];
    // Add extra cookies (cf_clearance, __cf_bm, etc.)
    if (extraCookies) {
      for (const [k, v] of Object.entries(extraCookies)) {
        if (v && !['mzadqatar_session', 'XSRF-TOKEN', 'selectedCountry', 'currentLang'].includes(k)) {
          cookiesToSet.push({ name: k, value: String(v), domain: '.mzadqatar.com', path: '/' });
        }
      }
    }
    // Also add cached CF cookies
    if (cachedCfData?.cookies) {
      for (const [k, v] of Object.entries(cachedCfData.cookies)) {
        if (v && !cookiesToSet.find(c => c.name === k)) {
          cookiesToSet.push({ name: k, value: String(v), domain: '.mzadqatar.com', path: '/' });
        }
      }
    }

    await page.setCookie(...cookiesToSet);
    console.log(`[Mzad] Set ${cookiesToSet.length} cookies in Puppeteer`);

    // Navigate to the add_advertise page
    console.log(`[Mzad] Navigating to add_advertise page...`);
    await page.goto(`${BASE_URL}/en/add_advertise`, { waitUntil: 'networkidle2', timeout: 45000 });

    // Wait for CF challenge to clear if present
    const title = await page.title();
    if (title.includes('Just a moment')) {
      console.log(`[Mzad] Cloudflare challenge detected, waiting...`);
      await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 25000 });
      console.log(`[Mzad] Cloudflare challenge cleared`);
    }

    // Extract Inertia version and XSRF token from page
    const pageContext = await page.evaluate(() => {
      const dataPage = document.querySelector('[data-page]');
      let pageData = {};
      if (dataPage) {
        try { pageData = JSON.parse(dataPage.getAttribute('data-page')); } catch(e) {}
      }
      // Get XSRF token from cookie
      const xsrfCookie = document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='));
      const xsrfValue = xsrfCookie ? decodeURIComponent(xsrfCookie.split('=').slice(1).join('=').trim()) : '';
      // Get CSRF meta tag
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      return {
        version: pageData.version || '',
        component: pageData.component || '',
        url: pageData.url || '',
        xsrf: xsrfValue,
        csrf: csrfMeta ? csrfMeta.content : '',
        propsKeys: Object.keys(pageData.props || {}),
      };
    });

    console.log(`[Mzad] Page context: component=${pageContext.component}, version=${pageContext.version}, xsrf=${pageContext.xsrf ? 'YES' : 'NO'}`);

    // If redirected to login, session is invalid
    if (pageContext.component === 'Login' || pageContext.url?.includes('login')) {
      throw new Error('Mzad: Session expired — redirected to login page');
    }

    // Submit all 3 steps using fetch() from within the browser context
    // This ensures correct cookies, CSRF, and Inertia handling
    const result = await page.evaluate(async (step1Data, step2Data, step3Data, inertiaVersion) => {
      const BASE = window.location.origin;

      // Helper: get current XSRF token from cookies
      function getXsrf() {
        const c = document.cookie.split(';').find(c => c.trim().startsWith('XSRF-TOKEN='));
        return c ? decodeURIComponent(c.split('=').slice(1).join('=').trim()) : '';
      }

      // Helper: make an Inertia POST request
      async function inertiaPost(url, data) {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia': 'true',
            'X-Inertia-Version': inertiaVersion,
            'X-XSRF-TOKEN': getXsrf(),
            'Accept': 'text/html, application/xhtml+xml',
          },
          credentials: 'same-origin',
          body: JSON.stringify(data),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}
        return { status: res.status, json, text: text.substring(0, 2000), headers: Object.fromEntries(res.headers) };
      }

      const results = {};

      // Step 1
      const s1 = await inertiaPost(`${BASE}/en/add_advertise`, {
        step1Data, step2Data: {}, step3Data: { autoRenew: false, currencyId: 1, isResetImages: false }, step: 1,
      });
      results.step1 = { status: s1.status, errors: s1.json?.props?.errors };

      // Step 2
      const s2 = await inertiaPost(`${BASE}/en/add_advertise`, {
        step1Data, step2Data, step3Data: { autoRenew: false, currencyId: 1, isResetImages: false }, step: 2,
      });
      const s2AddData = s2.json?.props?.getAddAdvertiseData || {};
      results.step2 = {
        status: s2.status,
        errors: s2.json?.props?.errors,
        addDataKeys: Object.keys(s2AddData),
        apiData: JSON.stringify(s2AddData.apiData || {}).substring(0, 2000),
        prevData: JSON.stringify(s2AddData.prevData || {}).substring(0, 500),
        isCompleted: s2AddData.isCompleted,
      };

      // Step 3
      const s3 = await inertiaPost(`${BASE}/en/add_advertise`, {
        step1Data, step2Data, step3Data, step: 3,
      });
      const s3AddData = s3.json?.props?.getAddAdvertiseData || {};
      results.step3 = {
        status: s3.status,
        errors: s3.json?.props?.errors,
        isCompleted: s3AddData.isCompleted,
        prevData: JSON.stringify(s3AddData.prevData || {}).substring(0, 500),
        addDataKeys: Object.keys(s3AddData),
        component: s3.json?.component,
        url: s3.json?.url,
        fullResponse: JSON.stringify(s3.json || {}).substring(0, 3000),
      };

      // If step 3 didn't complete with JSON, try FormData WITH a real image
      if (!s3AddData.isCompleted) {
        // Generate a placeholder property image using Canvas
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 600;
        const ctx = canvas.getContext('2d');
        // Blue gradient background
        const grad = ctx.createLinearGradient(0, 0, 800, 600);
        grad.addColorStop(0, '#1a5276');
        grad.addColorStop(1, '#2980b9');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 800, 600);
        // White text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Property For Rent', 400, 250);
        ctx.font = '24px Arial';
        ctx.fillText(step3Data.productNameEnglish || 'Apartment', 400, 300);
        ctx.fillText(step3Data.productPrice + ' QAR/month', 400, 350);
        ctx.font = '18px Arial';
        ctx.fillText('Al-Imtiaz Property Management', 400, 420);

        // Convert canvas to Blob
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const imageFile = new File([blob], 'property.jpg', { type: 'image/jpeg' });

        const fd = new FormData();
        // Flatten step data into FormData with bracket notation
        function appendObj(prefix, obj) {
          for (const [k, v] of Object.entries(obj)) {
            const key = `${prefix}[${k}]`;
            if (v === null || v === undefined) {
              fd.append(key, '');
            } else if (typeof v === 'boolean') {
              fd.append(key, v ? '1' : '0');
            } else if (Array.isArray(v)) {
              // Skip images array — we handle it separately
              if (k === 'images') return;
              if (v.length === 0) {
                fd.append(`${key}[]`, '');
              } else {
                v.forEach((item, idx) => fd.append(`${key}[${idx}]`, item));
              }
            } else if (typeof v === 'object') {
              appendObj(key, v);
            } else {
              fd.append(key, String(v));
            }
          }
        }
        appendObj('step1Data', step1Data);
        appendObj('step2Data', step2Data);
        appendObj('step3Data', step3Data);
        // Append the image file
        fd.append('step3Data[images][0]', imageFile);
        fd.append('step', '3');

        const s3fd = await fetch(`${BASE}/en/add_advertise`, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia': 'true',
            'X-Inertia-Version': inertiaVersion,
            'X-XSRF-TOKEN': getXsrf(),
            'Accept': 'text/html, application/xhtml+xml',
          },
          credentials: 'same-origin',
          body: fd,
        });
        const s3fdText = await s3fd.text();
        let s3fdJson = null;
        try { s3fdJson = JSON.parse(s3fdText); } catch(e) {}
        const s3fdAdd = s3fdJson?.props?.getAddAdvertiseData || {};
        results.step3_with_image = {
          status: s3fd.status,
          errors: s3fdJson?.props?.errors,
          isCompleted: s3fdAdd.isCompleted,
          prevData: JSON.stringify(s3fdAdd.prevData || {}).substring(0, 500),
          component: s3fdJson?.component,
          url: s3fdJson?.url,
          fullResponse: JSON.stringify(s3fdJson || {}).substring(0, 3000),
        };
      }

      return results;
    }, step1Data, step2Data, step3Data, pageContext.version);

    console.log(`[Mzad] Puppeteer results:`, JSON.stringify(result, null, 2).substring(0, 3000));

    // Check for success
    const s3 = result.step3;
    if (s3.isCompleted) {
      console.log(`[Mzad] Ad created successfully for unit ${property.Unit}!`);
      return { success: true, ...result };
    }

    // Check FormData with image attempt
    if (result.step3_with_image?.isCompleted) {
      console.log(`[Mzad] Ad created via FormData+image for unit ${property.Unit}!`);
      return { success: true, ...result };
    }

    // Log detailed failure info
    console.warn(`[Mzad] Ad NOT created. Step 3 isCompleted: ${s3.isCompleted}`);
    console.warn(`[Mzad] Step 3 errors:`, JSON.stringify(s3.errors || {}));
    console.warn(`[Mzad] Step 3 response:`, s3.fullResponse?.substring(0, 1500));

    // Still return the response for debugging
    return { success: false, ...result };
  } catch (e) {
    console.error(`[Mzad] Puppeteer postAd error:`, e.message);
    throw e;
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }
}

module.exports = { getSession, postAd, buildFormData };
