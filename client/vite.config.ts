import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (normalizedId.includes('vite/preload-helper')) {
            return 'vite-runtime';
          }
          if (normalizedId.includes('node_modules')) {
            if (normalizedId.includes('/react/') || normalizedId.includes('/react-dom/') || normalizedId.includes('/react-router-dom/')) {
              return 'vendor-react';
            }
            if (
              normalizedId.includes('/@imgly/background-removal/') ||
              normalizedId.includes('/onnxruntime-web/')
            ) {
              return 'vendor-ai';
            }
            if (
              normalizedId.includes('/fabric/') ||
              normalizedId.includes('/opentype.js/')
            ) {
              return 'vendor-editor';
            }
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 3089,
    host: '127.0.0.1',
    strictPort: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3088',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3088',
        changeOrigin: true,
      },
    },
  },
});
