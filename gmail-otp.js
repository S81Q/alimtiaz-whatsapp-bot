/**
 * gmail-otp.js – Gmail OTP reader for QatarSale and Mzad login
 *
 * Supports two auth modes:
 *   1. Service account with domain-wide delegation (Google Workspace)
 *      → Set GOOGLE_SERVICE_ACCOUNT_JSON
 *   2. OAuth2 with stored refresh token (personal Gmail)
 *      → Set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN
 *
 * Gmail must be set up at: https://console.cloud.google.com → Enable Gmail API
 * For delegation: Admin Console → Security → API Controls → Domain-wide delegation
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const GMAIL_USER = process.env.GMAIL_OTP_USER || 'sultanaliqatar81@gmail.com';

async function getGmailClient() {
  // Mode 1: OAuth2 with refresh token (works for personal Gmail)
  if (process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_OAUTH_CLIENT_ID,
      process.env.GMAIL_OAUTH_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  // Mode 2: Service account with domain-wide delegation (Google Workspace)
  let credentials;
  const saPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)) {
    credentials = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    throw new Error('No Gmail credentials. Set GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_REFRESH_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: GMAIL_USER, // Domain-wide delegation – requires Workspace admin setup
  });

  return google.gmail({ version: 'v1', auth });
}

/**
 * Read OTP from Gmail for a given platform.
 * @param {string} platform - 'qatarsale' | 'mzad'
 * @param {number} maxRetries - number of retries (default 3)
 * @param {number} retryDelay - ms between retries (default 10000)
 * @returns {string|null} OTP code or null
 */
async function readOtpFromGmail(platform, maxRetries = 3, retryDelay = 10000, minTimestamp = 0) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // SMS arrives via "SMS Forwarder" app → email from no-reply@sms-forwarder.co to sultanaliqatar81@gmail.com
  // Body format: "Incoming - Mzad Qatar ... Your MzadQatar code is: 123456"
  // Body format: "Incoming - QatarSale ... Confirmation code is : 123456"
  const queryMap = {
    qatarsale: `from:sms-forwarder QatarSale newer_than:5m`,
    mzad: `(from:sms-forwarder OR from:mzadqatar OR from:noreply OR subject:code OR subject:OTP OR subject:verification) (MzadQatar OR mzad OR code) newer_than:10m`,
  };
  const query = queryMap[platform.toLowerCase()] || `from:sms-forwarder newer_than:5m`;

  console.log(`[Gmail OTP] Searching for ${platform} OTP in ${GMAIL_USER}...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const gmail = await getGmailClient();

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = listRes.data.messages || [];
      console.log(`[Gmail OTP] Attempt ${attempt}/${maxRetries}: Found ${messages.length} matching messages`);

      for (const msg of messages) {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        // Skip messages older than minTimestamp (to avoid stale OTPs)
        if (minTimestamp > 0 && msgRes.data.internalDate) {
          const msgTime = parseInt(msgRes.data.internalDate, 10);
          if (msgTime < minTimestamp) {
            console.log('[Gmail OTP] Skipping old message (time: ' + new Date(msgTime).toISOString() + ')');
            continue;
          }
        }
        const body = extractEmailBody(msgRes.data);
        // Look for 4-6 digit OTP code
        const otpMatch = body.match(/\b(\d{4,6})\b/);
        if (otpMatch) {
          console.log(`[Gmail OTP] Found OTP for ${platform}: ${otpMatch[1]}`);
          return otpMatch[1];
        }
      }

      if (attempt < maxRetries) {
        console.log(`[Gmail OTP] No OTP found yet, waiting ${retryDelay / 1000}s...`);
        await delay(retryDelay);
      }
    } catch (e) {
      console.error(`[Gmail OTP] Error on attempt ${attempt}:`, e.message);
      if (e.message.includes('PERMISSION_DENIED') || e.message.includes('domain-wide')) {
        console.error('[Gmail OTP] Domain-wide delegation not configured. Set up Gmail OAuth2 instead:');
        console.error('  1. Create OAuth2 credentials at console.cloud.google.com');
        console.error('  2. Set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET');
        console.error('  3. Run one-time auth to get refresh token, set GMAIL_OAUTH_REFRESH_TOKEN');
        break; // Don't retry permission errors
      }
      if (attempt < maxRetries) await delay(retryDelay);
    }
  }

  console.warn(`[Gmail OTP] Could not find ${platform} OTP after ${maxRetries} attempts`);
  return null;
}

function extractEmailBody(message) {
  let text = '';

  function extractParts(parts) {
    for (const part of parts || []) {
      if (part.body?.data) {
        text += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        extractParts(part.parts);
      }
    }
  }

  if (message.payload?.body?.data) {
    text += Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
  }
  extractParts(message.payload?.parts);

  return text;
}

module.exports = { readOtpFromGmail };
