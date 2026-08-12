import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import "dotenv/config";

const dbPath = process.env.DB_PATH || "./analytics.dev.db";
const sqlite = new Database(dbPath);

export const db = drizzle(sqlite, { schema });
