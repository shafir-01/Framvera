import { parentPort } from 'node:worker_threads';
import loadHighs from 'highs';

let highs = await loadHighs();

parentPort.on('message', ({ id, lp, options }) => {
  const t0 = performance.now();
  let res;
  try {
    res = highs.solve(lp, options);
  } catch (e) {
    loadHighs().then((h) => (highs = h));
    parentPort.postMessage({ id, error: String(e), ms: performance.now() - t0 });
    return;
  }
  const values = {};
  for (const [k, c] of Object.entries(res.Columns ?? {})) if (typeof c.Primal === 'number') values[k] = c.Primal;
  parentPort.postMessage({ id, raw: res.Status, objective: res.ObjectiveValue, values, ms: performance.now() - t0 });
});
