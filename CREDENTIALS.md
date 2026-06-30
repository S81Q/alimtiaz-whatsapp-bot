# Credentials & Secrets Inventory — Al-Imtiaz WhatsApp Bot

All secrets live in **Railway environment variables** (some config may also come from
the Google Config sheet via `getConfig`). **No secret values appear in this file or
anywhere in the repo.** A monthly cron (`0 8 1 * *` UTC) emails sultanaliqatar81@gmail.com
to review this list and rotate anything near expiry.

| Secret | Type | Store | Expiry / rotation | Notes |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | API key | Railway env | No fixed expiry; rotate on exposure | Prime suspect for Fault 2 — verify key + credit |
| `META_ACCESS_TOKEN` | OAuth token | Railway env | System-user token = permanent; user token ~60 days | Use a permanent System User token |
| `META_VERIFY_TOKEN` | Shared secret | Railway env | No expiry; rotate on exposure | Must match Meta webhook config |
| `META_PHONE_NUMBER_ID` | Identifier (not secret) | Railway env | n/a | For +974 7029 7066 sender |
| `TWILIO_ACCOUNT_SID` | Identifier (not secret) | Railway env | n/a | Sandbox/account |
| `TWILIO_AUTH_TOKEN` | API secret | Railway env | No expiry; rotate on exposure | Twilio path / status callbacks |
| `MZAD_SESSION` | Session cookie | Railway env | Short-lived; refresh when poster fails | Ad-poster |
| `MZAD_XSRF_TOKEN` | CSRF token | Railway env | Pairs with MZAD_SESSION | Refresh together |
| Google service account | JSON key file | Railway env / `service-account.json` (gitignored) | No expiry; rotate on exposure | Sheets API |
| Gmail OAuth refresh token | OAuth token | Railway env / `token.json` (gitignored) | Long-lived; revoke-able | Alert/report emails |
| `SELFTEST_SECRET` | Shared secret | Railway env | Rotate on exposure | Guards POST /selftest |

### Additional secret env vars referenced in code (grep `process.env`)
| Secret | Type | Store | Expiry / rotation | Notes |
|---|---|---|---|---|
| `GMAIL_OAUTH_CLIENT_ID` | OAuth client id | Railway env | Rotate with the OAuth client | Pairs with secret + refresh token below |
| `GMAIL_OAUTH_CLIENT_SECRET` | OAuth client secret | Railway env | Rotate on exposure | Google Cloud OAuth client |
| `GMAIL_OAUTH_REFRESH_TOKEN` | OAuth refresh token | Railway env | Long-lived; revoke-able | Gmail read (vacancy PDF) + alert emails |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key (JSON) | Railway env | No expiry; rotate on exposure | Inline form of `service-account.json` |
| `MZAD_CF_COOKIES` | Cloudflare clearance cookies | Railway env | Short-lived; refresh with MZAD session | Ad-poster anti-bot bypass |
| `QS_USERNAME` | Login id (not secret) | Railway env | n/a | QatarSale poster account |
| `QS_PASSWORD` | Account password | Railway env | Rotate on exposure | QatarSale poster |
| `QS_JWT_TOKEN` | Session JWT | Railway env | Short-lived | QatarSale API |
| `QS_REFRESH_TOKEN` | Refresh token | Railway env | Long-lived; revoke-able | QatarSale API |
| `CAPSOLVER_API_KEY` | API key | Railway env | Rotate on exposure | CAPTCHA-solving service |
| `TWOCAPTCHA_API_KEY` | API key | Railway env | Rotate on exposure | CAPTCHA-solving service |

## Rotation log
| Date | Secret | Action | By |
|---|---|---|---|
| (fill on each rotation) | | | |
