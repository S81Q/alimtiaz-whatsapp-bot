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

  const defaultUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Try direct axios first (no Puppeteer) — Railway IP may not be CF-challenged
  try {
    const directRes = await mzadAxios.get(`${BASE_URL}/en/login`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': defaultUa,
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });

    const html = String(directRes.data);
    const isCfChallenge = html.includes('Just a moment') || html.includes('cf-challenge') || directRes.status === 403;

    if (!isCfChallenge) {
      // Direct access works — no Puppeteer needed!
      const cookies = parseCookies(directRes.headers['set-cookie']);
      const csrfMeta = html.match(/name="csrf-token"\s+content="([^"]+)"/);
      console.log('[Mzad] Direct GET successful! status:', directRes.status, '| Cookies:', Object.keys(cookies).join(', '));

      return {
        session: cookies['mzadqatar_session'] || '',
        xsrf: cookies['XSRF-TOKEN'] || '',
        csrf: csrfMeta ? csrfMeta[1] : decodedXsrf(cookies['XSRF-TOKEN'] || ''),
        allCookies: cookies,
        cfUserAgent: defaultUa,
      };
    }
    console.log('[Mzad] Direct GET blocked by Cloudflare, falling back to Puppeteer...');
  } catch (e) {
    console.log('[Mzad] Direct GET failed:', e.message, '— falling back to Puppeteer...');
  }

  // Fallback: use Puppeteer CF bypass
  const cfData = await getCfClearance(`${BASE_URL}/en/login`);
  const cfUserAgent = cfData?.userAgent || defaultUa;
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
  const allCookies = { ...(cfData?.cookies || {}), ...cookies };
  console.log('[Mzad] Puppeteer GET status:', res.status, '| Cookies:', Object.keys(allCookies).join(', '));

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
    // Use a plain HTML GET (not Inertia) to check if session redirects to login
    const res = await mzadAxios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': buildCookieStr(session, xsrf, cfExtra),
        'Accept': 'text/html',
        'User-Agent': ua,
      },
      maxRedirects: 0,
      validateStatus: s => s < 500,
    });
    // 200 = valid (got the add_advertise page)
    // 302 = redirect (likely to login = not authenticated)
    if (res.status === 302) {
      const location = res.headers['location'] || '';
      const isLoginRedirect = location.includes('/login');
      console.log('[Mzad] isSessionValid: status=302, redirect to:', location, '→', isLoginRedirect ? 'INVALID' : 'VALID (non-login redirect)');
      return !isLoginRedirect;
    }
    const html = String(res.data);
    const isLoginPage = html.includes('Log In') && html.includes('Enter your mobile');
    const valid = res.status === 200 && !isLoginPage;
    console.log('[Mzad] isSessionValid: status=', res.status, 'isLoginPage=', isLoginPage, 'valid=', valid);
    return valid;
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
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    const html = String(res.data);
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
    console.log(`[Mzad] getInertiaVersion: status=${res.status}, url=${finalUrl}, html_len=${html.length}`);

    // Check if redirected to login
    if (finalUrl.includes('/login') || html.includes('Log In')) {
      console.warn('[Mzad] getInertiaVersion: redirected to login — session not valid!');
      return { version: '', authenticated: false };
    }

    const dataPageMatch = html.match(/data-page="([^"]+)"/);
    if (dataPageMatch) {
      const pageData = JSON.parse(dataPageMatch[1].replace(/&quot;/g, '"'));
      console.log(`[Mzad] getInertiaVersion: version=${pageData.version}, component=${pageData.component}`);
      return { version: pageData.version || '', authenticated: true };
    }
    return { version: '', authenticated: true };
  } catch (e) {
    console.warn('[Mzad] Could not fetch Inertia version:', e.message);
    return { version: '', authenticated: false };
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

  const step1Data = { categoryId, lang: 'aren', mzadyUserNumber: null };

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
    agree_commission: 1,
  };

  return { step1Data, step2Data, step3Data };
}

