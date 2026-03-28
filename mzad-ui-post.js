/**
 * mzad-ui-post.js - Post ads using Inertia.js router from Puppeteer browser context
 * This uses the exact same code path as the real Mzad form.
 */

const fs = require('fs');
const path = require('path');
const { buildTitleAr, buildTitleEn, buildDescription } = require('./ad-builders');

const CATEGORY_RESIDENTIAL_RENT = 8494;

/**
 * Post an ad using the Inertia router inside the Puppeteer browser.
 * This replicates the exact form submission that a real user would do.
 */
async function postAdViaInertia(page, property) {
  const log = msg => console.log('[MzadInertia] ' + msg);
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const categoryId = property._overrideCategory || CATEGORY_RESIDENTIAL_RENT;
  log('Posting ad for unit ' + property.Unit + ' category ' + categoryId);

  // Ensure we're on add_advertise
  if (!page.url().includes('/add_advertise')) {
    log('Navigating to add_advertise...');
    await page.goto('https://mzadqatar.com/en/add_advertise', {
      waitUntil: 'networkidle2', timeout: 30000
    });
    if (page.url().includes('/login')) {
      throw new Error('Not logged in');
    }
  }
  await delay(1000);

  // ── STEP 1: Submit category via Inertia router ──
  log('Step 1: Submitting category via Inertia...');
  const step1Result = await page.evaluate(async (catId) => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject('Step 1 timeout'), 15000);
      try {
        const app = document.querySelector('#app').__vue_app__;
        const inertia = app.config.globalProperties.$inertia;

        inertia.post('/en/add_advertise', {
          step: 1,
          step1Data: {
            categoryId: catId,
            lang: 'aren',
            mzadyUserNumber: '',
          },
          step2Data: {},
          step3Data: {},
        }, {
          preserveState: false,
          preserveScroll: false,
          onSuccess: (page) => {
            clearTimeout(timeout);
            const gAAD = page?.props?.getAddAdvertiseData;
            resolve({
              ok: true,
              step: gAAD?.prevData?.step,
              prevDataKeys: gAAD?.prevData ? Object.keys(gAAD.prevData) : [],
              apiDataKeys: gAAD?.apiData ? Object.keys(gAAD.apiData) : [],
              step2Data: gAAD?.prevData?.step2Data || null, groups: gAAD?.apiData?.groups ? gAAD.apiData.groups.map(function(g){return{groupName:g.groupName,products:(g.products||[]).map(function(p){return{productId:p.productId,isAllowToAdd:p.isAllowToAdd}})}}) : null,
            });
          },
          onError: (errors) => {
            clearTimeout(timeout);
            resolve({ ok: false, errors });
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e.message);
      }
    });
  }, categoryId);
  log('Step 1 result: ' + JSON.stringify(step1Result));

  // Extract free productId from groups
  let freeProductId = '';
  if (step1Result.groups) {
    for (const g of step1Result.groups) {
      for (const p of (g.products || [])) {
        if (p.isAllowToAdd) {
          freeProductId = String(p.productId);
          log('Found free productId: ' + freeProductId);
          break;
        }
      }
      if (freeProductId) break;
    }
  }
  if (!freeProductId) log('WARNING: No free productId found');

  if (!step1Result.ok) {
    return { success: false, error: 'Step 1 failed', details: step1Result };
  }
  await delay(1000);

  // ── STEP 2: Submit property details via Inertia router ──
  const rooms = parseInt(property.Bedrooms) || 2;
  const baths = parseInt(property.Bathrooms) || 2;
  const area = parseInt(property.Size_sqm) || 100;

  log('Step 2: Submitting property details via Inertia...');
  const step2Result = await page.evaluate(async (catId, rooms, baths, area) => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject('Step 2 timeout'), 15000);
      try {
        const app = document.querySelector('#app').__vue_app__;
        const inertia = app.config.globalProperties.$inertia;

        inertia.post('/en/add_advertise', {
          step: 2,
          step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
          step2Data: {
            cityId: 3,
            regionId: '38',
            numberOfRooms: rooms,
            location: '',
            categoryAdvertiseTypeId: '3',
            furnishedTypeId: 107,
            properterylevel: 127,
            lands_area: area,
            properteryfinishing: 366,
            properterybathrooms: baths <= 2 ? 112 : 113,
            salesref: '',
            rentaltype: 791,
            subCategoryId: 88,
          },
          step3Data: {},
        }, {
          preserveState: false,
          onSuccess: (page) => {
            clearTimeout(timeout);
            const gAAD = page?.props?.getAddAdvertiseData;
            resolve({
              ok: true,
              step: gAAD?.prevData?.step,
              prevDataKeys: gAAD?.prevData ? Object.keys(gAAD.prevData) : [],
              step2Data: gAAD?.prevData?.step2Data || null,
            });
          },
          onError: (errors) => {
            clearTimeout(timeout);
            resolve({ ok: false, errors });
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e.message);
      }
    });
  }, categoryId, rooms, baths, area);
  log('Step 2 result: ' + JSON.stringify(step2Result));

  if (!step2Result.ok) {
    return { success: false, error: 'Step 2 failed', details: step2Result };
  }
  await delay(1000);

  // ── STEP 3: Submit ad content via Inertia router ──
  const price = parseInt(property.Rent_QAR) || 5000;
  const titleEn = buildTitleEn(property);
  const titleAr = buildTitleAr(property);
  const desc = buildDescription(property);

  // Get placeholder image as base64
  const imgPath = path.join(__dirname, 'ad-placeholder.jpg');
  if (!fs.existsSync(imgPath)) {
    log('Creating placeholder image...');
    const axios = require('axios');
    const res = await axios.get('https://placehold.co/800x600/cccccc/333333?text=Property', {
      responseType: 'arraybuffer'
    });
    fs.writeFileSync(imgPath, Buffer.from(res.data));
  }
  const imgBase64 = fs.readFileSync(imgPath).toString('base64');

  log('Step 3: Submitting ad content via Inertia...');
  const step3Result = await page.evaluate(async (catId, price, tEn, tAr, desc, imgB64, s2Data, fpId) => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // On timeout, check page state
        try {
          const app = document.querySelector('#app').__vue_app__;
          const gAAD = app.config.globalProperties.$page?.props?.getAddAdvertiseData;
          resolve({ ok: false, timeout: true, apiData: gAAD?.apiData });
        } catch(e) {
          reject('Step 3 timeout: ' + e.message);
        }
      }, 20000);

      try {
        const app = document.querySelector('#app').__vue_app__;
        const inertia = app.config.globalProperties.$inertia;

        // Convert base64 to File object
        const byteChars = atob(imgB64);
        const byteArr = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
        const file = new File([byteArr], 'property.jpg', { type: 'image/jpeg' });

        const formData = {
          step: 3,
          step1Data: { categoryId: catId, lang: 'aren', mzadyUserNumber: '' },
          step2Data: s2Data || {},
          step3Data: {
            productPrice: String(price),
            productNameEnglish: tEn,
            productDescriptionEnglish: desc,
            productNameArabic: tAr,
            productDescriptionArabic: desc,
            productNameArEn: '',
            productDescriptionArEn: '',
            autoRenew: false,
            agree_commission: true,
            currencyId: '1',
            isResetImages: false,
            productId: fpId || '',
            images: [
              { id: '0', type: 'image/jpeg', url: '', tempFile: file }
            ],
          },
        };

        inertia.post('/en/add_advertise', formData, {
          forceFormData: true,
          preserveState: false,
          onSuccess: (page) => {
            clearTimeout(timeout);
            const gAAD = page?.props?.getAddAdvertiseData;
            const apiData = gAAD?.apiData;
            resolve({
              ok: !apiData?.didNotSaved,
              step: gAAD?.prevData?.step,
              apiData: apiData ? {
                didNotSaved: apiData.didNotSaved,
                status: apiData.status,
                message: apiData.message || apiData.statusMsg,
                keys: Object.keys(apiData).slice(0, 10),
              } : null,
              url: page?.url,
              component: page?.component,
            });
          },
          onError: (errors) => {
            clearTimeout(timeout);
            resolve({ ok: false, errors });
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e.message);
      }
    });
  }, categoryId, price, titleEn, titleAr, desc, imgBase64,
     step2Result.step2Data || { cityId: 3, regionId: '38', numberOfRooms: rooms,
       categoryAdvertiseTypeId: '3', furnishedTypeId: 107, properterylevel: 127,
       lands_area: area, properteryfinishing: 366, properterybathrooms: 112,
       rentaltype: 791, subCategoryId: 88 });

  log('Step 3 result: ' + JSON.stringify(step3Result));

  return {
    success: step3Result.ok === true,
    unit: property.Unit,
    step1: step1Result,
    step2: step2Result,
    step3: step3Result,
  };
}

module.exports = { postAdViaInertia };
