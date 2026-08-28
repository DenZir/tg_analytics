import cron from "node-cron";
import { and, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { purgeCampaignCascade } from "../services/campaigns.js";

const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS) || 30;

export async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const expired = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(isNotNull(campaigns.deletedAt), lt(campaigns.deletedAt, cutoff)));

    for (const c of expired) {
      await purgeCampaignCascade(c.id, "system");
      console.log(`[trash] Auto-purged campaign ${c.id} after ${TRASH_RETENTION_DAYS} days in trash`);
    }
  } catch (error) {
    console.error("[trash] Failed to purge expired trash:", error);
  }
}

// Daily at 03:00, alongside the existing dailyAggregate.ts job (both fire on
// the same cron tick; node-cron runs each schedule independently so this
// doesn't block or depend on that job).
cron.schedule("0 3 * * *", () => {
  purgeExpiredTrash();
});
