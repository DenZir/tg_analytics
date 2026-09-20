import { db } from "../db/index.js";
import { events, projects, links, campaigns, utmLinks } from "../db/schema.js";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { EVENT_TYPES, EVENT_SOURCES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";

/**
 * The main screen's data source.
 *
 * Everything here is computed straight off `events`, grouped by project rather
 * than by campaign. That is the whole point: a campaign-shaped query can only
 * see traffic that arrived through a tracked link, so organic buyers — the
 * majority in a bot-only project — were invisible no matter how carefully they
 * were recorded. Grouping by project makes the three attribution buckets add up
 * to the project total by construction, which is what makes a missing-events
 * problem visible instead of silent.
 *
 * Deliberately not reading `daily_stats`: that table is keyed by campaign and
 * so inherits the same blind spot. At this data volume a direct GROUP BY costs
 * nothing and cannot go stale.
 */

const ENTRY_TYPES = FUNNEL_ENTRY_TYPES as unknown as string[];
const REVENUE_TYPES: string[] = [EVENT_TYPES.PAYMENT, EVENT_TYPES.RENEWAL];

export interface OverviewParams {
  /** Empty or omitted means every project — the "Все" option. */
  projectIds?: number[];
  /**
   * Size of the window the totals cover, in days. 0 (or omitted) means all time
   * — the "Все" option in the period switch. The daily chart always spans
   * SERIES_DAYS regardless, since a chart of a single week is not worth drawing.
   *
   * The window has to be applied server-side: unique users and unique buyers
   * are distinct counts, and summing per-day distinct counts over a week gives
   * a larger, wrong number.
   */
  days?: number;
}

export interface SourceBreakdownRow {
  source: string;
  uniqueEntries: number;
  payments: number;
  revenue: number;
  revenueSharePct: number | null;
}

export interface OverviewTotals {
  /** Everyone the project saw at all, whatever they did. */
  uniqueUsers: number;
  uniqueEntries: number;
  payments: number;
  renewals: number;
  revenue: number;
  uniqueBuyers: number;
  avgCheck: number | null;
  conversionPct: number | null;
}

const MAX_DAYS = 365;
const SERIES_DAYS = 90;

function startOfDayUtcDaysAgo(days: number): Date {
  const d = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function scopeCondition(projectIds?: number[], since?: Date) {
  const parts = [];
  if (projectIds && projectIds.length > 0) parts.push(inArray(events.projectId, projectIds));
  if (since) parts.push(gte(events.ts, since));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

export async function getOverview(params: OverviewParams = {}) {
  const requestedDays = params.days ?? 0;
  const windowDays =
    requestedDays > 0 ? Math.min(MAX_DAYS, Math.max(1, Math.floor(requestedDays))) : null;
  const projectIds = params.projectIds?.length ? params.projectIds : undefined;
  const where = scopeCondition(projectIds, windowDays ? startOfDayUtcDaysAgo(windowDays) : undefined);

  const projectList = await db
    .select({ id: projects.id, name: projects.name, type: projects.type })
    .from(projects)
    .orderBy(projects.id);

  // --- totals ---------------------------------------------------------------
  const entryExpr = sql<number>`count(distinct case when ${events.eventType} in (${sql.join(
    ENTRY_TYPES.map((t) => sql`${t}`),
    sql`, `
  )}) then ${events.tgUserId} end)`;

  const [totalsRow] = await db
    .select({
      uniqueUsers: sql<number>`count(distinct ${events.tgUserId})`,
      uniqueEntries: entryExpr,
      payments: sql<number>`count(case when ${events.eventType} = ${EVENT_TYPES.PAYMENT} then 1 end)`,
      renewals: sql<number>`count(case when ${events.eventType} = ${EVENT_TYPES.RENEWAL} then 1 end)`,
      revenue: sql<number>`coalesce(sum(case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then ${events.amount} else 0 end), 0)`,
      uniqueBuyers: sql<number>`count(distinct case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then ${events.tgUserId} end)`,
    })
    .from(events)
    .where(where);

  const paymentsCount = Number(totalsRow?.payments ?? 0);
  const renewalsCount = Number(totalsRow?.renewals ?? 0);
  const revenue = Number(totalsRow?.revenue ?? 0);
  const uniqueEntries = Number(totalsRow?.uniqueEntries ?? 0);
  const uniqueUsers = Number(totalsRow?.uniqueUsers ?? 0);
  const uniqueBuyers = Number(totalsRow?.uniqueBuyers ?? 0);
  const salesCount = paymentsCount + renewalsCount;

  const totals: OverviewTotals = {
    uniqueUsers,
    uniqueEntries,
    payments: paymentsCount,
    renewals: renewalsCount,
    revenue: round2(revenue),
    uniqueBuyers,
    avgCheck: salesCount > 0 ? round2(revenue / salesCount) : null,
    // Divided by everyone seen, not by funnel entries. An organic buyer whose
    // bot never reported a /start has no entry event, and dividing by entries
    // alone produced conversions above 100% — a number that reads as a broken
    // dashboard rather than as the missing lead event it actually is.
    conversionPct: uniqueUsers > 0 ? round2((uniqueBuyers / uniqueUsers) * 100) : null,
  };

  // --- where the money actually came from -----------------------------------
  const sourceRows = await db
    .select({
      source: events.source,
      uniqueEntries: entryExpr,
      payments: sql<number>`count(case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then 1 end)`,
      revenue: sql<number>`coalesce(sum(case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then ${events.amount} else 0 end), 0)`,
    })
    .from(events)
    .where(where)
    .groupBy(events.source);

  const bySourceMap = new Map<string, SourceBreakdownRow>();
  for (const s of [EVENT_SOURCES.LINK, EVENT_SOURCES.UTM, EVENT_SOURCES.ORGANIC]) {
    bySourceMap.set(s, {
      source: s,
      uniqueEntries: 0,
      payments: 0,
      revenue: 0,
      revenueSharePct: revenue > 0 ? 0 : null,
    });
  }
  for (const row of sourceRows) {
    const rowRevenue = Number(row.revenue ?? 0);
    bySourceMap.set(row.source, {
      source: row.source,
      uniqueEntries: Number(row.uniqueEntries ?? 0),
      payments: Number(row.payments ?? 0),
      revenue: round2(rowRevenue),
      revenueSharePct: revenue > 0 ? round2((rowRevenue / revenue) * 100) : null,
    });
  }
  const bySource = [...bySourceMap.values()];

  // --- daily series ---------------------------------------------------------
  const since = startOfDayUtcDaysAgo(SERIES_DAYS);

  const dailyRows = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`,
      uniqueEntries: entryExpr,
      revenue: sql<number>`coalesce(sum(case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then ${events.amount} else 0 end), 0)`,
      payments: sql<number>`count(case when ${events.eventType} in (${sql.join(
        REVENUE_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}) then 1 end)`,
    })
    .from(events)
    .where(scopeCondition(projectIds, since))
    .groupBy(sql`strftime('%Y-%m-%d', ${events.ts}, 'unixepoch')`);

  const dailyByDate = new Map(dailyRows.map((r) => [r.date, r]));
  const daily = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = dailyByDate.get(key);
    daily.push({
      date: key,
      uniqueEntries: Number(row?.uniqueEntries ?? 0),
      revenue: round2(Number(row?.revenue ?? 0)),
      payments: Number(row?.payments ?? 0),
    });
  }

  // --- leaders --------------------------------------------------------------
  const revenueExpr = sql<number>`coalesce(sum(case when ${events.eventType} in (${sql.join(
    REVENUE_TYPES.map((t) => sql`${t}`),
    sql`, `
  )}) then ${events.amount} else 0 end), 0)`;

  const topCampaignRows = await db
    .select({
      campaignId: campaigns.id,
      advertiser: campaigns.advertiser,
      projectId: campaigns.projectId,
      revenue: revenueExpr,
      uniqueEntries: entryExpr,
    })
    .from(events)
    .innerJoin(links, eq(events.linkId, links.id))
    .innerJoin(campaigns, eq(links.campaignId, campaigns.id))
    .where(where)
    .groupBy(campaigns.id);

  const topUtmRows = await db
    .select({
      utmLinkId: utmLinks.id,
      label: utmLinks.label,
      utmSource: utmLinks.utmSource,
      utmCampaign: utmLinks.utmCampaign,
      projectId: utmLinks.projectId,
      revenue: revenueExpr,
      uniqueEntries: entryExpr,
    })
    .from(events)
    .innerJoin(utmLinks, eq(events.utmLinkId, utmLinks.id))
    .where(where)
    .groupBy(utmLinks.id);

  const byRevenueDesc = <T extends { revenue: number }>(rows: T[]) =>
    [...rows]
      .map((r) => ({ ...r, revenue: round2(Number(r.revenue ?? 0)) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

  return {
    scope: {
      projectIds: projectIds ?? projectList.map((p) => p.id),
      allProjects: !projectIds,
      windowDays,
      seriesDays: SERIES_DAYS,
    },
    projects: projectList,
    totals,
    bySource,
    daily,
    topCampaigns: byRevenueDesc(topCampaignRows),
    topUtmLinks: byRevenueDesc(topUtmRows),
  };
}
