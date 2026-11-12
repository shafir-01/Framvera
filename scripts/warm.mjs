const base = (process.argv[2] ?? process.env.FRAMVERA_URL ?? 'https://framvera.onrender.com').replace(/\/$/, '');
const started = Date.now();
try {
  const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => null);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${base} answered ${res.status} in ${secs}s${body?.ok ? ' (status ok)' : ''}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error(`No answer from ${base}: ${e.message}`);
  process.exit(1);
}
