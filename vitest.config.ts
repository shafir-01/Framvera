import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'], testTimeout: 120000, fileParallelism: !process.env.CI } });
