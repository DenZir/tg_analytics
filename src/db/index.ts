import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import "dotenv/config";

const dbPath = process.env.DB_PATH || "./analytics.dev.db";
export const sqlite = new Database(dbPath);

// SQLite's built-in LOWER()/LIKE only case-fold ASCII, so a search for
// "реклама" would miss "Реклама" — register a JS-backed LOWER so
// case-insensitive search works for Cyrillic (and any other) text too.
sqlite.function("lower_unicode", (value: unknown) =>
  value === null ? null : String(value).toLowerCase()
);

export const db = drizzle(sqlite, { schema });
