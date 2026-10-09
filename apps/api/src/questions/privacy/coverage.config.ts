import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 root:fileURLToPath(new URL('../../../../../packages/ai',import.meta.url)),
 test:{include:['../../apps/api/src/questions/privacy/{export,integration}.test.ts'],setupFiles:[fileURLToPath(new URL('./test-db.ts',import.meta.url))],coverage:{enabled:true,allowExternal:true,provider:'v8',include:[fileURLToPath(new URL('./export.ts',import.meta.url))],reporter:['text','json-summary'],reportsDirectory:fileURLToPath(new URL('./coverage',import.meta.url))}},
});
