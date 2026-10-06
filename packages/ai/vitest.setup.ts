// G22: tests never reach a real provider. No real key survives, the base URL is a fake host, and every fetch is a mock.
// A fake model makes `aiMode()` live once a test sets OPENROUTER_API_KEY; no retries and high local limits keep tests fast.
delete process.env.OPENROUTER_API_KEY;
delete process.env.MISTRAL_API_KEY;
process.env.AI_BASE_URL = 'http://ai.test/api/v1';
process.env.AI_MODEL = 'test/model';
delete process.env.AI_MODEL_FALLBACKS;
process.env.AI_MAX_RETRIES = '0';
process.env.AI_RPM_LIMIT = '10000';
process.env.AI_RPD_LIMIT = '10000';
process.env.AI_REQUIRE_FREE = '0';
process.env.LOG_LEVEL ??= 'error';
