import { chromium } from '@playwright/test';
const [base = 'http://localhost:5287/src/surgery/dev/index.html', outDir = '../../../../../_internal/shots/surgery', scheme = 'light', width = '1360'] = process.argv.slice(2);
const out = (n) => new URL(`${outDir}/${n}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: +width, height: 1000 }, colorScheme: scheme, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('response', (r) => r.status() >= 400 && logs.push(`[${r.status()}] ${r.url()}`));
await page.goto(base, { waitUntil: 'networkidle' });
const verdict = () => page.textContent('#sg-verdict');
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('.sg-result')?.hasAttribute('data-busy') && !/Checking/.test(document.querySelector('#sg-verdict')?.textContent ?? ''), null, { timeout: 30000 });
};
await settle();
console.log('initial:', await verdict());
await page.waitForTimeout(2500);
const tag = scheme === 'dark' ? '-dark' : width < 700 ? '-mobile' : '';
await page.screenshot({ path: out(`01-blocked${tag}.png`), fullPage: true });

const times = [];
const slider = page.locator('.sg-card[data-open] input[type=range]').first();
if (await slider.count()) {
  await slider.focus();
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    await page.keyboard.press('ArrowRight');
    await settle();
    times.push(Date.now() - t0);
  }
  console.log('keyboard re-solve ms:', times.join(', '), 'verdict:', await verdict());
}
const works = page.locator('.sg-card[data-open] .sg-link', { hasText: 'Works from' }).first();
if (await works.count()) { await works.click(); await settle(); console.log('after threshold:', await verdict()); }
await page.waitForTimeout(1500);
await page.screenshot({ path: out(`02-lever${tag}.png`), fullPage: true });

const sug = page.locator('.sg-suggest button').first();
if (await sug.count()) { await sug.click(); await settle(); console.log('after suggestion:', await verdict()); }
await page.waitForTimeout(800);
const keep = page.getByRole('button', { name: 'Keep as branch' });
if (await keep.isEnabled()) { await keep.click(); console.log('kept A'); }
const budgetCard = page.locator('.sg-card-head', { hasText: 'Total spend' }).first();
if (await budgetCard.count()) {
  await budgetCard.click();
  const own = page.locator('.sg-card[data-open] .sg-lever[data-own] input[type=range]').first();
  if (await own.count()) {
    await own.focus();
    const feasibleTimes = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      await page.keyboard.press('ArrowRight');
      await settle();
      feasibleTimes.push(Date.now() - t0);
    }
    console.log('re-solve ms while possible:', feasibleTimes.join(', '), 'solver:', await page.getAttribute('.sg-result .sg-proof .tag', 'title'));
    console.log('after own budget:', await verdict());
    if (await keep.isEnabled()) { await keep.click(); console.log('kept B'); }
  }
}
await page.waitForTimeout(1500);
await page.screenshot({ path: out(`03-possible${tag}.png`), fullPage: true });
const neg = page.getByRole('button', { name: 'Negotiate', exact: true }).first();
if (await neg.count()) { await neg.click(); console.log('sent:', await page.textContent('#sent')); }
await page.locator('.sg-mv').screenshot({ path: out(`04-branches${tag}.png`) });
console.log(logs.join('\n') || 'no console errors');
await browser.close();
