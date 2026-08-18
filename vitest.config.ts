import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/config/**', 'src/services/**', 'src/integrations/**'],
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
});
