// Unit tests do not touch the database, but module imports (drizzle/pg)
// require DATABASE_URL to exist at load time.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
}
