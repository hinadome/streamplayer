import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward API + proxy requests to the Express backend during dev
      '/api': 'http://localhost:8787',
      '/proxy': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
  },
});
