import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 45173, strictPort: true },
  // Load VITE_* from the monorepo-root .env. Vite's envDir defaults to the app
  // dir; Turbo runs vite with cwd apps/dashboard, so without this the root .env
  // is invisible. Only VITE_-prefixed keys are exposed to the client.
  envDir: '../../',
});
