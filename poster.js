/**
 * poster.js – Main ad posting orchestration
 *
 * Usage:
 *   const { runPosting } = require('./poster');
 *   await runPosting();                             // Post all vacant units
 *   await runPosting({ testOnly: true });           // Post only first vacant unit
 *   await runPosting({ limitToUnit: 'A-101' });     // Post one specific unit
 *   await runPosting({ platforms: ['QatarSale'] }); // Only one platform
 */

const { getVacantUnits, logAdResult } = require('./sheets-poster');
const { login: qsLogin, postAd: qsPostAd } = require('./qatarsale');
const { getSession: mzadGetSession, postAd: mzadPostAd } = require('./mzad');
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

/**
 * Run the full ad posting flow.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.testOnly=false]     – Only post the first vacant unit
 * @param {string}  [opts.limitToUnit]        – Only post this specific unit
 * @param {string[]}[opts.platforms]          – Subset of ['QatarSale', 'Mzad'] (default: both)
 * @returns {Object} Summary: { qatarsalePosted, mzadPosted, failed, units }
 */
async function runPosting(opts = {}) {
  const {
    testOnly = false,
    limitToUnit = null,
    platforms = ['QatarSale', 'Mzad'],
  } = opts;

  const summary = {
    timestamp: new Date().toISOString(),
    qatarsalePosted: 0,
    mzadPosted: 0,
    failed: 0,
    units: [],
    errors: [],
  };

  console.log('\n═══════════════════════════════════════');
  console.log('[Poster] Starting ad posting run:', summary.timestamp);
  console.log('[Poster] Options:', JSON.stringify(opts));
  console.log('═══════════════════════════════════════\n');

  // ── 1. Load vacant properties ──────────────────────
  let properties = await getVacantUnits();
  console.log(`[Poster] Found ${properties.length} vacant properties`);

  if (limitToUnit) {
    properties = properties.filter(p => p.Unit === limitToUnit);
    console.log(`[Poster] Filtered to unit "${limitToUnit}": ${properties.length} found`);
  }

  if (testOnly) {
    properties = properties.slice(0, 1);
    console.log('[Poster] TEST MODE: posting only the first property');
  }

  if (properties.length === 0) {
    console.log('[Poster] Nothing to post.');
    return summary;
  }

  // ── 2. Login to platforms ──────────────────────────
  let qsToken = null;
  let mzadSession = null;

  if (platforms.includes('QatarSale')) {
    try {
      qsToken = await qsLogin();
      console.log('[Poster] QatarSale: authenticated ✓');
    } catch (e) {
      console.error('[Poster] QatarSale login failed:', e.message);
      summary.errors.push({ platform: 'QatarSale', stage: 'login', error: e.message });
    }
  }

  if (platforms.includes('Mzad')) {
    try {
      mzadSession = await mzadGetSession();
      console.log('[Poster] Mzad: session ready ✓');
    } catch (e) {
      console.error('[Poster] Mzad login failed:', e.message);
      summary.errors.push({ platform: 'Mzad', stage: 'login', error: e.message });
    }
  }

  // ── 3. Post each property ──────────────────────────
  for (const property of properties) {
    const unit = property.Unit;
    console.log(`\n[Poster] ── Processing unit: ${unit} ──`);
    summary.units.push(unit);

    // Post to QatarSale
    if (qsToken) {
      try {
        const result = await qsPostAd(property, qsToken);
        const adId = result?.id || result?.auctionId || result?.data?.id;
        const adUrl = adId ? `https://qatarsale.com/en/product/${adId}` : '';
        await logAdResult({ unit, platform: 'QatarSale', status: 'Success', adUrl });
        summary.qatarsalePosted++;
        console.log(`[Poster] QatarSale ✓ unit=${unit}`, adUrl || '(no URL in response)');
      } catch (e) {
        console.error(`[Poster] QatarSale ✗ unit=${unit}:`, e.message);
        await logAdResult({ unit, platform: 'QatarSale', status: 'Failed', error: e.message });
        summary.failed++;
        summary.errors.push({ platform: 'QatarSale', unit, error: e.message });
      }
    }

    // Post to Mzad
    if (mzadSession) {
      try {
        const result = await mzadPostAd(property, mzadSession);
        // Try to extract ad URL from Inertia response
        const adId = result?.props?.ad?.id
          || result?.props?.classified?.id
          || result?.props?.model?.id;
        const adUrl = adId ? `https://mzadqatar.com/en/ad/${adId}` : '';
        await logAdResult({ unit, platform: 'Mzad', status: 'Success', adUrl });
        summary.mzadPosted++;
        summary.mzadDebug = result;
        console.log(`[Poster] Mzad ✓ unit=${unit}`, adUrl || '(no URL in response)');
      } catch (e) {
        console.error(`[Poster] Mzad ✗ unit=${unit}:`, e.message);
        await logAdResult({ unit, platform: 'Mzad', status: 'Failed', error: e.message });
        summary.failed++;
        summary.errors.push({ platform: 'Mzad', unit, error: e.message });
      }
    }

    // Throttle between properties to avoid rate limits
    if (properties.indexOf(property) < properties.length - 1) {
      console.log('[Poster] Waiting 3s before next property...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ── 4. Summary ─────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log('[Poster] Run complete!');
  console.log(`  Units processed:     ${summary.units.length}`);
  console.log(`  QatarSale posted:    ${summary.qatarsalePosted}`);
  console.log(`  Mzad posted:         ${summary.mzadPosted}`);
  console.log(`  Failures:            ${summary.failed}`);
  if (summary.errors.length > 0) {
    console.log('  Errors:');
    summary.errors.forEach(e => console.log(`    [${e.platform}] ${e.unit || e.stage}: ${e.error}`));
  }
  console.log('═══════════════════════════════════════\n');

  return summary;
}

module.exports = { runPosting };
