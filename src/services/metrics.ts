import { db } from "../db/index.js";
import { dailyStats, campaigns, campaignTags, links, events } from "../db/schema.js";
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

    for (const c of campList) {
      const cStats = statsList.filter((s) => s.campaignId === c.id);
      totalSubs += cStats.reduce((sum, s) => sum + (s.subs || 0), 0);
      totalRevenue += cStats.reduce((sum, s) => sum + (s.revenue || 0), 0);

      const ret = await getRetentionStats(c.id);
      if (ret.retention24h !== null) {
        retentions24.push(ret.retention24h);
      }
    }

    const avgCps = totalSubs > 0 ? Number((totalPrice / totalSubs).toFixed(2)) : null;
    const avgRetention24h = retentions24.length > 0
      ? Number((retentions24.reduce((sum, r) => sum + r, 0) / retentions24.length).toFixed(2))
      : null;

    result.push({
      advertiser,
      campaignsCount,
      totalPrice,
      totalSubs,
      totalRevenue,
      avgCps,
      avgRetention24h,
    });
  }

  return result;
}

export async function getPrivatkaStats() {
  const deeplinks = await db
    .select()
    .from(links)
    .where(eq(links.linkType, "deeplink"));

  const campaignsList = await db.select().from(campaigns);
  const eventsList = await db.select().from(events);

  const result = [];

  for (const l of deeplinks) {
    const camp = campaignsList.find((c) => c.id === l.campaignId);
    const linkEvents = eventsList.filter((e) => e.linkId === l.id);

    const leadsCount = linkEvents.filter((e) => e.eventType === EVENT_TYPES.LEAD).length;

    const paymentEvents = linkEvents.filter((e) => e.eventType === EVENT_TYPES.PAYMENT);
    const uniquePurchasers = new Set(paymentEvents.map((e) => e.tgUserId));
    const purchasedCount = uniquePurchasers.size;

    const totalRevenueForLink = paymentEvents.reduce((sum, e) => sum + (e.amount || 0), 0);

    const conversionPct = leadsCount > 0
      ? Number(((purchasedCount / leadsCount) * 100).toFixed(2))
      : null;

    const avgCheckPerLead = leadsCount > 0
      ? Number((totalRevenueForLink / leadsCount).toFixed(2))
      : null;

    result.push({
      campaignId: l.campaignId,
      advertiser: camp?.advertiser || `Campaign #${l.campaignId}`,
      telegramRef: l.telegramRef,
      leadsCount,
      purchasedCount,
      conversionPct,
      avgCheckPerLead,
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
