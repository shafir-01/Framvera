const arg = process.argv[2] ?? process.env.FRAMVERA_URL;
if (!arg) {
  console.error('Usage: node scripts/check-live.mjs <url>');
  process.exit(2);
}
const base = arg.replace(/\/$/, '');
const results = [];
const check = async (name, fn) => {
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, e.message]);
  }
};
const get = (url) => fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });

let html = '';
await check('page loads', async () => {
  const r = await get(`${base}/`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  html = await r.text();
  if (!/<div id="root"/.test(html)) throw new Error('no app root in HTML');
  return `HTTP ${r.status}`;
});

await check('build hash', async () => {
  const m = html.match(/(?:src|href)="([^"]*\/assets\/index-([A-Za-z0-9_-]+)\.js)"/);
  if (!m) throw new Error('no hashed entry script in HTML');
  const url = new URL(m[1], `${base}/`).href;
  const r = await get(url);
  if (!r.ok) throw new Error(`entry script HTTP ${r.status}`);
  return `index-${m[2]}.js served`;
});

await check('api status', async () => {
  const r = await get(`${base}/api/status`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error('ok flag false');
  const s = j.services ?? {};
  return `paypal ${s.paypalConfigured ? 'configured' : 'not configured'}, ai ${s.aiConfigured ? 'configured' : 'not configured'}, durable ledger ${s.durableLedger ? 'yes' : 'no'}`;
});

for (const [name, ok, note] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${note}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
