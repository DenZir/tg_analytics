/**
 * Applies pending migrations — what the container runs before the app starts.
 *
 * drizzle-kit migrate does the same job, but when a migration fails it exits
 * with code 1 and says nothing about why: in a container that is a restart loop
 * with an empty log. This uses drizzle's own migrator instead. It records
 * applied migrations in the same __drizzle_migrations table, so the two are
 * interchangeable on an existing database — and it prints the database error.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Same default as db/index.ts and drizzle.config.ts.
const dbPath = process.env.DB_PATH || "./analytics.dev.db";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const sqlite = new Database(dbPath);

/** Rows in drizzle's own journal — the same table drizzle-kit writes. */
function appliedCount(): number {
  const journal = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!journal) return 0;
  return (sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
}

try {
  const before = appliedCount();
  migrate(drizzle(sqlite), { migrationsFolder: "./src/db/migrations" });
  const applied = appliedCount() - before;
  console.log(
    applied > 0
      ? `[migrate] Applied ${applied} migration(s) to ${dbPath}`
      : `[migrate] No pending migrations (${dbPath})`
  );
} catch (err) {
  const e = err as Error & { cause?: unknown };
  console.error(`[migrate] Migration failed: ${e.message}`);
  if (e.cause) {
    console.error("[migrate] Cause:", e.cause instanceof Error ? e.cause.message : e.cause);
  }
  process.exitCode = 1;
} finally {
  sqlite.close();
}
