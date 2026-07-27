import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a build survives being served from a subpath (GitHub Pages).
  base: './',
  build: {
    target: 'es2022',
    // Low on purpose: a tripwire, not a limit. If this fires, ask why the bundle grew.
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
  },
});
