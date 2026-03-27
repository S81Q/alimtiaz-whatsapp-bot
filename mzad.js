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
    // If browser is available, use it (bypass CF)
    if (_page) {
      const res = await browserFetch(_page, `${BASE_URL}/en/add_advertise`, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Inertia': 'true', 'X-Inertia-Version': _inertiaVersion || '', 'Accept': 'text/html, application/xhtml+xml' },
        credentials: 'include',
      });
      const isValid = res.status === 200 && !res.body.includes('/login');
      console.log('[Mzad] Session check (browser): status=' + res.status + ' valid=' + isValid);
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
    return { status: res.status, body: text.substring(0, 3000), json, headers: Object.fromEntries(res.headers.entries()) };
  }, url, options);
}

async function loginWithOtp() {
  const { readOtpFromGmail } = require('./gmail-otp');
  const phone = process.env.MZAD_PHONE || '70297066';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const page = await getBrowserPage();

  // Extract XSRF token from cookie
  const cookies = await page.cookies();
  let xsrf = '';
  for (const c of cookies) {
    if (c.name === 'XSRF-TOKEN') xsrf = c.value;
  }
  const csrf = decodedXsrf(xsrf);
  console.log('[Mzad] XSRF token from browser:', xsrf.length, 'chars');

  // Get Inertia version from the loaded page
  const inertiaVer = await getInertiaVersion(page);

  // Solve reCAPTCHA
  const recaptchaToken1 = await solveRecaptchaV3('login');
  console.log('[Mzad] Sending OTP request to phone', phone);

  // Make OTP request via browser's fetch
  const otpRes = await browserFetch(page, `${BASE_URL}/en/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'X-Inertia-Version': inertiaVer,
      'X-XSRF-TOKEN': csrf,
      'Accept': 'text/html, application/xhtml+xml',
    },
    body: JSON.stringify({ phone, recaptchaToken: recaptchaToken1 || 'placeholder-token' }),
    credentials: 'include',
  });

  console.log('[Mzad] OTP request status:', otpRes.status);
  console.log('[Mzad] OTP response (300):', otpRes.body.substring(0, 300));

  if (otpRes.status >= 400) {
    throw new Error(`Mzad OTP request failed: status=${otpRes.status} body=${otpRes.body.substring(0, 200)}`);
  }

  // Wait for OTP
  console.log('[Mzad] Waiting 10s for OTP delivery...');
  await delay(10000);
  const otp = await readOtpFromGmail('mzad');
  if (!otp) throw new Error('Mzad: Could not retrieve OTP from Gmail');

  // Solve reCAPTCHA again
  const recaptchaToken2 = await solveRecaptchaV3('login');

  // Get fresh XSRF (may have changed)
  const cookies2 = await page.cookies();
  let xsrf2 = '';
  for (const c of cookies2) {
    if (c.name === 'XSRF-TOKEN') xsrf2 = c.value;
  }
  const csrf2 = decodedXsrf(xsrf2);

  // Verify OTP via browser's fetch
  console.log('[Mzad] Verifying OTP:', otp);
  const verifyRes = await browserFetch(page, `${BASE_URL}/en/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'X-Inertia-Version': inertiaVer,
      'X-XSRF-TOKEN': csrf2,
      'Accept': 'text/html, application/xhtml+xml',
    },
    body: JSON.stringify({ phone, otp, recaptchaToken: recaptchaToken2 || 'placeholder-token' }),
    credentials: 'include',
    redirect: 'manual',
  });

  console.log('[Mzad] OTP verify status:', verifyRes.status);
  console.log('[Mzad] OTP verify body (300):', verifyRes.body.substring(0, 300));

  // Extract final cookies from browser
  const finalCookies = await page.cookies();
  let finalSession = '', finalXsrf = '';
  for (const c of finalCookies) {
    if (c.name === 'mzadqatar_session') finalSession = c.value;
    if (c.name === 'XSRF-TOKEN') finalXsrf = c.value;
  }

  console.log('[Mzad] Final session:', finalSession.length, 'chars');
  process.env.MZAD_SESSION = finalSession;
  process.env.MZAD_XSRF_TOKEN = finalXsrf;

  // Validate by trying to access add_advertise from browser
  console.log('[Mzad] Validating session by navigating to add_advertise...');
  const checkRes = await browserFetch(page, `${BASE_URL}/en/add_advertise`, {
    method: 'GET',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      'X-Inertia-Version': inertiaVer,
      'Accept': 'text/html, application/xhtml+xml',
    },
    credentials: 'include',
  });
  console.log('[Mzad] add_advertise check status:', checkRes.status);

  if (checkRes.status === 302 || checkRes.status === 301 || checkRes.body.includes('/login')) {
    throw new Error('Mzad login: session not authenticated after OTP verify. Check status=' + checkRes.status);
  }

  console.log('[Mzad] Login successful and validated! ✓');
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
  const categoryId = isComm ? CATEGORY_COMMERCIAL_RENT : CATEGORY_RESIDENTIAL_RENT;

  console.log(`[Mzad] ===== Posting ad for unit ${property.Unit} =====`);
  console.log(`[Mzad] Type: ${property.Type} | Category: ${categoryId} | Commercial: ${isComm}`);

  // Navigate browser to add_advertise page first (sets correct Inertia version + context)
  if (_page) {
    console.log('[Mzad] Navigating browser to add_advertise page...');
    _inertiaVersion = ''; // Reset to get fresh version
    await _page.goto(`${BASE_URL}/en/add_advertise`, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[Mzad] On add_advertise page, URL:', _page.url());
    if (_page.url().includes('/login')) {
      throw new Error('Mzad: Redirected to login from add_advertise — session expired');
    }
    await getInertiaVersion(_page);
  }

  // ── STEP 1: Language + Category ──
  console.log('[Mzad] Step 1: Submitting language + category...');
  const step1Res = await inertiaPost(`${BASE_URL}/en/add_advertise`, {
    step: 1,
    step1Data: {
      categoryId: categoryId,
      lang: 'aren',          // Both Arabic and English
      mzadyUserNumber: '',
    }
  }, session, xsrf);

  console.log('[Mzad] Step 1 response status:', step1Res.status);
  if (step1Res.cookies['mzadqatar_session']) session = step1Res.cookies['mzadqatar_session'];
  if (step1Res.cookies['XSRF-TOKEN']) xsrf = step1Res.cookies['XSRF-TOKEN'];

  if (step1Res.status === 301 || step1Res.status === 302) {
    throw new Error(`Mzad Step 1 redirected to login: status=${step1Res.status}`);
  }
  if (step1Res.status >= 400 && step1Res.status !== 409) {
    throw new Error(`Mzad Step 1 failed: status=${step1Res.status} body=${JSON.stringify(step1Res.data).substring(0, 300)}`);
  }
  console.log('[Mzad] Step 1 data:', JSON.stringify(step1Res.data).substring(0, 500));

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
  const step2Res = await inertiaPost(`${BASE_URL}/en/add_advertise`, {
    step: 2,
    step2Data: step2Data,
  }, session, xsrf);

  console.log('[Mzad] Step 2 response status:', step2Res.status);
  if (step2Res.cookies['mzadqatar_session']) session = step2Res.cookies['mzadqatar_session'];
  if (step2Res.cookies['XSRF-TOKEN']) xsrf = step2Res.cookies['XSRF-TOKEN'];

  if (step2Res.status === 301 || step2Res.status === 302) {
    throw new Error(`Mzad Step 2 redirected: status=${step2Res.status}`);
  }
  if (step2Res.status >= 400 && step2Res.status !== 409) {
    throw new Error(`Mzad Step 2 failed: status=${step2Res.status} body=${JSON.stringify(step2Res.data).substring(0, 300)}`);
  }
  console.log('[Mzad] Step 2 data:', JSON.stringify(step2Res.data).substring(0, 500));

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
    price: price,
    titleEn: titleEn,
    descriptionEn: desc,
    titleAr: titleAr,
    descriptionAr: desc,
    autoRenew: false,
    termsAgreed: true,
  };

  // Upload image via browser FormData (bypass CF)
  const imgBuffer = fs.readFileSync(imagePath);
  const imgBase64 = imgBuffer.toString('base64');

  let step3Res;
  if (_page) {
    console.log('[Mzad] Step 3: Using browser fetch with FormData...');
    const csrf = decodedXsrf(xsrf);
    step3Res = await _page.evaluate(async (url, p, tEn, dEn, tAr, dAr, imgB64, csrfToken) => {
      // Convert base64 to Blob
      const byteChars = atob(imgB64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteArr], { type: 'image/jpeg' });

      const fd = new FormData();
      fd.append('step', '3');
      fd.append('step3Data[price]', String(p));
      fd.append('step3Data[titleEn]', tEn);
      fd.append('step3Data[descriptionEn]', dEn);
      fd.append('step3Data[titleAr]', tAr);
      fd.append('step3Data[descriptionAr]', dAr);
      fd.append('step3Data[autoRenew]', 'false');
      fd.append('step3Data[termsAgreed]', 'true');
      fd.append('step3Data[images][]', blob, 'property.jpg');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-Inertia': 'true',
          'X-Inertia-Version': '',
          'X-XSRF-TOKEN': csrfToken,
        },
        body: fd,
        credentials: 'include',
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, data: json || text };
    }, `${BASE_URL}/en/add_advertise`, price, titleEn, desc, titleAr, desc, imgBase64, csrf);
    // Wrap to match expected format
    step3Res = { status: step3Res.status, data: step3Res.data };
  } else {
    // Fallback: axios FormData
    const form = new FormData();
    form.append('step', '3');
    form.append('step3Data[price]', String(price));
    form.append('step3Data[titleEn]', titleEn);
    form.append('step3Data[descriptionEn]', desc);
    form.append('step3Data[titleAr]', titleAr);
    form.append('step3Data[descriptionAr]', desc);
    form.append('step3Data[autoRenew]', 'false');
    form.append('step3Data[termsAgreed]', 'true');
    form.append('step3Data[images][]', fs.createReadStream(imagePath), {
      filename: 'property.jpg', contentType: 'image/jpeg',
    });
    const axiosRes = await axios.post(`${BASE_URL}/en/add_advertise`, form, {
      headers: {
        ...form.getHeaders(),
        'X-Requested-With': 'XMLHttpRequest', 'X-Inertia': 'true', 'X-Inertia-Version': '',
        'X-XSRF-TOKEN': decodedXsrf(xsrf), 'Cookie': buildCookieStr(session, xsrf),
        'Origin': BASE_URL, 'Referer': `${BASE_URL}/en/add_advertise`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0, validateStatus: s => s < 500, maxContentLength: 50 * 1024 * 1024,
    });
    step3Res = axiosRes;
  }

  console.log('[Mzad] Step 3 response status:', step3Res.status);
  console.log('[Mzad] Step 3 response data:', JSON.stringify(step3Res.data).substring(0, 1000));

  // Check for errors
  const errors = step3Res.data?.props?.errors;
  if (errors && Object.keys(errors).length > 0) {
    console.error('[Mzad] Validation errors:', JSON.stringify(errors));
    throw new Error('Mzad validation errors: ' + JSON.stringify(errors));
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

  console.log(`[Mzad] ===== Ad posted successfully for unit ${property.Unit}! =====`);
  return {
    success: true,
    unit: property.Unit,
    step1: { status: step1Res.status, data: JSON.stringify(step1Res.data).substring(0, 500) },
    step2: { status: step2Res.status, data: JSON.stringify(step2Res.data).substring(0, 500) },
    step3: { status: step3Res.status, data: JSON.stringify(step3Res.data).substring(0, 1500) },
  };
}

module.exports = { getSession, postAd, closeBrowser };
