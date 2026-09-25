/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base + hash routing lets the build work from any GitHub Pages path (/<repo>/).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
