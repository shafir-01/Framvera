import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.env.SCHEDULE_DEV ?? 'http://127.0.0.1:5199/src/schedule/dev/index.html';
const out = '_internal/shots/schedule';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const jobs = [
  ['agreed-light', 'plan', 'light', 1280, 900],
  ['agreed-dark', 'plan', 'dark', 1280, 900],
  ['withdrawn-light', 'disrupted', 'light', 1280, 900],
  ['recovered-light', 'recovered', 'light', 1280, 900],
  ['recovered-dark', 'recovered', 'dark', 1280, 900],
  ['agreed-mobile', 'plan', 'light', 390, 900],
  ['recovered-mobile-dark', 'recovered', 'dark', 390, 900],
];
for (const [name, s, theme, w, h] of jobs) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(`${base}?s=${s}&theme=${theme}&adjust=1`);
  await page.waitForSelector('.fv-sched svg');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
