import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { setupFiles: ['../../vitest.test-db.ts'] } });
