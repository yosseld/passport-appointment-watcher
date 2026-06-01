// Headless validation of the agency-picker UI: render it, choose Houston, click
// Start, and confirm the selection (agency + auto-filled zip) is read back.
const { chromium } = require('playwright-core');
const { buildConfigHtml, AGENCIES } = require('./watcher.js');

(async () => {
  let browser;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; } catch (_) {}
  }
  if (!browser) { console.error('No Chrome/Edge available'); process.exit(2); }
  const page = await browser.newPage();
  await page.setContent(buildConfigHtml(), { waitUntil: 'domcontentloaded' });

  const idx = AGENCIES.findIndex((a) => a.name === 'Houston');
  await page.selectOption('#agency', String(idx));
  await page.click('#start');
  await page.waitForFunction('window.__picked', { timeout: 10000 });
  const picked = await page.evaluate(() => window.__picked);
  await browser.close();

  console.log('picked:', JSON.stringify(picked));
  const ok = picked && picked.agency === 'Houston' && picked.zip === '77002';
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
