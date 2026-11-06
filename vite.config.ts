import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La web se sirve como archivos estáticos; /api va a la función serverless (o a server/dev.ts en local).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  envPrefix: 'NYVO_PUBLIC_',
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } }
});
