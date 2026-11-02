import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { validateDevelopmentApiUrl, validateProductionApiUrl } from './build/apiUrl.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command, mode, isPreview }) => {
  // Same resolution Vite itself uses for import.meta.env: shell variables first, then the
  // .env files for this mode. Throwing here aborts before Vite writes or empties dist/.
  const apiUrl = loadEnv(mode, appDir, 'VITE_').VITE_API_BASE_URL;
  if (command === 'build') {
    // Every build, whatever its --mode: a custom mode name must not weaken this check.
    validateProductionApiUrl(apiUrl);
  } else if (!isPreview) {
    validateDevelopmentApiUrl(apiUrl);
  }

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 3000, strictPort: true },
    preview: { port: 3000, strictPort: true },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
          },
        },
      },
    },
  };
});
