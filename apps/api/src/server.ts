import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { loadEngine } from './engine.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = process.env.FRAMVERA_WEB_DIST || resolve(here, '../../web/dist');
const config = loadConfig(process.env, { webDist: existsSync(resolve(dist, 'index.html')) ? dist : '' });
const app = createApp({ engine: await loadEngine(), config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`framvera api listening on :${info.port}`);
});
