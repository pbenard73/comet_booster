import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'client',
  resolve: {
    alias: {
      // import from '@shared/...' resolves to shared/ at project root
      '@shared': path.join(root, 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target:       'ws://localhost:4000',
        ws:           true,
        changeOrigin: true,
      },
      // Team search runs over HTTP (the menu has no WebSocket) → proxy to uWS.
      '/api': {
        target:       'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir:     '../dist/client',
    emptyOutDir: true,
  },
});
