import { chromium } from '@playwright/test';
const [url, out, wait = 'body', width = '1360', height = '900', scheme = 'light'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: +width, height: +height }, colorScheme: scheme, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
try { await page.waitForSelector(wait, { timeout: 90000 }); } catch (e) { logs.push('[wait-timeout] ' + wait); }
await page.waitForTimeout(600);
if (out && out !== '-') await page.screenshot({ path: out, fullPage: true });
console.log((await page.textContent('body'))?.slice(0, 1500));
console.log(logs.join('\n'));
await browser.close();
