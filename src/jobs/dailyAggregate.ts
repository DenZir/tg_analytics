import cron from "node-cron";
import { db } from "../db/index.js";
import { events, links, campaigns, dailyStats } from "../db/schema.js";
import { FUNNEL_ENTRY_TYPES, EVENT_TYPES } from "../db/eventTypes.js";
import { sql, eq } from "drizzle-orm";

let running: Promise<void> | null = null;
let rerunRequested = false;

/**
 * Recomputes daily_stats. Runs after every incoming event, so a burst of joins
 * used to start one full recomputation each.
 *
 * Calls that arrive while a pass is running now fold into a single follow-up
 * pass instead. Whoever awaits the returned promise still gets stats that
 * include everything logged before the call: the follow-up starts after it.
 */
export function aggregate(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerunRequested = false;
        aggregateOnce();
        // Lets calls made meanwhile register before deciding on another pass.
        await Promise.resolve();
      } while (rerunRequested);
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Rebuilds the table from scratch, in one synchronous transaction.
 *
 * Upserting only the (campaign, day) pairs that still have events left every
 * other row as it was: a link moved to another campaign kept counting towards
 * the old one too, and so did events removed as duplicates. Rebuilding drops
 * those rows. Being synchronous, the pass also cannot be interleaved with
 * anything else in the process — a campaign deleted halfway through used to
 * get its rows written back, or fail the pass on the foreign key.
 */
function aggregateOnce() {
  console.log("[CRON] Running daily aggregation job...");
  try {
    const funnelTypesSql = sql.join(
      FUNNEL_ENTRY_TYPES.map((t) => sql`${t}`),
      sql`, `
    );

    const count = db.transaction((tx) => {
      const aggregatedData = tx
        .select({
          campaignId: links.campaignId,
          date: sql<string>`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`,
          subs: sql<number>`count(distinct case when ${events.eventType} in (${funnelTypesSql}) then ${events.tgUserId} end)`,
          revenue: sql<number>`coalesce(sum(case when ${events.eventType} in (${EVENT_TYPES.PAYMENT}, ${EVENT_TYPES.RENEWAL}) then ${events.amount} else 0 end), 0)`,
        })
        .from(events)
        .innerJoin(links, eq(events.linkId, links.id))
        .innerJoin(campaigns, eq(links.campaignId, campaigns.id))
        .groupBy(links.campaignId, sql`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`)
        .all();

      tx.delete(dailyStats).run();

      for (const row of aggregatedData) {
        if (!row.campaignId || !row.date) continue;

        // cps is intentionally stored as null: campaign price divided by a single
        // day's subscriber count is not additive across days and isn't a valid
        // trend metric. Cost-per-buyer is computed correctly (cumulative, unique
        // buyers unioned across campaigns) in services/metrics.ts instead.
        tx.insert(dailyStats)
          .values({
            campaignId: row.campaignId,
            date: row.date,
            subs: Number(row.subs) || 0,
            revenue: Number(row.revenue) || 0,
            cps: null,
          })
          .run();
      }

      return aggregatedData.length;
    });

    console.log(`[CRON] Aggregation completed for ${count} record(s).`);
  } catch (error) {
    console.error("[CRON] Aggregation error:", error);
  }
}

// Schedule job to run every day at 03:00
cron.schedule("0 3 * * *", () => {
  aggregate();
});

// Run aggregate immediately upon module load
aggregate();
