// Coverage runs from packages/ai (bundled v8 provider); never fall through to a shared DATABASE_URL.
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL??'';
