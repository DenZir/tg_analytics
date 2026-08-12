import cron from "node-cron";
import { db } from "../db/index.js";
import { events, links, campaigns, dailyStats } from "../db/schema.js";
import { FUNNEL_ENTRY_TYPES, EVENT_TYPES } from "../db/eventTypes.js";
import { sql, eq } from "drizzle-orm";

export async function aggregate() {
  console.log("[CRON] Running daily aggregation job...");
  try {
    const funnelTypesSql = sql.join(
      FUNNEL_ENTRY_TYPES.map((t) => sql`${t}`),
      sql`, `
    );

    const aggregatedData = await db
      .select({
        campaignId: links.campaignId,
        date: sql<string>`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`,
        subs: sql<number>`count(distinct case when ${events.eventType} in (${funnelTypesSql}) then ${events.tgUserId} end)`,
        revenue: sql<number>`coalesce(sum(case when ${events.eventType} = ${EVENT_TYPES.PAYMENT} then ${events.amount} else 0 end), 0)`,
        price: campaigns.price,
      })
      .from(events)
      .innerJoin(links, eq(events.linkId, links.id))
      .innerJoin(campaigns, eq(links.campaignId, campaigns.id))
      .groupBy(links.campaignId, sql`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`);

    for (const row of aggregatedData) {
      if (!row.campaignId || !row.date) continue;

      const subsCount = Number(row.subs) || 0;
      const totalRevenue = Number(row.revenue) || 0;
      const campaignPrice = Number(row.price) || 0;
      const cps = subsCount > 0 ? campaignPrice / subsCount : 0;

      await db
        .insert(dailyStats)
        .values({
          campaignId: row.campaignId,
          date: row.date,
          subs: subsCount,
          revenue: totalRevenue,
          cps: cps,
        })
        .onConflictDoUpdate({
          target: [dailyStats.campaignId, dailyStats.date],
          set: {
            subs: sql`excluded.subs`,
            revenue: sql`excluded.revenue`,
            cps: sql`excluded.cps`,
          },
        });
    }

    console.log(`[CRON] Aggregation completed for ${aggregatedData.length} record(s).`);
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
