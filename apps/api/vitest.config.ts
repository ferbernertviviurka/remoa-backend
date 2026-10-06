import { defineConfig } from 'vitest/config';

// D-838: the API tests are integration tests against one local Supabase (shared auth rate limits and connections).
// Ten files at once (default = cores - 1) time out under load; three stay green and take ~40 s.
export default defineConfig({ test: { maxWorkers: 3, minWorkers: 1 } });
