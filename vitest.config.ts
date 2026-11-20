import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['tests/ui/**/*.test.tsx', 'jsdom']],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/client/main.tsx', 'src/shared/types.ts'],
    },
  },
});
