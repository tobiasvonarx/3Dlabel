import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.LABEL3D_BACKEND_URL || `http://127.0.0.1:${env.PORT || '5003'}`;
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target },
        '/acquire': { target },
        '/acquisition-assets': { target }
      },
      watch: {
        usePolling: true,
        interval: 500,
        ignored: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/data/**', '**/.venv/**']
      }
    }
  };
});
