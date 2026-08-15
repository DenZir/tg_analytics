import { db } from "../db/index.js";
import { dailyStats, campaigns, campaignTags, links, events, projects } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";

export async function getPurchaseConversion(campaignId: number) {
  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, campaignId));

  if (campaignLinks.length === 0) {
    return { entered: 0, purchased: 0, conversionPct: null };
  }

  const linkIds = campaignLinks.map((l) => l.id);

  // 1. entered = unique tgUserId with eventType in FUNNEL_ENTRY_TYPES across all links of this campaign
  const entryEvents = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.linkId, linkIds),
        inArray(events.eventType, FUNNEL_ENTRY_TYPES as unknown as string[])
      )
    );

  const uniqueEnteredUsers = new Set(entryEvents.map((e) => e.tgUserId));
  const entered = uniqueEnteredUsers.size;

  // 2. purchased = unique tgUserId with eventType = PAYMENT across all links of this campaign
  const paymentEvents = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.linkId, linkIds),
        eq(events.eventType, EVENT_TYPES.PAYMENT)
      )
    );

  const uniquePurchasedUsers = new Set(paymentEvents.map((e) => e.tgUserId));
  const purchased = uniquePurchasedUsers.size;

  // 3. conversionPct
  const conversionPct = entered > 0 ? Number(((purchased / entered) * 100).toFixed(2)) : null;

  return { entered, purchased, conversionPct };
}

export async function getRetentionStats(campaignId: number) {
  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, campaignId));

  if (campaignLinks.length === 0) {
    return { retention24h: null, retention48h: null };
  }

  const linkIds = campaignLinks.map((l) => l.id);

  // Entry events
  const entryEvents = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.linkId, linkIds),
        inArray(events.eventType, [
          EVENT_TYPES.JOIN,
          EVENT_TYPES.LEAD,
          EVENT_TYPES.TRIAL_START,
        ])
      )
    );

  if (entryEvents.length === 0) {
    return { retention24h: null, retention48h: null };
  }

  // Find first entry time per user
  const userFirstEntryMap = new Map<string, number>(); // tgUserId -> timestamp ms
  for (const ev of entryEvents) {
    const tsMs = new Date(ev.ts).getTime();
    const existing = userFirstEntryMap.get(ev.tgUserId);
    if (existing === undefined || tsMs < existing) {
      userFirstEntryMap.set(ev.tgUserId, tsMs);
    }
  }

  const userIds = Array.from(userFirstEntryMap.keys());
  const N = userIds.length;
  if (N === 0) {
    return { retention24h: null, retention48h: null };
  }

  // Get leave/churn events for these users
  const exitEvents = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.tgUserId, userIds),
        inArray(events.eventType, [EVENT_TYPES.LEAVE, EVENT_TYPES.CHURN])
      )
    );

  let retained24Count = 0;
  let retained48Count = 0;

  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_48H = 48 * 60 * 60 * 1000;

  for (const [userId, entryTsMs] of userFirstEntryMap.entries()) {
    const userExits = exitEvents.filter((e) => e.tgUserId === userId);

    // Left within 24h?
    const leftWithin24h = userExits.some((e) => {
      const exitTsMs = new Date(e.ts).getTime();
      return exitTsMs > entryTsMs && exitTsMs <= entryTsMs + MS_24H;
    });

    // Left within 48h?
    const leftWithin48h = userExits.some((e) => {
      const exitTsMs = new Date(e.ts).getTime();
      return exitTsMs > entryTsMs && exitTsMs <= entryTsMs + MS_48H;
    });

    if (!leftWithin24h) retained24Count++;
    if (!leftWithin48h) retained48Count++;
  }

  const retention24h = Number(((retained24Count / N) * 100).toFixed(2));
  const retention48h = Number(((retained48Count / N) * 100).toFixed(2));

  return { retention24h, retention48h };
}

