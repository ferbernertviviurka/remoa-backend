import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/grade.ts', 'src/offline.ts', 'src/extract.ts', 'src/client.ts', 'src/config.ts', 'src/catalog.ts', 'src/challenge-prompts.ts', 'src/challenge-config.ts', 'src/challenge-guards.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
