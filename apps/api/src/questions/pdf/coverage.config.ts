import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
// Reuse the installed coverage provider in packages/ai; no duplicate dependency/install.
export default defineConfig({
  root:fileURLToPath(new URL('../../../../../packages/ai',import.meta.url)),
  test:{include:['../../apps/api/src/questions/pdf/*.test.ts'],coverage:{enabled:true,allowExternal:true,provider:'v8',include:[fileURLToPath(new URL('./{parser,layout,read,ocr,shared-context}.ts',import.meta.url))],reporter:['text','json-summary'],reportsDirectory:fileURLToPath(new URL('./coverage',import.meta.url))}},
});
