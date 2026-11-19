import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  server: {
    proxy: {
      '^/api/local-model$': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: () => '/api/chat',
        timeout: 90_000,
        proxyTimeout: 90_000,
      },
    },
  },
});