export async function getAdvertiserStats() {
  const campaignsList = await db.select().from(campaigns);
  const statsList = await db.select().from(dailyStats);

  // Group campaigns by advertiser
  const advertiserMap = new Map<string, typeof campaignsList>();
  for (const c of campaignsList) {
    const existing = advertiserMap.get(c.advertiser) || [];
    existing.push(c);
    advertiserMap.set(c.advertiser, existing);
  }

  const result = [];

  for (const [advertiser, campList] of advertiserMap.entries()) {
    const campaignsCount = campList.length;
    const totalPrice = campList.reduce((sum, c) => sum + (c.price || 0), 0);

    let totalSubs = 0;
    let totalRevenue = 0;
    const retentions24: number[] = [];
    const retentions48: number[] = [];

    for (const c of campList) {
      const cStats = statsList.filter((s) => s.campaignId === c.id);
      totalSubs += cStats.reduce((sum, s) => sum + (s.subs || 0), 0);
      totalRevenue += cStats.reduce((sum, s) => sum + (s.revenue || 0), 0);

      const ret = await getRetentionStats(c.id);
      if (ret.retention24h !== null) {
        retentions24.push(ret.retention24h);
      }
      if (ret.retention48h !== null) {
        retentions48.push(ret.retention48h);
      }
    }

    const avgCps = totalSubs > 0 ? Number((totalPrice / totalSubs).toFixed(2)) : null;
    const avgRetention24h = retentions24.length > 0
      ? Number((retentions24.reduce((sum, r) => sum + r, 0) / retentions24.length).toFixed(2))
      : null;
    const avgRetention48h = retentions48.length > 0
      ? Number((retentions48.reduce((sum, r) => sum + r, 0) / retentions48.length).toFixed(2))
      : null;

    result.push({
      advertiser,
      campaignsCount,
      totalPrice,
      totalSubs,
      totalRevenue,
      avgCps,
      avgRetention24h,
      avgRetention48h,
    });
  }

  return result;
}

export async function getMetrics() {
  const statsList = await db.select().from(dailyStats);
  const campaignsList = await db.select().from(campaigns);
  const tagsList = await db.select().from(campaignTags);

  const daily = statsList.map((stat) => {
    const camp = campaignsList.find((c) => c.id === stat.campaignId);
    const creativeTag = tagsList.find(
      (t) => t.campaignId === stat.campaignId && t.tagKey === "creative"
    );

    return {
      ...stat,
      advertiser: camp?.advertiser || `Campaign #${stat.campaignId}`,
      price: camp?.price || 0,
      creative: creativeTag?.tagValue || "-",
    };
  });

  const campaignMetrics = campaignsList.map((camp) => {
    const campStats = statsList.filter((s) => s.campaignId === camp.id);
    const totalSubs = campStats.reduce((sum, s) => sum + (s.subs || 0), 0);
    const totalRevenue = campStats.reduce((sum, s) => sum + (s.revenue || 0), 0);
    const cps = totalSubs > 0 ? Number((camp.price / totalSubs).toFixed(2)) : null;

    const creativeTag = tagsList.find(
      (t) => t.campaignId === camp.id && t.tagKey === "creative"
    );

    return {
      id: camp.id,
      projectId: camp.projectId,
      advertiser: camp.advertiser,
      price: camp.price,
      creative: creativeTag?.tagValue || "-",
      totalSubs,
      totalRevenue,
      cps,
    };
  });

  return {
    campaigns: campaignMetrics,
    daily,
  };
}

type PrivatkaFinanceRow = {
  projectId: number;
  projectName: string;
  eventType: string;
  amount: number;
  tgUserId: string;
  ts: Date;
};

type PrivatkaWindowStats = {
  revenue: number;
  avgCheck: number | null;
  paymentsCount: number;
  renewalsCount: number;
  paymentsRevenue: number;
  renewalsRevenue: number;
  uniquePayers: number;
};

