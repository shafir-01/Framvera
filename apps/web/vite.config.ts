import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.FRAMVERA_API_PROXY ?? 'http://localhost:8790';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === 'fixture' ? { 'import.meta.env.VITE_FIXTURE': JSON.stringify('1') } : {},
  server: {
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1600 },
}));
