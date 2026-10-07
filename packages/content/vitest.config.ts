import { defineConfig } from 'vitest/config';

// build.test.ts needs TEST_DATABASE_URL (vitest.test-db.ts maps it to DATABASE_URL; without it those tests skip).
export default defineConfig({
  test: {
    setupFiles: ['../../vitest.test-db.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lint.ts', 'src/graph.ts', 'src/load.ts', 'src/images.ts', 'src/targets.ts', 'src/verify.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
