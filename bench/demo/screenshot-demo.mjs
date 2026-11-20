#!/usr/bin/env node
// Captures the M4 demo UI screenshots with headless Chrome (puppeteer-core + system Chrome).
//
//   MONITORING_URL=http://127.0.0.1:4610 DEMO_EMAIL=demo@acme.test DEMO_PASSWORD=... \
//     DASHBOARD_ID=... MONITOR_ID=1 OUT_DIR=bench/evidence/demo node bench/demo/screenshot-demo.mjs
//
// Writes one PNG per page plus an org-switcher-open shot, and prints SHOTS_DONE.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:4610';
const EMAIL = process.env.DEMO_EMAIL || 'demo@acme.test';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo-pass-12345';
const DASH = process.env.DASHBOARD_ID;
const MON = process.env.MONITOR_ID || '1';
const OUT = process.env.OUT_DIR || 'bench/evidence/demo';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// login through the real form
await page.goto(DC + '/', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
await page.type('[data-testid="login-email"]', EMAIL);
await page.type('[data-testid="login-password"]', PASSWORD);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {}),
  page.keyboard.press('Enter'),
]);
await sleep(2500);
if (await page.$('[data-testid="login-email"]')) throw new Error('login did not complete');

const shots = [
  ['apm-services', '/apm/services'],
  ['logs', '/logs'],
  ['dashboard', `/dashboard/${DASH}`],
  ['monitors', '/monitors/manage'],
  ['monitor-firing', `/monitors/${MON}`],
];
for (const [name, path] of shots) {
  await page.goto(DC + path, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(3000); // charts/tables finish rendering after data arrives
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot ${name}`);
}

// organization settings: the Usage & Limits tab (not the default API Keys tab)
await page.goto(DC + '/organization-settings', { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);
for (const el of await page.$$('a, button, li, div')) {
  if ((await el.evaluate((n) => n.textContent?.trim())) === 'Usage & Limits') { await el.click(); break; }
}
await sleep(2500);
await page.screenshot({ path: `${OUT}/org-settings-usage.png` });
console.log('shot org-settings-usage');

// org switcher open
await page.goto(DC + '/apm/services', { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);
const switcher = await page.$('[data-testid="org-switcher"]');
if (!switcher) throw new Error('org switcher not found');
await switcher.click();
await sleep(1200);
await page.screenshot({ path: `${OUT}/org-switcher-open.png` });
console.log('shot org-switcher-open');

await browser.close();
console.log('SHOTS_DONE');