// Bucket a timestamp to its UTC calendar date, mirroring the day-bucketing
// convention already used by src/jobs/dailyAggregate.ts
// (strftime('%Y-%m-%d', ts, 'unixepoch')).
function dayKey(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

function computeWindowStats(rows: PrivatkaFinanceRow[]): PrivatkaWindowStats {
  let revenue = 0;
  let paymentsCount = 0;
  let renewalsCount = 0;
  let paymentsRevenue = 0;
  let renewalsRevenue = 0;
  const payers = new Set<string>();

  for (const r of rows) {
    revenue += r.amount;
    payers.add(r.tgUserId);
    if (r.eventType === EVENT_TYPES.PAYMENT) {
      paymentsCount += 1;
      paymentsRevenue += r.amount;
    } else if (r.eventType === EVENT_TYPES.RENEWAL) {
      renewalsCount += 1;
      renewalsRevenue += r.amount;
    }
  }

  const avgCheck = rows.length > 0 ? revenue / rows.length : null;

  return {
    revenue,
    avgCheck,
    paymentsCount,
    renewalsCount,
    paymentsRevenue,
    renewalsRevenue,
    uniquePayers: payers.size,
  };
}

export async function getPrivatkaFinance() {
  const privatkaProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.type, "bot_subscription"));

  const rows: PrivatkaFinanceRow[] = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      eventType: events.eventType,
      amount: events.amount,
      tgUserId: events.tgUserId,
      ts: events.ts,
    })
    .from(events)
    .innerJoin(links, eq(events.linkId, links.id))
    .innerJoin(campaigns, eq(links.campaignId, campaigns.id))
    .innerJoin(projects, eq(campaigns.projectId, projects.id))
    .where(
      and(
        eq(projects.type, "bot_subscription"),
        inArray(events.eventType, [EVENT_TYPES.PAYMENT, EVENT_TYPES.RENEWAL])
      )
    );

  const rowsByProject = new Map<number, PrivatkaFinanceRow[]>();
  for (const r of rows) {
    const list = rowsByProject.get(r.projectId) || [];
    list.push(r);
    rowsByProject.set(r.projectId, list);
  }

  const now = new Date();
  const todayKey = dayKey(now);
  const MS_DAY = 24 * 60 * 60 * 1000;
  const weekCutoff = now.getTime() - 7 * MS_DAY;
  const monthCutoff = now.getTime() - 30 * MS_DAY;

  return privatkaProjects.map((p) => {
    const projRows = rowsByProject.get(p.id) || [];

    const todayRows = projRows.filter((r) => dayKey(r.ts) === todayKey);
    const weekRows = projRows.filter((r) => r.ts.getTime() >= weekCutoff);
    const monthRows = projRows.filter((r) => r.ts.getTime() >= monthCutoff);

    const today = computeWindowStats(todayRows);
    const week = computeWindowStats(weekRows);
    const month = computeWindowStats(monthRows);
    const allTime = computeWindowStats(projRows);

    const allTimePayers = new Set(projRows.map((r) => r.tgUserId));
    const arppu = allTimePayers.size > 0 ? allTime.revenue / allTimePayers.size : null;

    const dailyBuckets = new Map<string, { revenue: number; payments: number }>();
    for (const r of projRows) {
      const key = dayKey(r.ts);
      const entry = dailyBuckets.get(key) || { revenue: 0, payments: 0 };
      entry.revenue += r.amount;
      entry.payments += 1;
      dailyBuckets.set(key, entry);
    }

    const dailySeries = [];
    for (let i = 29; i >= 0; i--) {
      const key = dayKey(new Date(now.getTime() - i * MS_DAY));
      const bucket = dailyBuckets.get(key) || { revenue: 0, payments: 0 };
      dailySeries.push({ date: key, revenue: bucket.revenue, payments: bucket.payments });
    }

    return {
      projectId: p.id,
      projectName: p.name,
      today,
      week,
      month,
      allTime,
      arppu,
      dailySeries,
    };
  });
}
