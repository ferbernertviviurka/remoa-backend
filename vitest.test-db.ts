// P-481 (G21): integration tests only touch a database you name explicitly. Test files call `config({ path: '../../.env' })`, which would
// load DATABASE_URL (the shared dev Supabase). dotenv never overrides a variable that is already set, so pinning it here wins:
// TEST_DATABASE_URL -> DATABASE_URL; without it DATABASE_URL is empty and every `describe.skipIf(!process.env.DATABASE_URL)` skips.
// CI sets TEST_DATABASE_URL (its own Supabase per job). Locally: `TEST_DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) pnpm test`
// on a database nobody else is using, or a private Postgres.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

const fromFile: Record<string, string> = {};
config({ path: fileURLToPath(new URL('.env', import.meta.url)), processEnv: fromFile, quiet: true }); // TEST_DATABASE_URL may live in .env; nothing else is read here
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? fromFile.TEST_DATABASE_URL ?? '';
