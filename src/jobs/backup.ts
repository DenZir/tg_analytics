import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../db/index.js";

const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
const RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT) || 14;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldBackups() {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("analytics-") && f.endsWith(".db"))
      .sort();
    const excess = files.length - RETENTION_COUNT;
    for (let i = 0; i < excess; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
      console.log(`[backup] Pruned old backup ${files[i]}`);
    }
  } catch (error) {
    console.error("[backup] Failed to prune old backups:", error);
  }
}

let backupInProgress = false;

export async function backupDatabase() {
  // Two overlapping backup.transfer() calls would both stream into the same
  // destination file (today's date) and race each other, corrupting it —
  // guard against that if the cron tick fires while the on-start backup (or
  // a previous slow run) is still in flight.
  if (backupInProgress) {
    console.log("[backup] Skipped: a backup is already in progress.");
    return;
  }
  backupInProgress = true;
  console.log("[backup] Starting sqlite backup...");
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const destination = path.join(BACKUP_DIR, `analytics-${todayKey()}.db`);
    // better-sqlite3's online backup API: safe to run against the live
    // connection while it's concurrently read from/written to elsewhere in
    // the process, since it steps through the copy incrementally rather than
    // locking the whole database for the duration.
    await sqlite.backup(destination);
    console.log(`[backup] Backup written to ${destination}`);
    pruneOldBackups();
  } catch (error) {
    console.error("[backup] Backup failed:", error);
  } finally {
    backupInProgress = false;
  }
}

// On-demand full export for the "Скачать полный бэкап" dashboard button
// (GET /api/export/full in server.ts) — a separate function from
// backupDatabase() above because it writes to its own one-off filename
// (prefixed "export-", never touched by pruneOldBackups' "analytics-*"
// filter) and doesn't share its concurrency guard: this is a point-in-time
// snapshot for a human to download right now, not the nightly rotation, so
// it should never be silently skipped just because a scheduled backup
// happens to be running at the same moment. Running two sqlite.backup()
// calls at once is safe as long as they target different destination files.
export async function createFullExport(): Promise<string> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const destination = path.join(BACKUP_DIR, `export-${Date.now()}.db`);
  await sqlite.backup(destination);
  return destination;
}

// Daily at 03:15 — 15 minutes after the existing daily stats aggregation job
// (src/jobs/dailyAggregate.ts runs at 03:00), so the backup captures that
// day's freshly-aggregated stats too.
cron.schedule("15 3 * * *", () => {
  backupDatabase();
});

// Also back up once immediately on process start, mirroring the existing
// dailyAggregate.ts convention — so a short-lived or frequently-restarted
// process still gets a fresh backup instead of relying solely on the cron
// firing at 03:15.
backupDatabase();
