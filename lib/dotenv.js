// Side-effect module: load ./.env into process.env (existing variables win),
// exactly as lib/config.js does for the server. Import it *first* in a CLI
// entry point (db/seed.js) so DATABASE_URL / DB_PATH from .env are in place
// before db/dialect.js decides which engine to use. No-op under tests.
if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile?.();
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Warning loading .env file:', err.message);
  }
}
