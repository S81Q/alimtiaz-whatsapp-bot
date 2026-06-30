# Credentials & Secrets Inventory — Al-Imtiaz WhatsApp Bot

All secrets live in **Railway environment variables** (or the Google Config sheet via `getConfig`). Nothing secret is committed. `.gitignore` covers `.env`, `.env.railway`, `service-account.json`, `*.log`.

A monthly cron (`0 8 1 * *` UTC) emails `sultanaliqatar81@gmail.com` a reminder to review this list. The daily heartbeat (`0 6 * * *` UTC) self-tests both reply paths and emails on failure (which is how an expired/rotated key surfaces fast).

| Secret | Type | Store | Expiry / rotation | Notes |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | API key | Railway env | No fixed expiry; rotate on suspected exposure | Used by `new Anthropic()`. **This is what powers the Claude path.** A revoked key → 401 `auth`; exhausted credit → 429/402 `quota`. (Note: the Config sheet also has `CLAUDE_API_KEY`, but the SDK reads `ANTHROPIC_API_KEY` from env — keep that one set.) |
| `META_ACCESS_TOKEN` | Graph API token | Railway env | **Temporary tokens expire in ~24h; "System User" tokens can be 60-day or permanent** | For production, generate a **permanent System User token** (see deploy notes). A 24h/60d token is the #1 silent outage cause on Meta. |
| `META_PHONE_NUMBER_ID` | ID (not secret) | Railway env | n/a | `1105443759309335` currently. |
| `META_WABA_ID` | ID | Railway env | n/a | WhatsApp Business Account ID. |
| `META_VERIFY_TOKEN` | Shared string | Railway env | Set once; rotate at will | Used for GET `/webhook` verification. If unset, code defaults to `alimtiaz_verify_2026`. Must match the value pasted in the Meta console. |
| `TWILIO_AUTH_TOKEN` | API secret | Railway env / Config sheet | Rotate on exposure | Sandbox fallback provider. |
| `TWILIO_ACCOUNT_SID` | ID | Railway env / Config sheet | n/a | |
| `MZAD_SESSION` | Session cookie | Railway env | Expires when Mzad session ends (days–weeks) | Ad-poster only; not on the WhatsApp path. |
| `MZAD_XSRF_TOKEN` | CSRF token | Railway env | Same lifetime as `MZAD_SESSION` | Ad-poster only. |
| `GMAIL_OAUTH_REFRESH_TOKEN` | OAuth refresh token | Railway env | Long-lived; revoked if password changes or app access removed | Used for vacancy-PDF Gmail read **and** alert emails. Needs `GMAIL_OAUTH_CLIENT_ID` + `GMAIL_OAUTH_CLIENT_SECRET`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key | Railway env | Rotate per org policy | Google Sheets read/write (vacancy + leads). |
| `SELFTEST_SECRET` | Shared secret | Railway env | Set once | Guards POST `/selftest`. **Must be set or `/selftest` returns 503.** |
| `CLAUDE_MODEL` | config (not secret) | Railway env (optional) | n/a | Overrides default `claude-sonnet-4-6`. |
| `PUBLIC_URL` | config (not secret) | Railway env (optional) | n/a | Base URL for Twilio `statusCallback`; falls back to request host. |

## Rotate now (assume exposed at some point)
- `ANTHROPIC_API_KEY` — the prior key was flagged "ROTATED"; confirm the **current** Railway value is the live one (the live server authenticated fine during diagnosis, so it is valid — but rotate if the old flagged key is still in use anywhere).
- `TWILIO_AUTH_TOKEN`
- `GMAIL_OAUTH_*` (client secret + refresh token)
- `SELFTEST_SECRET` — set a fresh strong value.
- `META_ACCESS_TOKEN` — replace any temporary token with a permanent System User token.
