// One-off generator for test/full-modern.apkg (committed so Node 20 CI covers the modern format).
// Needs Node >= 24: node --experimental-strip-types packages/anki/test/make-modern-fixture.mjs
import { writeFileSync } from 'node:fs';
import { fullPackage } from './fixtures.ts';

writeFileSync(new URL('./full-modern.apkg', import.meta.url), await fullPackage(true));
