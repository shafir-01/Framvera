import { defineConfig, mergeConfig, type UserConfigFnObject } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../../../vite.config.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig((env) =>
  mergeConfig((base as UserConfigFnObject)(env), {
    root: here('../../..'),
    server: { port: 5287, strictPort: true },
    preview: { port: 5288, strictPort: true },
    worker: { format: 'es' },
    build: {
      outDir: process.env.SURGERY_OUT ?? here('../../../../../node_modules/.cache/surgery-dist'),
      emptyOutDir: true,
      rollupOptions: { input: here('./index.html') },
    },
  }),
);
