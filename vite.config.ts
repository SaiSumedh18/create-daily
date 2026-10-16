import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /create-daily/.
export default defineConfig({
  base: './',
  // three.js alone is ~500 kB minified; it ships as one chunk on purpose
  build: { chunkSizeWarningLimit: 700 },
});
