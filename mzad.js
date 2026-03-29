/**
 * mzad.js – Mzad Qatar API integration (Multi-step Inertia form)
 *
 * The add_advertise form is a 3-step Inertia.js wizard:
 *   Step 1: POST { step:1, step1Data: { categoryId, lang, mzadyUserNumber } }
 *   Step 2: POST { step:2, step2Data: { cityId, regionId, numberOfRooms, ... } }
 *   Step 3: POST { step:3, step3Data: { price, titleEn, descriptionEn, titleAr, descriptionAr, images, autoRenew } }
 *
 * All POSTs go to /en/add_advertise as JSON with Inertia XHR headers.
 * Step 3 uses multipart/form-data when images are included.
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

const BASE_URL = 'https://mzadqatar.com';
const MZAD_RECAPTCHA_SITE_KEY = '6Lc-0vApAAAAAFu7_SOXa6yJIDgm6qAl9LY1vYVI';

// ─────────────────────────────────────────────
// Category IDs (verified from live form)
// ─────────────────────────────────────────────
const CATEGORY_RESIDENTIAL_RENT = 8494;
const CATEGORY_COMMERCIAL_RENT = 14897;

// Step 2 dropdown value IDs (verified from live form)
const DROPDOWN_IDS = {
  // Ad type
  adType: { Rent: '3', Required: '4', SharingApartment: '5' },
  // Furnishing
  furnishing: { SemiFurnished: 106, NotFurnished: 107, Furnished: 108 },
  // Finishing
  finishing: { FullyFinished: 366, SemiFinished: 367, CoreShell: 368 },
  // Rental type
  rentalType: { Daily: 790, Monthly: 791, Yearly: 792 },
  // Subcategories (Residential)
  subCategoryRes: { BuildingTowers: 87, Villas: 89, Apartments: 88, TraditionalHouses: 90, OtherProperty: 91 },
  // Levels (1=346, 2=347, 3=348, ... 10=355, NotApplicable=356)
  levels: { 1: 346, 2: 347, 3: 348, 4: 349, 5: 350, 6: 351, 7: 352, 8: 353, 9: 354, 10: 355, NA: 356 },
  // Bathrooms (1=357, 2=358, ... 8=364, NotApplicable=365)
  bathrooms: { 1: 357, 2: 358, 3: 359, 4: 360, 5: 361, 6: 362, 7: 363, 8: 364, NA: 365 },
  // Cities
  cities: { Doha: 3, AlKhor: 1, AlShamal: 2, Lusail: 4, AlWakra: 5, Dukhan: 6, Mesaieed: 7 },
};

function isCommercialType(type) {
  const lower = (type || '').toLowerCase();
  return ['warehouse', 'shop', 'labor camp', 'factory', 'grocery', 'commercial', 'office'].some(k => lower.includes(k));
}

function getSubCategoryId(type) {
  const lower = (type || '').toLowerCase();
  if (lower.includes('villa')) return DROPDOWN_IDS.subCategoryRes.Villas;
  if (lower.includes('apartment') || lower.includes('flat')) return DROPDOWN_IDS.subCategoryRes.Apartments;
  if (lower.includes('building') || lower.includes('tower')) return DROPDOWN_IDS.subCategoryRes.BuildingTowers;
  if (lower.includes('traditional') || lower.includes('house')) return DROPDOWN_IDS.subCategoryRes.TraditionalHouses;
  return DROPDOWN_IDS.subCategoryRes.OtherProperty;
}

// ─────────────────────────────────────────────
// reCAPTCHA v3 solving via 2captcha
// ─────────────────────────────────────────────
async function solveRecaptchaV3(action = 'login') {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    console.warn('[Mzad] TWOCAPTCHA_API_KEY not set – skipping reCAPTCHA');
    return null;
  }
  const delay = ms => new Promise(r => setTimeout(r, ms));
  try {
    const submitRes = await axios.post('http://2captcha.com/in.php', null, {
      params: {
        key: apiKey, method: 'userrecaptcha', googlekey: MZAD_RECAPTCHA_SITE_KEY,
        pageurl: `${BASE_URL}/en/login`, version: 'v3', action, score: 0.7, json: 1,
      },
    });
    if (submitRes.data.status !== 1) throw new Error('Submit failed: ' + JSON.stringify(submitRes.data));
    const taskId = submitRes.data.request;
    console.log('[Mzad 2captcha] Task submitted:', taskId);
    for (let i = 0; i < 24; i++) {
      await delay(5000);
      const pollRes = await axios.get('http://2captcha.com/res.php', {
        params: { key: apiKey, action: 'get', id: taskId, json: 1 },
      });
      if (pollRes.data.status === 1) { console.log('[Mzad 2captcha] Solved'); return pollRes.data.request; }
      if (String(pollRes.data.request).startsWith('ERROR')) throw new Error('2captcha: ' + pollRes.data.request);
    }
    throw new Error('2captcha: timeout');
  } catch (e) { console.error('[Mzad 2captcha] Error:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Cookie utilities
// ─────────────────────────────────────────────
function parseCookies(setCookieHeaders) {
  const result = {};
  for (const cookie of setCookieHeaders || []) {
    const main = cookie.split(';')[0];
    const eqIdx = main.indexOf('=');
    if (eqIdx > 0) { result[main.substring(0, eqIdx).trim()] = main.substring(eqIdx + 1).trim(); }
  }
  return result;
}

function buildCookieStr(session, xsrf) {
  let str = `XSRF-TOKEN=${xsrf}; mzadqatar_session=${session}; selectedCountry=QA; currentLang=en`;
  // Append Cloudflare cookies if available
  try {
    const cfCookies = JSON.parse(process.env.MZAD_CF_COOKIES || '{}');
    for (const [k, v] of Object.entries(cfCookies)) {
      str += `; ${k}=${v}`;
    }
  } catch {}
  return str;
}

function decodedXsrf(xsrf) {
  try { return decodeURIComponent(xsrf); } catch { return xsrf; }
}

// ─────────────────────────────────────────────
// Inertia request helper
// ─────────────────────────────────────────────
async function inertiaPost(url, data, session, xsrf) {
  // Use browser fetch if available (for Cloudflare bypass)
  if (_page) {
    try {
      const csrf = decodedXsrf(xsrf);
      const ver = _inertiaVersion || '';
      const res = await browserFetch(_page, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/html, application/xhtml+xml',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': ver,
          'X-XSRF-TOKEN': csrf,
        },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      // Get updated cookies from browser
      const pageCookies = await _page.cookies();
      const newCookies = {};
      for (const c of pageCookies) {
        newCookies[c.name] = c.value;
      }
      return { data: res.json || res.body, status: res.status, cookies: newCookies };
    } catch (e) {
      console.warn('[Mzad] Browser fetch failed, falling back to axios:', e.message);
    }
  }

  // Fallback: axios (may be blocked by CF)
  const res = await axios.post(url, data, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/html, application/xhtml+xml',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'X-Inertia-Version': '',
      'X-XSRF-TOKEN': decodedXsrf(xsrf),
      'Cookie': buildCookieStr(session, xsrf),
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/en/add_advertise`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
    maxRedirects: 0,
    validateStatus: s => s < 500,
  });
  const newCookies = parseCookies(res.headers['set-cookie']);
  return { data: res.data, status: res.status, cookies: newCookies };
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
  return {
    session: cookies['mzadqatar_session'] || '',
    xsrf: cookies['XSRF-TOKEN'] || '',
    csrf: decodedXsrf(cookies['XSRF-TOKEN'] || ''),
  };
}

// ─────────────────────────────────────────────
// Check if current session is still valid
// ─────────────────────────────────────────────
async function isSessionValid(session, xsrf) {
  if (!session || !xsrf) return false;
  try {
    // If browser is available, navigate to check
    if (_page) {
      await _page.goto(`${BASE_URL}/en/add_advertise`, { waitUntil: 'networkidle2', timeout: 30000 });
      const url = _page.url();
      const isValid = !url.includes('/login');
      console.log('[Mzad] Session check (browser): url=' + url + ' valid=' + isValid);
      return isValid;
    }
    // Fallback: axios
    const cookieStr = buildCookieStr(session, xsrf);
    const res = await axios.get(`${BASE_URL}/en/add_advertise`, {
      headers: {
        'Cookie': cookieStr, 'X-Inertia': 'true', 'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html, application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0, validateStatus: s => s < 500,
    });
    if (res.status === 302 || res.status === 301) return false;
    const isValid = res.status === 200 || res.status === 409;
    console.log('[Mzad] Session check (axios): status=' + res.status + ' valid=' + isValid);
    return isValid;
  } catch { return false; }
}

// ─────────────────────────────────────────────
// Login with OTP
// ─────────────────────────────────────────────
// Shared browser instance (reused across login + ad posting)
let _browser = null;
let _page = null;

async function getBrowserPage() {
  if (_browser && _page) {
    try { await _page.evaluate(() => true); return _page; } catch { /* page dead, relaunch */ }
  }
  if (_browser) await _browser.close().catch(() => {});

  console.log('[Mzad] Launching Puppeteer stealth browser...');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--single-process', '--no-zygote'],
  });
  _page = await _browser.newPage();
  await _page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await _page.setViewport({ width: 1280, height: 800 });

  // Navigate to mzad to pass Cloudflare
  console.log('[Mzad] Navigating to Mzad (Cloudflare bypass)...');
  await _page.goto(`${BASE_URL}/en/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  try {
    await _page.waitForSelector('input', { timeout: 30000 });
    console.log('[Mzad] Cloudflare bypassed ✓');
  } catch {
    await new Promise(r => setTimeout(r, 10000));
    console.log('[Mzad] Waited extra 10s for CF, URL:', _page.url());
  }
  return _page;
}

async function closeBrowser() {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _page = null; }
}

// Extract Inertia page version from the loaded page
let _inertiaVersion = '';
async function getInertiaVersion(page) {
  if (_inertiaVersion) return _inertiaVersion;
  try {
    _inertiaVersion = await page.evaluate(() => {
      const el = document.querySelector('[data-page]');
      if (!el) return '';
      try {
        const pageData = JSON.parse(el.getAttribute('data-page'));
        return pageData.version || '';
      } catch { return ''; }
    });
    console.log('[Mzad] Inertia version:', _inertiaVersion || '(empty)');
  } catch {}
  return _inertiaVersion;
}

// Make a fetch() call from INSIDE the Puppeteer browser (inherits CF clearance + TLS)
async function browserFetch(page, url, options) {
  return await page.evaluate(async (u, opts) => {
    const res = await fetch(u, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json ? null : text.substring(0, 5000), json, headers: Object.fromEntries(res.headers.entries()) };
  }, url, options);
}

async function loginWithOtp() {
  const { readOtpFromGmail } = require('./gmail-otp');
  const phone = process.env.MZAD_PHONE || '70297066';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const page = await getBrowserPage();
  console.log('[Mzad] On login page, URL:', page.url());

  // Get Inertia version + XSRF from login page
  const inertiaVer = await getInertiaVersion(page);
  const cookies = await page.cookies();
  let xsrf = '';
  for (const c of cookies) { if (c.name === 'XSRF-TOKEN') xsrf = c.value; }
  const csrf = decodedXsrf(xsrf);
  console.log('[Mzad] XSRF:', xsrf.length, 'chars, Inertia ver:', inertiaVer || '(none)');

  // ── Step A: Get reCAPTCHA token from browser context ──
  console.log('[Mzad] Executing grecaptcha in browser...');
  let recaptchaToken1 = null;
  try {
    // Wait for grecaptcha to be ready
    await page.waitForFunction(() => typeof grecaptcha !== 'undefined' && typeof grecaptcha.execute === 'function', { timeout: 10000 });
    recaptchaToken1 = await page.evaluate(async (siteKey) => {
      return await grecaptcha.execute(siteKey, { action: 'login' });
    }, MZAD_RECAPTCHA_SITE_KEY);
    console.log('[Mzad] Browser reCAPTCHA token obtained:', recaptchaToken1 ? recaptchaToken1.substring(0, 30) + '...' : 'null');
  } catch (e) {
    console.warn('[Mzad] Browser reCAPTCHA failed:', e.message, '- falling back to 2captcha');
    recaptchaToken1 = await solveRecaptchaV3('login');
  }

  const otpRequestTime = Date.now() - 60000; // 60s buffer for clock skew
  // ── Step B: Send OTP via browser fetch ──
  console.log('[Mzad] Sending OTP request for phone:', phone);
  const otpRes = await page.evaluate(async (baseUrl, ph, token, csrfToken, ver) => {
    try {
      const res = await fetch(baseUrl + '/en/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': ver || '',
          'X-XSRF-TOKEN': csrfToken,
          'Accept': 'text/html, application/xhtml+xml',
        },
        body: JSON.stringify({ phone: ph, otp: '', countryId: 176, countryCode: '974', recaptchaToken: token || '' }),
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 500), ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, BASE_URL, phone, recaptchaToken1, csrf, inertiaVer);
  console.log('[Mzad] OTP request result:', JSON.stringify(otpRes));

  // Check for rate limiting
  if (otpRes.body && otpRes.body.includes('three times in one hour')) {
    console.warn('[Mzad] Rate limited! Mzad says: wait 1 hour.');
    throw new Error('RATE_LIMITED: Mzad OTP rate limit hit (3/hour). Try again after 1 hour.');
  }

  if (!otpRes.ok || otpRes.status >= 400) {
    throw new Error(`Mzad OTP request failed: ${JSON.stringify(otpRes)}`);
  }

  // ── Step C: Wait for OTP and read from Gmail ──
  console.log('[Mzad] Waiting 5s for OTP delivery...');
  await delay(5000);
  const otp = await readOtpFromGmail('mzad', 8, 5000, otpRequestTime);
  if (!otp) throw new Error('Mzad: Could not retrieve OTP from Gmail');
  console.log('[Mzad] Got OTP:', otp);

  // ── Step D: Get fresh reCAPTCHA + XSRF, then verify OTP ──
  const cookies2 = await page.cookies();
  let xsrf2 = '';
  for (const c of cookies2) { if (c.name === 'XSRF-TOKEN') xsrf2 = c.value; }
  const csrf2 = decodedXsrf(xsrf2 || xsrf);

  console.log('[Mzad] Verifying OTP:', otp);
  // Build individual OTP digit fields (otp_0 through otp_5) as Mzad expects
  const otpDigits = otp.toString().padEnd(6, '0').split('').slice(0, 6);
  const verifyRes = await page.evaluate(async (baseUrl, ph, otpCode, digits, csrfToken, ver) => {
    try {
      const res = await fetch(baseUrl + '/en/login-verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': ver || '',
          'X-XSRF-TOKEN': csrfToken,
          'Accept': 'text/html, application/xhtml+xml',
        },
        body: JSON.stringify({
          otp_0: digits[0], otp_1: digits[1], otp_2: digits[2],
          otp_3: digits[3], otp_4: digits[4], otp_5: digits[5],
          otp: otpCode,
          username: ph,
          countryId: 176,
          countryCode: '974',
        }),
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 500), url: window.location.href, ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, BASE_URL, phone, otp, otpDigits, csrf2, inertiaVer);
  console.log('[Mzad] OTP verify result:', JSON.stringify(verifyRes));

  // ── Step E: Validate by navigating to add_advertise ──
  await delay(2000);
  console.log('[Mzad] Navigating to add_advertise to validate...');
  await page.goto(`${BASE_URL}/en/add_advertise`, { waitUntil: 'networkidle2', timeout: 30000 });
  const finalUrl = page.url();
  console.log('[Mzad] add_advertise URL:', finalUrl);

  if (finalUrl.includes('/login')) {
    // Check if verify response had errors
    const verifyBody = verifyRes.body || '';
    if (verifyBody.includes('three times in one hour')) {
      console.warn('[Mzad] Rate limited during verify.');
      throw new Error('RATE_LIMITED: Mzad OTP rate limit during verify. Try again after 1 hour.');
    }
    throw new Error('Mzad login failed: not authenticated after OTP verify. verify=' + JSON.stringify(verifyRes));
  }

  // Get Inertia version from add_advertise page
  _inertiaVersion = '';
  await getInertiaVersion(page);

  // Extract cookies
  const finalCookies = await page.cookies();
  let finalSession = '', finalXsrf = '';
  for (const c of finalCookies) {
    if (c.name === 'mzadqatar_session') finalSession = c.value;
    if (c.name === 'XSRF-TOKEN') finalXsrf = c.value;
  }

  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;
  console.log('[Mzad] Login successful! Session:', finalSession.length, 'chars ✓');
  return { session: finalSession, xsrf: finalXsrf, csrfToken: decodedXsrf(finalXsrf), useBrowser: true };
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
  // Try browser cookies before re-login
  if (_page) {
    try {
      console.log('[Mzad] Checking browser cookies for valid session...');
      const cookies = await _page.cookies('https://mzadqatar.com');
      let bSession = '', bXsrf = '';
      for (const c of cookies) {
        if (c.name === 'mzadqatar_session') bSession = c.value;
        if (c.name === 'XSRF-TOKEN') bXsrf = c.value;
      }
      if (bSession && bXsrf) {
        const bValid = await isSessionValid(bSession, bXsrf);
        if (bValid) {
          console.log('[Mzad] Browser session is valid! Updating env.');
          process.env.MZAD_SESSION = bSession;
          process.env.MZAD_XSRF_TOKEN = bXsrf;
          return { session: bSession, xsrf: bXsrf, csrfToken: decodedXsrf(bXsrf) };
        }
        console.log('[Mzad] Browser session also expired');
      }
    } catch (e) {
      console.warn('[Mzad] Browser cookie check failed:', e.message);
    }
  }
  console.log('[Mzad] Re-logging in via OTP...');
  return await loginWithOtp();
}

// ─────────────────────────────────────────────
// Download a placeholder image for ads
// ─────────────────────────────────────────────
async function getPlaceholderImage() {
  const imgPath = path.join(__dirname, 'ad-placeholder.jpg');
  if (fs.existsSync(imgPath)) return imgPath;
  // Create a simple JPEG placeholder
  try {
    console.log('[Mzad] Downloading placeholder image...');
    const res = await axios.get('https://placehold.co/800x600/cccccc/333333?text=Property+For+Rent', {
      responseType: 'arraybuffer',
    });
    fs.writeFileSync(imgPath, res.data);
    console.log('[Mzad] Placeholder image saved to', imgPath);
    return imgPath;
  } catch (e) {
    console.warn('[Mzad] Could not download placeholder, creating minimal JPEG...');
    // Create a minimal valid JPEG (1x1 gray pixel)
    const minJpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
      0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
      0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
      0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
      0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03,
      0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D,
      0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7B, 0x40,
      0x1B, 0xFF, 0xD9
    ]);
    fs.writeFileSync(imgPath, minJpeg);
    return imgPath;
  }
}

// ─────────────────────────────────────────────
// Main post function – 3-step Inertia form
// ─────────────────────────────────────────────
async function postAd(property, sessionData) {
  let { session, xsrf } = sessionData;
  const isComm = isCommercialType(property.Type);
  let categoryId = isComm ? CATEGORY_COMMERCIAL_RENT : CATEGORY_RESIDENTIAL_RENT;
  if (property._overrideCategory) categoryId = property._overrideCategory;

  console.log(`[Mzad] ===== Posting ad for unit ${property.Unit} =====`);
  console.log(`[Mzad] Type: ${property.Type} | Category: ${categoryId} | Commercial: ${isComm}`);

  // Ensure browser is on add_advertise page with correct Inertia version
  if (_page) {
    const currentUrl = _page.url();
    if (!currentUrl.includes('/add_advertise')) {
      console.log('[Mzad] Navigating browser to add_advertise page...');
      _inertiaVersion = '';
      await _page.goto(`${BASE_URL}/en/add_advertise`, { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('[Mzad] On add_advertise page, URL:', _page.url());
      if (_page.url().includes('/login')) {
        throw new Error('Mzad: Redirected to login from add_advertise — session expired');
      }
      await getInertiaVersion(_page);
    } else {
      console.log('[Mzad] Already on add_advertise page');
      if (!_inertiaVersion) await getInertiaVersion(_page);
    }
  }

  // Extract groups/categories from the add_advertise page (for diagnosis)
  let groupsData = null;
  let pageGroupsData = null;
  console.log("[Mzad] Groups extraction: _page exists:", !!_page);
  if (_page) {
    try {
      const pageUrl = _page.url();
      console.log("[Mzad] Current page URL for groups:", pageUrl);
      pageGroupsData = await _page.evaluate(() => {
        try {
          const el = document.querySelector("[data-page]");
          if (!el) return { extractError: "no data-page element", bodyLen: document.body?.innerHTML?.length || 0 };
          const raw = el.getAttribute("data-page");
          if (!raw) return { extractError: "data-page attr is empty" };
          const pd = JSON.parse(raw);
          const comp = pd.component;
          const url = pd.url;
          const isLoggedIn = pd.props?.isLoggedIn;
          const propsKeys = Object.keys(pd.props || {});
          const gAAD = pd?.props?.getAddAdvertiseData;
          if (!gAAD) return { extractError: "no getAddAdvertiseData", component: comp, url: url, isLoggedIn: isLoggedIn, propsKeys: propsKeys };
          const apiData = gAAD.apiData;
          if (!apiData) return { extractError: "no apiData", gAADKeys: Object.keys(gAAD), component: comp, isLoggedIn: isLoggedIn };
          if (!apiData.groups) return { extractError: "no groups in apiData", apiDataKeys: Object.keys(apiData), component: comp, isLoggedIn: isLoggedIn };
          const allProds = apiData.groups.flatMap(g => g.products || []);
          return {
            totalGroups: apiData.groups.length,
            totalProducts: allProds.length,
            groups: apiData.groups.map(g => ({
              groupName: g.groupName,
              clicktype: g.clicktype,
              productCount: (g.products || []).length,
              products: (g.products || []).slice(0, 5).map(p => ({
                productId: p.productId,
                productName: p.productName,
                isAllowToAdd: p.isAllowToAdd,
                packageTag: p.packageTag || null,
                adsCount: p.adsCount,
                adsLimit: p.adsLimit,
              }))
            })),
            cat8494: allProds.find(p => String(p.productId) === "8494") || "NOT FOUND",
            isLoggedIn: isLoggedIn,
            component: comp,
          };
        } catch(innerErr) {
          return { extractError: "evaluate inner error: " + innerErr.message };
        }
      });
      console.log("[Mzad] Groups extraction result:", JSON.stringify(pageGroupsData).substring(0, 3000));
    } catch(e) {
      pageGroupsData = { extractError: "outer catch: " + e.message };
      console.warn("[Mzad] Groups extraction failed:", e.message);
    }
  } else {
    pageGroupsData = { extractError: "_page is null" };
  }

  // ── STEP 1: Language + Category ──
  console.log('[Mzad] Step 1: Submitting language + category...');
  const step1Res = await inertiaPost(`${BASE_URL}/en/add_advertise`, {
    step1Data: {
      categoryId: categoryId,
      lang: 'aren',          // Both Arabic and English
      mzadyUserNumber: '',
    },
    step: 1,
  }, session, xsrf);

  console.log('[Mzad] Step 1 response status:', step1Res.status);
  if (step1Res.cookies['mzadqatar_session']) session = step1Res.cookies['mzadqatar_session'];
    if (step1Res.cookies['mzadqatar_session']) process.env.MZAD_SESSION = session;
  if (step1Res.cookies['XSRF-TOKEN']) xsrf = step1Res.cookies['XSRF-TOKEN'];
    if (step1Res.cookies['XSRF-TOKEN']) process.env.MZAD_XSRF_TOKEN = xsrf;

  if (step1Res.status === 301 || step1Res.status === 302) {
    throw new Error(`Mzad Step 1 redirected to login: status=${step1Res.status}`);
  }
  if (step1Res.status >= 400 && step1Res.status !== 409) {
    throw new Error(`Mzad Step 1 failed: status=${step1Res.status} body=${JSON.stringify(step1Res.data).substring(0, 300)}`);
  }
  console.log('[Mzad] Step 1 data:', JSON.stringify(step1Res.data).substring(0, 500));

  // Extract server-returned prevData from step 1 (Inertia form restores these before step 3)
  let serverStep1Data = null;
  let serverStep = null;
  let s1PrevStep2Data = null;
  try {
    const s1props = typeof step1Res.data === 'string' ? JSON.parse(step1Res.data) : step1Res.data;
    serverStep1Data = s1props?.props?.getAddAdvertiseData?.prevData?.step1Data || null;
    serverStep = s1props?.props?.getAddAdvertiseData?.prevData?.step;
    console.log('[Mzad] Server prevData.step after step 1:', serverStep);
    // Also extract step2Data from Step 1 prevData (server pre-fills when Step 2 is skipped)
    s1PrevStep2Data = s1props?.props?.getAddAdvertiseData?.prevData?.step2Data || null;
    console.log('[Mzad] Server step2Data from step1:', s1PrevStep2Data ? JSON.stringify(s1PrevStep2Data).substring(0, 300) : 'null');
    console.log('[Mzad] Server step1Data prevData:', JSON.stringify(serverStep1Data));
  } catch (e) { console.warn('[Mzad] Could not extract step1 prevData:', e.message); }

  // Extract groups from step 1 response (this is the Inertia response with full apiData)
  try {
    const s1full = typeof step1Res.data === "string" ? JSON.parse(step1Res.data) : step1Res.data;
    const apiData = s1full?.props?.getAddAdvertiseData?.apiData;
    if (apiData?.groups) {
      const allProds = apiData.groups.flatMap(g => g.products || []);
      if (!groupsData || groupsData.extractError) groupsData = {
        source: "step1_response",
        totalGroups: apiData.groups.length,
        totalProducts: allProds.length,
        groups: apiData.groups.map(g => ({
          groupName: g.groupName,
          clicktype: g.clicktype,
          productCount: (g.products || []).length,
          products: (g.products || []).map(p => ({
            productId: p.productId,
            productName: p.productName,
            isAllowToAdd: p.isAllowToAdd,
            packageTag: p.packageTag || null,
            adsCount: p.adsCount,
            adsLimit: p.adsLimit,
          }))
        })),
        cat8494: allProds.find(p => String(p.productId) === "8494") || "NOT FOUND",
      };
      console.log("[Mzad] Groups from step1:", JSON.stringify(groupsData).substring(0, 3000));
    } else {
      console.log("[Mzad] No groups in step1 response. apiData keys:", apiData ? Object.keys(apiData) : "null");
      // Try to log what IS in getAddAdvertiseData
      const gAAD = s1full?.props?.getAddAdvertiseData;
      if (gAAD) {
        if (!groupsData || groupsData.extractError) groupsData = { source: "step1_no_groups", gAADKeys: Object.keys(gAAD), apiDataKeys: apiData ? Object.keys(apiData) : null, step: gAAD.step || gAAD.prevData?.step };
      }
    }
  } catch(e) { console.warn("[Mzad] Groups extraction from step1 failed:", e.message); }

  // Extract the free productId from groups (REQUIRED for step 3)
  let freeProductId = '';
  const grpSrc = groupsData || pageGroupsData;
  if (grpSrc && grpSrc.groups) {
    // First: try to find the exact categoryId match
    for (const g of grpSrc.groups) {
      for (const p of (g.products || [])) {
        if (String(p.productId) === String(categoryId) && p.isAllowToAdd) {
          freeProductId = String(p.productId);
          console.log('[Mzad] Found matching productId:', freeProductId, '(matches categoryId)');
          break;
        }
      }
      if (freeProductId) break;
    }
    // Fallback: pick first free product if exact match not found
    if (!freeProductId) {
      for (const g of grpSrc.groups) {
        for (const p of (g.products || [])) {
          if (p.isAllowToAdd) {
            freeProductId = String(p.productId);
            console.log('[Mzad] Found free productId (fallback):', freeProductId, 'group:', g.groupName);
            break;
          }
        }
        if (freeProductId) break;
      }
    }
  }
  if (!freeProductId) {
    console.warn('[Mzad] WARNING: No free productId found! Will try adsSelectedData...');
    try {
      const s1f = typeof step1Res.data === 'string' ? JSON.parse(step1Res.data) : step1Res.data;
      const asd = s1f?.props?.getAddAdvertiseData?.adsSelectedData;
      if (asd) {
        console.log('[Mzad] adsSelectedData:', JSON.stringify(asd).substring(0, 500));
        if (asd.productId) freeProductId = String(asd.productId);
      }
    } catch(e2) {}
  }
  console.log('[Mzad] productId for step3:', freeProductId || '(empty)');

  // Check if server already advanced past step 2 (e.g. category skips step 2)
  let serverStep2Data = null;
  let step2Res = { status: 200, data: {}, cookies: {} }; // default for skipped step 2
  const shouldSkipStep2 = (typeof serverStep !== "undefined" && serverStep !== null && parseInt(serverStep) >= 2);
  if (shouldSkipStep2) {
    console.log("[Mzad] SKIPPING Step 2: server prevData.step =", serverStep, "(already past step 2)");
    // Use step2Data from Step 1 response (server pre-filled it)
    if (typeof s1PrevStep2Data !== 'undefined' && s1PrevStep2Data) {
      serverStep2Data = s1PrevStep2Data;
      console.log("[Mzad] Using step2Data from Step 1 prevData:", JSON.stringify(serverStep2Data).substring(0, 300));
    }
  } else {
  // ── STEP 2: Property details ──
  console.log('[Mzad] Step 2: Submitting property details...');

  const rooms = parseInt(property.Bedrooms) || 3;
  const baths = parseInt(property.Bathrooms) || 2;
  const area = parseInt(property.Size_sqm) || 150;
  const floor = parseInt(property.Floor) || 1;

  // Map floor to levels dropdown ID
  const levelId = DROPDOWN_IDS.levels[Math.min(floor, 10)] || DROPDOWN_IDS.levels[1];
  // Map bathrooms to dropdown ID
  const bathId = DROPDOWN_IDS.bathrooms[Math.min(baths, 8)] || DROPDOWN_IDS.bathrooms[2];
  // Subcategory based on property type
  const subCatId = isComm ? DROPDOWN_IDS.subCategoryRes.OtherProperty : getSubCategoryId(property.Type);

  const step2Data = {
    cityId: DROPDOWN_IDS.cities.Doha,       // 3 = Doha
    regionId: '38',                          // Al Bidda (Doha) - default
    numberOfRooms: rooms,
    location: property.Maps_Link || '',
    categoryAdvertiseTypeId: '3',            // Rent
    furnishedTypeId: DROPDOWN_IDS.furnishing.NotFurnished,  // 107
    properterylevel: levelId,
    lands_area: area,
    properteryfinishing: DROPDOWN_IDS.finishing.FullyFinished, // 366
    properterybathrooms: bathId,
    salesref: '',
    rentaltype: DROPDOWN_IDS.rentalType.Monthly,  // 791
    subCategoryId: subCatId,
  };

  console.log('[Mzad] Step 2 data:', JSON.stringify(step2Data));
  step2Res = await inertiaPost(`${BASE_URL}/en/add_advertise`, {
    step: 2,
    step1Data: { categoryId: categoryId, lang: 'aren', mzadyUserNumber: '' },
    step2Data: step2Data,
    step3Data: {},
  }, session, xsrf);

  console.log('[Mzad] Step 2 response status:', step2Res.status);
  if (step2Res.cookies['mzadqatar_session']) session = step2Res.cookies['mzadqatar_session'];
    if (step2Res.cookies['mzadqatar_session']) process.env.MZAD_SESSION = session;
  if (step2Res.cookies['XSRF-TOKEN']) xsrf = step2Res.cookies['XSRF-TOKEN'];
    if (step2Res.cookies['XSRF-TOKEN']) process.env.MZAD_XSRF_TOKEN = xsrf;

  if (step2Res.status === 301 || step2Res.status === 302) {
    throw new Error(`Mzad Step 2 redirected: status=${step2Res.status}`);
  }
  if (step2Res.status >= 400 && step2Res.status !== 409) {
    throw new Error(`Mzad Step 2 failed: status=${step2Res.status} body=${JSON.stringify(step2Res.data).substring(0, 300)}`);
  }
  console.log('[Mzad] Step 2 data:', JSON.stringify(step2Res.data).substring(0, 500));

  // Extract server-returned prevData from step 2
  serverStep2Data = null;
  try {
    const s2props = typeof step2Res.data === 'string' ? JSON.parse(step2Res.data) : step2Res.data;
    serverStep2Data = s2props?.props?.getAddAdvertiseData?.prevData?.step2Data || null;
    const prevData = s2props?.props?.getAddAdvertiseData?.prevData;
    console.log('[Mzad] Server step2 prevData keys:', prevData ? Object.keys(prevData) : 'null');
    console.log('[Mzad] Server step2Data prevData:', JSON.stringify(serverStep2Data).substring(0, 500));
    if (prevData?.step1Data) serverStep1Data = prevData.step1Data;
  } catch (e) { console.warn('[Mzad] Could not extract step2 prevData:', e.message); }

  } // end step 2 conditional
  // ── STEP 3: Title, Description, Price, Image, Publish ──
  console.log('[Mzad] Step 3: Submitting ad content + publish...');

  const price = parseInt(property.Rent_QAR) || 5000;
  const titleEn = buildTitleEn(property);
  const titleAr = buildTitleAr(property);
  const desc = buildDescription(property);

  // Get placeholder image
  const imagePath = await getPlaceholderImage();
  console.log('[Mzad] Using image:', imagePath);

  // Step 3 may use FormData for image upload, or JSON with base64.
  // Try JSON first (matching steps 1 & 2 pattern), fall back to FormData.
  const step3Data = {
    productPrice: price,
    productNameEnglish: titleEn,
    productDescriptionEnglish: desc,
    productNameArabic: titleAr,
    productDescriptionArabic: desc,
    autoRenew: false,
    agree_commission: 1,
  };

  // Upload image via browser FormData (bypass CF)
  const imgBuffer = fs.readFileSync(imagePath);
  const imgBase64 = imgBuffer.toString('base64');

  let step3Res;
  let currencyId = 1; // default fallback (hoisted for resubmit access)
  // ── STEP 3: Browser FormData (same session context as steps 1-2) ──
  {
    const s1 = serverStep1Data || { categoryId: categoryId, lang: 'aren', mzadyUserNumber: '' };
    const s2 = serverStep2Data || {};
    const csrf = decodedXsrf(xsrf);
    const ver = _inertiaVersion || '';
    console.log('[Mzad] Step 3: s1Data:', JSON.stringify(s1));
    console.log('[Mzad] Step 3: s2Data:', JSON.stringify(s2).substring(0, 500));
    console.log('[Mzad] Step 3: productId:', freeProductId, 'price:', price, 'browser:', !!_page);

    if (_page) {
      try {
        await _page.setCookie(
          { name: 'mzadqatar_session', value: session, domain: 'mzadqatar.com', path: '/', httpOnly: true },
          { name: 'XSRF-TOKEN', value: xsrf, domain: 'mzadqatar.com', path: '/' }
        );
      } catch (e) { console.warn('[Mzad] Cookie sync error:', e.message); }

      step3Res = await _page.evaluate(async (url, p, tEn, dEn, tAr, dAr, imgB64, csrfToken, inertiaVer, s1Data, s2Data, prodId) => {
        const byteChars = atob(imgB64);
        const byteArr = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
        const blob = new Blob([byteArr], { type: 'image/jpeg' });
        function appendFD(fd, key, value) {
          if (value === null || value === undefined) fd.append(key, '');
          else if (value instanceof Blob || value instanceof File) fd.append(key, value, 'property.jpg');
          else if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value)) appendFD(fd, key + '[' + k + ']', v);
          } else if (Array.isArray(value)) {
            if (value.length === 0) fd.append(key, '');
            else for (let i = 0; i < value.length; i++) appendFD(fd, key + '[' + i + ']', value[i]);
          } else fd.append(key, String(value));
        }
        const fd = new FormData();
        fd.append('step', '3');
        appendFD(fd, 'step1Data', s1Data || {});
        appendFD(fd, 'step2Data', s2Data || {});
        appendFD(fd, 'step3Data', {
          productPrice: String(p),
          productNameEnglish: tEn, productDescriptionEnglish: dEn,
          productNameArabic: tAr, productDescriptionArabic: dAr,
          productNameArEn: '', productDescriptionArEn: '',
          autoRenew: '0', agree_commission: '1', currencyId: '1',
          isResetImages: '0', productId: prodId || '',
          images: [{ id: '0', type: 'image/jpeg', url: '', tempFile: blob }],
        });
        const entries = [];
        for (const [k, v] of fd.entries()) entries.push(k + '=' + (v instanceof Blob ? '[Blob]' : String(v).substring(0, 60)));
        console.log('[Step3-FD]', entries.length, 'entries:', entries.slice(0, 20).join(' | '));
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'text/html, application/xhtml+xml',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia': 'true',
            'X-Inertia-Version': inertiaVer,
            'X-XSRF-TOKEN': csrfToken,
          },
          body: fd, credentials: "include",
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        let apiSafe = null;
        if (json && json.props && json.props.getAddAdvertiseData && json.props.getAddAdvertiseData.apiData) {
          const ad = json.props.getAddAdvertiseData.apiData;
          apiSafe = { keys: Object.keys(ad), didNotSaved: ad.didNotSaved, message: ad.message || ad.statusMsg, status: ad.status };
        }
        return {
          status: res.status,
          data: json ? {
            component: json.component, url: json.url, errors: json.props ? json.props.errors : null,
            getAddAdvertiseData: (json.props && json.props.getAddAdvertiseData) ? {
              step: json.props.getAddAdvertiseData.prevData ? json.props.getAddAdvertiseData.prevData.step : null,
              apiData: apiSafe,
            } : null,
          } : text.substring(0, 1500),
          isJson: !!json,
        };
      }, BASE_URL + '/en/add_advertise', price, titleEn, desc, titleAr, desc, imgBase64,
         csrf, ver, s1, s2, freeProductId || '');
      step3Res = { status: step3Res.status, data: step3Res.data };
    } else {
      // No browser: axios FormData fallback
      const form = new FormData();
      form.append('step', '3');
      for (const [k, v] of Object.entries(s1)) form.append('step1Data[' + k + ']', v == null ? '' : String(v));
      for (const [k, v] of Object.entries(s2)) form.append('step2Data[' + k + ']', v == null ? '' : String(v));
      form.append('step3Data[productPrice]', String(price));
      form.append('step3Data[productNameEnglish]', titleEn);
      form.append('step3Data[productDescriptionEnglish]', desc);
      form.append('step3Data[productNameArabic]', titleAr);
      form.append('step3Data[productDescriptionArabic]', desc);
      form.append('step3Data[autoRenew]', '0');
      form.append('step3Data[agree_commission]', '1');
      form.append('step3Data[currencyId]', '1');
      form.append('step3Data[isResetImages]', '0');
      form.append('step3Data[productId]', freeProductId || '');
      form.append('step3Data[images][0][id]', '0');
      form.append('step3Data[images][0][type]', 'image/jpeg');
      form.append('step3Data[images][0][url]', '');
      form.append('step3Data[images][0][tempFile]', fs.createReadStream(imagePath), { filename: 'property.jpg', contentType: 'image/jpeg' });
      const axiosRes = await axios.post(BASE_URL + '/en/add_advertise', form, {
        headers: { ...form.getHeaders(), 'X-Requested-With': 'XMLHttpRequest', 'X-Inertia': 'true', 'X-Inertia-Version': ver, 'X-XSRF-TOKEN': csrf, 'Cookie': buildCookieStr(session, xsrf), 'Origin': BASE_URL, 'Referer': BASE_URL + '/en/add_advertise' },
        maxRedirects: 0, validateStatus: s => s <= 500, maxContentLength: 50 * 1024 * 1024,
      });
      step3Res = axiosRes;
    }
    console.log('[Mzad] Step 3 status:', step3Res.status);
    console.log('[Mzad] Step 3 data:', JSON.stringify(step3Res.data).substring(0, 2000));
  }

  console.log('[Mzad] Step 3 response status:', step3Res.status);
  console.log('[Mzad] Step 3 response data:', JSON.stringify(step3Res.data).substring(0, 2000));

  // Extract and log apiData separately (it gets truncated in the main data log)
  const s3data = step3Res.data;
  const s3ApiData = s3data?.getAddAdvertiseData?.apiData;
  if (s3ApiData) {
    console.log('[Mzad] Step 3 apiData:', JSON.stringify(s3ApiData));
    if (s3ApiData.didNotSaved) {
      console.error('[Mzad] Server says didNotSaved:', s3ApiData.message || 'no message');
    }
  }
  console.log('[Mzad] Step 3 url:', s3data?.url, 'step:', s3data?.getAddAdvertiseData?.step);
  const errors = s3data?.errors || s3data?.props?.errors;
  if (errors && Object.keys(errors).length > 0) {
    console.error('[Mzad] Validation errors:', JSON.stringify(errors));
    throw new Error('Mzad validation errors: ' + JSON.stringify(errors));
  }

  // Check step 3 result
  const s3gAAD = s3data?.getAddAdvertiseData;
  const s3url = s3data?.url;
  
  // SILENT FAILURE CHECK: paid category redirects to myads without error
  if (!s3ApiData && s3url && s3url.includes('/myads') && categoryId !== 200) {
    console.error("[Mzad] Step 3 silent failure: redirected to myads with no apiData. Category", categoryId, "likely requires package.");
    console.log("[Mzad] Triggering fallback to next category...");
    const fallbackProp = { ...property, _overrideCategory: property._triedCat8 ? 200 : 8 }; fallbackProp._triedCat8 = true;
    return postAd(fallbackProp, { session, xsrf });
  }
  
  // If apiData has didNotSaved, the ad was NOT created
  if (s3ApiData?.didNotSaved) {
    console.error("[Mzad] Step 3 failed: didNotSaved =", s3ApiData.didNotSaved, "message:", s3ApiData.message);
    // FALLBACK: If package error, retry with Others (cat 9)
    if (s3ApiData.message && (s3ApiData.message.includes("subscribed to packages") || s3ApiData.message.includes("Free ads limit")) && categoryId !== 200) {
      console.log("[Mzad] Error for cat", categoryId, ":", s3ApiData.message, "- fallback to next cat");
      const fallbackProp = { ...property, _overrideCategory: property._triedCat8 ? 200 : 8 }; fallbackProp._triedCat8 = true;
      return postAd(fallbackProp, { session, xsrf });
    }
    return {
      success: false, unit: property.Unit, method: "step3_didNotSaved",
      step1: { status: step1Res.status }, step2: { status: step2Res.status },
      step3: { status: step3Res.status, url: s3url, apiData: s3ApiData, step: s3gAAD?.step },
      groupsData: groupsData,
      pageGroupsData: pageGroupsData,
    };
  }
  
  // If step 3 returned 200 with no didNotSaved and no errors,
  // the ad was likely created. Do NOT resubmit (resubmit causes subscription error).
  if (step3Res.status === 200 && (!errors || Object.keys(errors).length === 0)) {
    console.log("[Mzad] Step 3 returned 200 with no errors and no didNotSaved. Ad likely created!");
    console.log("[Mzad] Step 3 url:", s3url, "step:", s3gAAD?.step);
    return {
      success: true, unit: property.Unit, method: "step3_no_error",
      step1: { status: step1Res.status }, step2: { status: step2Res.status },
      step3: { status: step3Res.status, url: s3url, apiData: s3ApiData || null, step: s3gAAD?.step },
      groupsData: groupsData,
      pageGroupsData: pageGroupsData,
    };
  }


  // If step 3 JSON approach fails, try alternative with JSON body including base64 image
  if (step3Res.status >= 400) {
    console.log('[Mzad] Step 3 FormData failed, trying JSON with base64 image...');
    const imgBuffer = fs.readFileSync(imagePath);
    const imgBase64 = imgBuffer.toString('base64');
    const step3JsonRes = await inertiaPost(`${BASE_URL}/en/add_advertise`, {
      step: 3,
      step3Data: {
        ...step3Data,
        images: [`data:image/jpeg;base64,${imgBase64}`],
      }
    }, session, xsrf);
    console.log('[Mzad] Step 3 JSON response status:', step3JsonRes.status);
    console.log('[Mzad] Step 3 JSON response data:', JSON.stringify(step3JsonRes.data).substring(0, 1000));
    if (step3JsonRes.status >= 400) {
      throw new Error(`Mzad Step 3 failed: status=${step3JsonRes.status} body=${JSON.stringify(step3JsonRes.data).substring(0, 500)}`);
    }
    return {
      success: true,
      unit: property.Unit,
      method: 'json_base64_fallback',
      step1: { status: step1Res.status },
      step2: { status: step2Res.status },
      step3: { status: step3JsonRes.status, data: JSON.stringify(step3JsonRes.data).substring(0, 1500) },
    };
  }

  console.log(`[Mzad] ===== Ad posted for unit ${property.Unit}! =====`);
  return {
    success: true,
    unit: property.Unit,
    step1: { status: step1Res.status },
    step2: { status: step2Res.status },
    step3: { status: step3Res.status, url: s3data?.url, apiData: s3ApiData || null, step: s3data?.getAddAdvertiseData?.step },
    groupsData: groupsData,
    pageGroupsData: pageGroupsData,
  };
}


// Diagnostic: Extract groups/categories data from add_advertise page
// Diagnostic: Navigate to add_advertise and extract ALL page data
async function getGroupsData() {
  if (!_page) return { error: "No browser. Call /debug-mzad-steps?fresh=1 first." };
  
  try {
    // Reload add_advertise page to get fresh initial data
    console.log("[Mzad] getGroupsData: navigating to add_advertise...");
    await _page.goto("https://www.mzadqatar.com/en/add_advertise", { waitUntil: "networkidle2", timeout: 30000 });
    const pageUrl = _page.url();
    console.log("[Mzad] getGroupsData: page URL:", pageUrl);
    
    if (pageUrl.includes("/login")) return { error: "Redirected to login - session expired", url: pageUrl };
    
    const result = await _page.evaluate(() => {
      const el = document.querySelector("[data-page]");
      if (!el) return { error: "no data-page", bodyText: document.body?.innerText?.substring(0, 500) };
      const raw = el.getAttribute("data-page");
      if (!raw) return { error: "empty data-page" };
      const pd = JSON.parse(raw);
      const p = pd.props || {};
      const gAAD = p.getAddAdvertiseData;
      
      // Basic page info
      const info = {
        component: pd.component,
        url: pd.url,
        isLoggedIn: p.isLoggedIn,
        propsKeys: Object.keys(p),
        userData: p.classifiedUserData ? { id: p.classifiedUserData.userId, name: p.classifiedUserData.userName, phone: p.classifiedUserData.mobileNumber } : null,
      };
      
      if (!gAAD) return { ...info, error: "no getAddAdvertiseData" };
      
      info.gAADKeys = Object.keys(gAAD);
      info.step = gAAD.step;
      info.isEdit = gAAD.isEdit;
      info.isCompleted = gAAD.isCompleted;
      
      if (gAAD.apiData) {
        info.apiDataKeys = Object.keys(gAAD.apiData);
        if (gAAD.apiData.groups) {
          const grps = gAAD.apiData.groups;
          info.totalGroups = grps.length;
          info.groups = grps.map(g => ({
            name: g.groupName,
            click: g.clicktype,
            count: (g.products || []).length,
            products: (g.products || []).map(p => ({
              id: p.productId,
              name: p.productName,
              allow: p.isAllowToAdd,
              pkg: p.packageTag || null,
              ads: p.adsCount,
              limit: p.adsLimit,
            }))
          }));
          const all = grps.flatMap(g => g.products || []);
          info.totalProducts = all.length;
          info.cat8494 = all.find(p => String(p.productId) === "8494") || "NOT_FOUND";
        }
      }
      
      if (gAAD.adsSelectedData) info.adsSelectedData = gAAD.adsSelectedData;
      if (gAAD.prevData) info.prevData = gAAD.prevData;
      
      return info;
    });
    
    console.log("[Mzad] getGroupsData result:", JSON.stringify(result).substring(0, 2000));
    return result;
  } catch(e) {
    return { error: "getGroupsData exception: " + e.message };
  }
}


async function getAccountStatus() {
  if (!_page) return { error: "No browser. Login first via /debug-mzad-steps?fresh=1" };
  try {
    // Navigate to user profile to see subscription/package status
    await _page.goto("https://www.mzadqatar.com/en/user/profile", { waitUntil: "networkidle2", timeout: 30000 });
    const profileData = await _page.evaluate(() => {
      try {
        const el = document.querySelector("[data-page]");
        if (!el) return { error: "no data-page element" };
        const raw = el.getAttribute("data-page");
        const pd = JSON.parse(raw);
        return {
          component: pd.component,
          url: pd.url,
          propsKeys: pd.props ? Object.keys(pd.props) : [],
          userData: pd.props?.userData || null,
          classifiedUserData: pd.props?.classifiedUserData || null,
          packageInfo: pd.props?.packageInfo || pd.props?.getUserPackageInfo || null,
          subscription: pd.props?.subscription || null,
          allPropsPreview: JSON.stringify(pd.props).substring(0, 3000)
        };
      } catch(e) { return { error: e.message }; }
    });
    
    // Also try the purchase/ad-limit page
    await _page.goto("https://www.mzadqatar.com/en/user/profile/purchase/ad-limit", { waitUntil: "networkidle2", timeout: 30000 });
    const adLimitData = await _page.evaluate(() => {
      try {
        const el = document.querySelector("[data-page]");
        if (!el) return { error: "no data-page element" };
        const raw = el.getAttribute("data-page");
        const pd = JSON.parse(raw);
        return {
          component: pd.component,
          url: pd.url,
          propsKeys: pd.props ? Object.keys(pd.props) : [],
          packages: pd.props?.packages || null,
          userPackages: pd.props?.userPackages || null,
          adLimit: pd.props?.adLimit || null,
          allPropsPreview: JSON.stringify(pd.props).substring(0, 3000)
        };
      } catch(e) { return { error: e.message }; }
    });
    
    // Navigate back to add_advertise for future operations
    await _page.goto("https://www.mzadqatar.com/en/add_advertise", { waitUntil: "networkidle2", timeout: 30000 });
    
    return { profileData, adLimitData };
  } catch(e) {
    return { error: e.message };
  }
}



// ═══════════════════════════════════════════════════════════
// Manual OTP login (2-phase)
// ═══════════════════════════════════════════════════════════
async function sendOtpOnly() {
  const phone = process.env.MZAD_PHONE || '70297066';
  const page = await getBrowserPage();
  console.log('[Mzad Manual] On login page, URL:', page.url());

  const inertiaVer = await getInertiaVersion(page);
  const cookies = await page.cookies();
  let xsrf = '';
  for (const c of cookies) { if (c.name === 'XSRF-TOKEN') xsrf = c.value; }
  const csrf = decodedXsrf(xsrf);

  // Get reCAPTCHA token
  let recaptchaToken = null;
  try {
    await page.waitForFunction(() => typeof grecaptcha !== 'undefined' && typeof grecaptcha.execute === 'function', { timeout: 10000 });
    recaptchaToken = await page.evaluate(async (siteKey) => {
      return await grecaptcha.execute(siteKey, { action: 'login' });
    }, MZAD_RECAPTCHA_SITE_KEY);
    console.log('[Mzad Manual] reCAPTCHA token obtained');
  } catch (e) {
    console.warn('[Mzad Manual] Browser reCAPTCHA failed:', e.message);
    recaptchaToken = await solveRecaptchaV3('login');
  }

  // Send OTP
  console.log('[Mzad Manual] Sending OTP for phone:', phone);
  const otpRes = await page.evaluate(async (baseUrl, ph, token, csrfToken, ver) => {
    try {
      const res = await fetch(baseUrl + '/en/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': ver || '',
          'X-XSRF-TOKEN': csrfToken,
          'Accept': 'text/html, application/xhtml+xml',
        },
        body: JSON.stringify({ phone: ph, otp: '', countryId: 176, countryCode: '974', recaptchaToken: token || '' }),
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 500), ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, BASE_URL, phone, recaptchaToken, csrf, inertiaVer);

  console.log('[Mzad Manual] OTP send result:', JSON.stringify(otpRes));

  if (otpRes.body && otpRes.body.includes('three times in one hour')) {
    return { success: false, error: 'RATE_LIMITED: 3 OTPs/hour exceeded. Wait 1 hour.' };
  }

  return { success: true, message: 'OTP sent to phone ' + phone + '. Now call /mzad-verify-otp?code=XXXXXX', otpResponse: otpRes };
}

async function verifyOtpOnly(otpCode) {
  if (!_page) throw new Error('No browser page. Call /mzad-send-otp first.');
  const phone = process.env.MZAD_PHONE || '70297066';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const cookies2 = await _page.cookies();
  let xsrf2 = '';
  for (const c of cookies2) { if (c.name === 'XSRF-TOKEN') xsrf2 = c.value; }
  const csrf2 = decodedXsrf(xsrf2);
  const inertiaVer = _inertiaVersion || '';

  const otpDigits = otpCode.toString().padEnd(6, '0').split('').slice(0, 6);
  console.log('[Mzad Manual] Verifying OTP:', otpCode);
  
  const verifyRes = await _page.evaluate(async (baseUrl, ph, otp, digits, csrfToken, ver) => {
    try {
      const res = await fetch(baseUrl + '/en/login-verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': ver || '',
          'X-XSRF-TOKEN': csrfToken,
          'Accept': 'text/html, application/xhtml+xml',
        },
        body: JSON.stringify({
          otp_0: digits[0], otp_1: digits[1], otp_2: digits[2],
          otp_3: digits[3], otp_4: digits[4], otp_5: digits[5],
          otp: otp, username: ph, countryId: 176, countryCode: '974',
        }),
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 500), ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, BASE_URL, phone, otpCode, otpDigits, csrf2, inertiaVer);

  console.log('[Mzad Manual] Verify result:', JSON.stringify(verifyRes));

  // Validate by navigating to add_advertise
  await delay(2000);
  await _page.goto(BASE_URL + '/en/add_advertise', { waitUntil: 'networkidle2', timeout: 30000 });
  const finalUrl = _page.url();

  if (finalUrl.includes('/login')) {
    return { success: false, error: 'Login failed after OTP verify', verifyRes };
  }

  // Get Inertia version
  _inertiaVersion = '';
  await getInertiaVersion(_page);

  // Extract cookies
  const finalCookies = await _page.cookies();
  let finalSession = '', finalXsrf = '';
  for (const c of finalCookies) {
    if (c.name === 'mzadqatar_session') finalSession = c.value;
    if (c.name === 'XSRF-TOKEN') finalXsrf = c.value;
  }

  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;
  console.log('[Mzad Manual] Login successful! Session:', finalSession.length, 'chars');
  
  return { success: true, message: 'Logged in successfully. Session stored. Ready to post ads.', sessionLength: finalSession.length };
}

module.exports = { getSession, postAd, closeBrowser, getGroupsData, getAccountStatus, sendOtpOnly, verifyOtpOnly, _getPage: () => _page };
 
