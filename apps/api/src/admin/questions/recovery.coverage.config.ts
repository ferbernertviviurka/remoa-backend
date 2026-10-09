import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
/** Reuse installed AI provider, no new dependency or live DB. Integration remains explicitly skipped. */
export default defineConfig({root:fileURLToPath(new URL('../../../../../packages/ai',import.meta.url)),test:{include:['../../apps/api/src/admin/questions/recovery{,.integration}.test.ts'],coverage:{enabled:true,allowExternal:true,provider:'v8',include:[fileURLToPath(new URL('./recovery.ts',import.meta.url))],reporter:['text','json-summary','json'],reportsDirectory:'/private/tmp/remoa-f33-recovery-coverage'}}});
