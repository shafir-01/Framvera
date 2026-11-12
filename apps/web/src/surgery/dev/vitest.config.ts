import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/web/src/surgery/dev/**/*.test.ts'], testTimeout: 120000 } });
