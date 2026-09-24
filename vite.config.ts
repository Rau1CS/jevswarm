import { defineConfig, loadEnv } from 'vite';
import { jevProxyPlugin } from './server/jevProxy.ts';

export default defineConfig(({ mode }) => {
  // Load non-VITE_ vars too; they stay on the server and are never exposed to the client.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [jevProxyPlugin({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })],
    server: { port: 5173, open: false },
    build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  };
});