// ─────────────────────────────────────────────
// Main post function — Axios-based Inertia form submission
// Uses axios with CF clearance cookies (same cookies that
// work for session validation) to submit the 3-step form.
// No Puppeteer needed — CF bypass is already done by getSession().
// ─────────────────────────────────────────────
async function postAd(property, sessionData) {
  const { session, xsrf, csrfToken, extraCookies } = sessionData;
  const { step1Data, step2Data, step3Data } = buildFormData(property);

  console.log(`[Mzad] postAd for unit ${property.Unit} (lang=${step1Data.lang})...`);

  // Use CF clearance if available, but don't launch Puppeteer just for this
  // (CF clearance is obtained during login; session validation works without it)
  const cfExtra = cachedCfData?.cookies || {};
  const ua = cachedCfData?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const allExtra = { ...cfExtra, ...(extraCookies || {}) };

  console.log(`[Mzad] CF cookies: ${Object.keys(cfExtra).join(', ') || 'none'}`);
  console.log(`[Mzad] Session cookie: ${session?.substring(0, 20)}...`);

  // Get the Inertia version from the page (also checks if session is truly valid)
  let versionInfo = await getInertiaVersion(session, xsrf);
  if (!versionInfo.authenticated) {
    console.warn('[Mzad] Session not authenticated for add_advertise page — forcing re-login...');
    // Force fresh login
    delete process.env.MZAD_SESSION;
    delete process.env.MZAD_XSRF_TOKEN;
    const newSession = await getSession();
    // Update our local variables
    Object.assign(sessionData, newSession);
    versionInfo = await getInertiaVersion(newSession.session, newSession.xsrf);
    if (!versionInfo.authenticated) {
      return { success: false, error: 'Session not authenticated even after re-login' };
    }
    // Update cookies with new session
    Object.assign(allExtra, { ...(cachedCfData?.cookies || {}), ...(newSession.extraCookies || {}) });
  }
  const version = versionInfo.version;
  console.log(`[Mzad] Inertia version: ${version || '(empty)'}, authenticated: ${versionInfo.authenticated}`);

  // Helper: submit a step via axios (Inertia POST)
  let currentSession = sessionData.session || session;
  let currentXsrf = sessionData.xsrf || xsrf;

  async function submitStep(stepData, stepNum) {
    const cookieStr = buildCookieStr(currentSession, currentXsrf, allExtra);
    const csrfVal = decodedXsrf(currentXsrf);

    try {
      // POST the step data — Inertia returns 302 redirect on success
      const res = await mzadAxios.post(`${BASE_URL}/en/add_advertise`, stepData, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/html, application/xhtml+xml',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': version,
          'X-XSRF-TOKEN': csrfVal,
          'Cookie': cookieStr,
          'Origin': BASE_URL,
          'Referer': `${BASE_URL}/en/add_advertise`,
          'User-Agent': ua,
        },
        maxRedirects: 0,
        validateStatus: s => s < 500,
      });

      // Update cookies from POST response
      const resCookies = parseCookies(res.headers['set-cookie']);
      if (resCookies['mzadqatar_session']) currentSession = resCookies['mzadqatar_session'];
      if (resCookies['XSRF-TOKEN']) currentXsrf = resCookies['XSRF-TOKEN'];
      Object.assign(allExtra, resCookies);

      console.log(`[Mzad] Step ${stepNum} POST status: ${res.status}`);

      // If 302 redirect, follow it with GET + Inertia headers to get the page data
      let json = null;
      if (res.status === 302 || res.status === 303) {
        const redirectUrl = res.headers['location'] || `${BASE_URL}/en/add_advertise`;
        const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
        console.log(`[Mzad] Step ${stepNum} following redirect to: ${fullUrl}`);

        const followCookieStr = buildCookieStr(currentSession, currentXsrf, allExtra);
        const followCsrf = decodedXsrf(currentXsrf);
        const followRes = await mzadAxios.get(fullUrl, {
          headers: {
            'Accept': 'text/html, application/xhtml+xml',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia': 'true',
            'X-Inertia-Version': version,
            'X-XSRF-TOKEN': followCsrf,
            'Cookie': followCookieStr,
            'Referer': `${BASE_URL}/en/add_advertise`,
            'User-Agent': ua,
          },
          maxRedirects: 5,
          validateStatus: s => s < 500,
        });

        // Update cookies from GET response
        const followCookies = parseCookies(followRes.headers['set-cookie']);
        if (followCookies['mzadqatar_session']) currentSession = followCookies['mzadqatar_session'];
        if (followCookies['XSRF-TOKEN']) currentXsrf = followCookies['XSRF-TOKEN'];
        Object.assign(allExtra, followCookies);

        if (typeof followRes.data === 'object') {
          json = followRes.data;
        } else {
          try { json = JSON.parse(String(followRes.data)); } catch(e) {}
        }
        console.log(`[Mzad] Step ${stepNum} GET status: ${followRes.status}, isInertia: ${!!json?.component}`);
      } else {
        // Direct response (no redirect)
        if (typeof res.data === 'object') {
          json = res.data;
        } else {
          try { json = JSON.parse(String(res.data)); } catch(e) {}
        }
      }

      const result = {
        status: res.status,
        isInertia: !!json?.component,
        component: json?.component || '',
        prevData: json?.props?.getAddAdvertiseData?.prevData || null,
        isCompleted: json?.props?.getAddAdvertiseData?.isCompleted || false,
        errors: json?.props?.errors || {},
        apiDataKeys: json?.props?.getAddAdvertiseData?.apiData ? Object.keys(json.props.getAddAdvertiseData.apiData) : [],
        bodyPreview: typeof res.data === 'string' ? res.data.substring(0, 300) : JSON.stringify(res.data).substring(0, 300),
      };

      console.log(`[Mzad] Step ${stepNum} response: status=${result.status}, isInertia=${result.isInertia}, component=${result.component}, isCompleted=${result.isCompleted}`);
      if (result.prevData) {
        console.log(`[Mzad] Step ${stepNum} prevData:`, JSON.stringify(result.prevData).substring(0, 500));
      }
      if (result.errors && Object.keys(result.errors).length > 0) {
        console.log(`[Mzad] Step ${stepNum} errors:`, JSON.stringify(result.errors));
      }
      if (result.apiDataKeys.length > 0) {
        console.log(`[Mzad] Step ${stepNum} apiData keys:`, result.apiDataKeys.join(', '));
      }
      return result;
    } catch (e) {
      console.error(`[Mzad] Step ${stepNum} axios error:`, e.message);
      return { error: e.message, status: e.response?.status };
    }
  }

  // STEP 1: Language + Category
  console.log(`[Mzad] Submitting Step 1: lang=${step1Data.lang}, categoryId=${step1Data.categoryId}`);
  const step1Result = await submitStep({
    step1Data: { categoryId: step1Data.categoryId, lang: step1Data.lang },
    step: 1,
  }, 1);

  if (step1Result.error) {
    return { success: false, error: `Step 1 failed: ${step1Result.error}` };
  }

  // STEP 2: Property details
  console.log(`[Mzad] Submitting Step 2...`);
  const step2Payload = {
    step1Data: { categoryId: step1Data.categoryId, lang: step1Data.lang },
    step2Data,
    step: 2,
  };
  const step2Result = await submitStep(step2Payload, 2);

  if (step2Result.error) {
    return { success: false, error: `Step 2 failed: ${step2Result.error}` };
  }

  // Check if step 2 bounced back
  if (step2Result.prevData?.step === 1 || step2Result.prevData?.step === '1') {
    console.warn(`[Mzad] Step 2 bounced back to step 1.`);
    return { success: false, error: 'Step 2 validation failed', details: step2Result };
  }

  // STEP 3: Ad content + submit
  console.log(`[Mzad] Submitting Step 3 (final)...`);
  const step3Payload = {
    step1Data: { categoryId: step1Data.categoryId, lang: step1Data.lang },
    step2Data,
    step3Data: {
      ...step3Data,
      images: [],
      isResetImages: false,
      agree_commission: 1,
    },
    step: 3,
  };
  const step3Result = await submitStep(step3Payload, 3);

  if (step3Result.error) {
    return { success: false, error: `Step 3 failed: ${step3Result.error}` };
  }

  // Check for success
  const success = step3Result.isCompleted ||
    step3Result.bodyPreview?.includes('successfully');

  if (success) {
    console.log(`[Mzad] Ad created successfully for unit ${property.Unit}!`);
  } else {
    console.warn(`[Mzad] Ad may not have been created. isCompleted=${step3Result.isCompleted}`);
    console.log(`[Mzad] Step 3 full result:`, JSON.stringify(step3Result).substring(0, 1000));
  }

  return { success, step1: step1Result, step2: step2Result, step3: step3Result };
}

module.exports = { getSession, postAd, buildFormData };
