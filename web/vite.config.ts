import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/live': { target: 'ws://127.0.0.1:4317', ws: true },
      '/api': 'http://127.0.0.1:4317',
      '/images': 'http://127.0.0.1:4317',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
