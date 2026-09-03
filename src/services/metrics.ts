import { db } from "../db/index.js";
import { dailyStats, campaigns, campaignTags, links, events, projects } from "../db/schema.js";
import { eq, and, inArray, sql, isNull, isNotNull, desc } from "drizzle-orm";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";

export interface CohortLtvAgg {
  acquiredUsers: number;
  cohortRevenue: number;
}

// Maps each tgUserId to the campaign AND link of their very FIRST funnel-entry
// event (join/lead/trial_start), then sums ALL their lifetime payment+renewal
// amounts regardless of which link those specific later events are attributed
// to via last-touch. Unlike totalRevenue elsewhere in this file, this number
// never moves to a different campaign/link just because the user later clicked
// a different ad — it answers "how much did the people THIS campaign (or this
// exact link) originally acquired end up paying, in total, ever."
export async function getCohortLtv(): Promise<{
  byCampaign: Map<number, CohortLtvAgg>;
  byLink: Map<number, CohortLtvAgg>;
}> {
  const entryRows = await db
    .select({
      tgUserId: events.tgUserId,
      linkId: events.linkId,
      campaignId: links.campaignId,
      ts: events.ts,
    })
    .from(events)
    .innerJoin(links, eq(events.linkId, links.id))
    .where(inArray(events.eventType, FUNNEL_ENTRY_TYPES as unknown as string[]));

  const firstTouchByUser = new Map<string, { campaignId: number; linkId: number; ts: number }>();
  for (const row of entryRows) {
    const tsMs = row.ts.getTime();
    const existing = firstTouchByUser.get(row.tgUserId);
    if (!existing || tsMs < existing.ts) {
      firstTouchByUser.set(row.tgUserId, {
        campaignId: row.campaignId,
        linkId: row.linkId,
        ts: tsMs,
      });
    }
  }

  const paymentRows = await db
    .select({ tgUserId: events.tgUserId, amount: events.amount })
    .from(events)
    .where(inArray(events.eventType, [EVENT_TYPES.PAYMENT, EVENT_TYPES.RENEWAL]));

  const revenueByUser = new Map<string, number>();
  for (const row of paymentRows) {
    revenueByUser.set(row.tgUserId, (revenueByUser.get(row.tgUserId) || 0) + (row.amount || 0));
  }

  const byCampaign = new Map<number, CohortLtvAgg>();
  const byLink = new Map<number, CohortLtvAgg>();
  for (const [tgUserId, touch] of firstTouchByUser.entries()) {
    const revenue = revenueByUser.get(tgUserId) || 0;

    const campAgg = byCampaign.get(touch.campaignId) || { acquiredUsers: 0, cohortRevenue: 0 };
    campAgg.acquiredUsers += 1;
    campAgg.cohortRevenue += revenue;
    byCampaign.set(touch.campaignId, campAgg);

    const linkAgg = byLink.get(touch.linkId) || { acquiredUsers: 0, cohortRevenue: 0 };
    linkAgg.acquiredUsers += 1;
    linkAgg.cohortRevenue += revenue;
    byLink.set(touch.linkId, linkAgg);
  }

  return { byCampaign, byLink };
}

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
  const campaignsList = await db.select().from(campaigns).where(isNull(campaigns.deletedAt));
  const statsList = await db.select().from(dailyStats);

  // Unique first-time buyers (payment events) attributed to each campaign via its links.
  // Used for avgCps ("₽/покупка" = ad spend per privatka purchase) — deliberately NOT the
  // channel-join count, since a campaign's ad spend buys channel subscribers but the cost
  // that matters here is cost per paying privatka customer they convert into.
  const paymentRows = await db
    .select({ campaignId: links.campaignId, tgUserId: events.tgUserId })
    .from(events)
    .innerJoin(links, eq(events.linkId, links.id))
    .where(eq(events.eventType, EVENT_TYPES.PAYMENT));
  const buyersByCampaign = new Map<number, Set<string>>();
  for (const row of paymentRows) {
    const set = buyersByCampaign.get(row.campaignId) ?? new Set<string>();
    set.add(row.tgUserId);
    buyersByCampaign.set(row.campaignId, set);
  }

  const { byCampaign: cohortByCampaign } = await getCohortLtv();

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
    const uniqueBuyers = new Set<string>();
    const retentions24: number[] = [];
    const retentions48: number[] = [];
    let cohortAcquiredUsers = 0;
    let cohortRevenue = 0;

    for (const c of campList) {
      const cStats = statsList.filter((s) => s.campaignId === c.id);
      totalSubs += cStats.reduce((sum, s) => sum + (s.subs || 0), 0);
      totalRevenue += cStats.reduce((sum, s) => sum + (s.revenue || 0), 0);
      for (const buyer of buyersByCampaign.get(c.id) ?? []) {
        uniqueBuyers.add(buyer);
      }
      const cohort = cohortByCampaign.get(c.id);
      if (cohort) {
        cohortAcquiredUsers += cohort.acquiredUsers;
        cohortRevenue += cohort.cohortRevenue;
      }

      const ret = await getRetentionStats(c.id);
      if (ret.retention24h !== null) {
        retentions24.push(ret.retention24h);
      }
      if (ret.retention48h !== null) {
        retentions48.push(ret.retention48h);
      }
    }

    const totalBuyers = uniqueBuyers.size;
    const avgCps = totalBuyers > 0 ? Number((totalPrice / totalBuyers).toFixed(2)) : null;
    const avgPricePerSub = totalSubs > 0 ? Number((totalPrice / totalSubs).toFixed(2)) : null;
    const avgRetention24h = retentions24.length > 0
      ? Number((retentions24.reduce((sum, r) => sum + r, 0) / retentions24.length).toFixed(2))
      : null;
    const avgRetention48h = retentions48.length > 0
      ? Number((retentions48.reduce((sum, r) => sum + r, 0) / retentions48.length).toFixed(2))
      : null;
    const avgCohortLtv = cohortAcquiredUsers > 0 ? Number((cohortRevenue / cohortAcquiredUsers).toFixed(2)) : null;

    result.push({
      advertiser,
      campaignsCount,
      totalPrice,
      totalSubs,
      totalRevenue,
      avgCps,
      avgPricePerSub,
      avgRetention24h,
      avgRetention48h,
      cohortAcquiredUsers,
      avgCohortLtv,
    });
  }

  return result;
}

export interface AdvertisersPageParams {
  page: number;
  pageSize: number;
  q?: string;
}

export interface AdvertiserPageRow {
  advertiser: string;
  campaignsCount: number;
  totalPrice: number;
  totalSubs: number;
  totalRevenue: number;
  avgCps: number | null;
  avgPricePerSub: number | null;
  avgRetention24h: number | null;
  avgRetention48h: number | null;
  cohortAcquiredUsers: number;
  avgCohortLtv: number | null;
}

// Paginated version of getAdvertiserStats(): groups+sorts by revenue in SQL
// and limits the retention/buyer lookups to the campaigns that belong to the
// advertisers on the requested page, instead of walking every campaign in
// the project on every load.
export async function getAdvertisersPage(
  params: AdvertisersPageParams
): Promise<{ rows: AdvertiserPageRow[]; total: number }> {
  const { page, pageSize } = params;
  const q = params.q?.trim();
  const offset = (page - 1) * pageSize;

  const searchCond = q
    ? and(isNull(campaigns.deletedAt), sql`lower_unicode(${campaigns.advertiser}) LIKE lower_unicode(${`%${q}%`})`)
    : isNull(campaigns.deletedAt);

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${campaigns.advertiser})` })
    .from(campaigns)
    .where(searchCond);

  if (Number(total) === 0) return { rows: [], total: 0 };

  const campaignAgg = db
    .select({
      campaignId: dailyStats.campaignId,
      subs: sql<number>`sum(${dailyStats.subs})`.as("subs"),
      revenue: sql<number>`sum(${dailyStats.revenue})`.as("revenue"),
    })
    .from(dailyStats)
    .groupBy(dailyStats.campaignId)
    .as("campaign_agg");

  const grouped = await db
    .select({
      advertiser: campaigns.advertiser,
      campaignsCount: sql<number>`count(*)`,
      totalPrice: sql<number>`coalesce(sum(${campaigns.price}), 0)`,
      totalSubs: sql<number>`coalesce(sum(${campaignAgg.subs}), 0)`,
      totalRevenue: sql<number>`coalesce(sum(${campaignAgg.revenue}), 0)`,
    })
    .from(campaigns)
    .leftJoin(campaignAgg, eq(campaignAgg.campaignId, campaigns.id))
    .where(searchCond)
    .groupBy(campaigns.advertiser)
    .orderBy(sql`coalesce(sum(${campaignAgg.revenue}), 0) desc`)
    .limit(pageSize)
    .offset(offset);

  if (grouped.length === 0) return { rows: [], total: Number(total) || 0 };

  const advertiserNames = grouped.map((g) => g.advertiser);

  const advertiserCampaigns = await db
    .select({ id: campaigns.id, advertiser: campaigns.advertiser })
    .from(campaigns)
    .where(and(inArray(campaigns.advertiser, advertiserNames), isNull(campaigns.deletedAt)));

  const campaignIdsByAdvertiser = new Map<string, number[]>();
  for (const c of advertiserCampaigns) {
    const arr = campaignIdsByAdvertiser.get(c.advertiser) || [];
    arr.push(c.id);
    campaignIdsByAdvertiser.set(c.advertiser, arr);
  }
  const allCampaignIds = advertiserCampaigns.map((c) => c.id);

  const paymentRows = allCampaignIds.length
    ? await db
        .select({ campaignId: links.campaignId, tgUserId: events.tgUserId })
        .from(events)
        .innerJoin(links, eq(events.linkId, links.id))
        .where(and(inArray(links.campaignId, allCampaignIds), eq(events.eventType, EVENT_TYPES.PAYMENT)))
    : [];
  const buyersByCampaign = new Map<number, Set<string>>();
  for (const row of paymentRows) {
    const set = buyersByCampaign.get(row.campaignId) ?? new Set<string>();
    set.add(row.tgUserId);
    buyersByCampaign.set(row.campaignId, set);
  }

  const retentionByCampaign = new Map<number, { retention24h: number | null; retention48h: number | null }>();
  await Promise.all(
    allCampaignIds.map(async (id) => {
      retentionByCampaign.set(id, await getRetentionStats(id));
    })
  );

  const { byCampaign: cohortByCampaign } = await getCohortLtv();

  const rows: AdvertiserPageRow[] = grouped.map((g) => {
    const campIds = campaignIdsByAdvertiser.get(g.advertiser) || [];
    const uniqueBuyers = new Set<string>();
    const retentions24: number[] = [];
    const retentions48: number[] = [];
    let cohortAcquiredUsers = 0;
    let cohortRevenue = 0;
    for (const id of campIds) {
      for (const buyer of buyersByCampaign.get(id) ?? []) {
        uniqueBuyers.add(buyer);
      }
      const ret = retentionByCampaign.get(id);
      if (ret?.retention24h !== null && ret?.retention24h !== undefined) retentions24.push(ret.retention24h);
      if (ret?.retention48h !== null && ret?.retention48h !== undefined) retentions48.push(ret.retention48h);
      const cohort = cohortByCampaign.get(id);
      if (cohort) {
        cohortAcquiredUsers += cohort.acquiredUsers;
        cohortRevenue += cohort.cohortRevenue;
      }
    }
    const totalBuyers = uniqueBuyers.size;
    const totalPrice = Number(g.totalPrice) || 0;
    const totalSubs = Number(g.totalSubs) || 0;
    const totalRevenue = Number(g.totalRevenue) || 0;

    return {
      advertiser: g.advertiser,
      campaignsCount: Number(g.campaignsCount) || 0,
      totalPrice,
      totalSubs,
      totalRevenue,
      avgCps: totalBuyers > 0 ? Number((totalPrice / totalBuyers).toFixed(2)) : null,
      avgPricePerSub: totalSubs > 0 ? Number((totalPrice / totalSubs).toFixed(2)) : null,
      avgRetention24h:
        retentions24.length > 0
          ? Number((retentions24.reduce((s, r) => s + r, 0) / retentions24.length).toFixed(2))
          : null,
      avgRetention48h:
        retentions48.length > 0
          ? Number((retentions48.reduce((s, r) => s + r, 0) / retentions48.length).toFixed(2))
          : null,
      cohortAcquiredUsers,
      avgCohortLtv: cohortAcquiredUsers > 0 ? Number((cohortRevenue / cohortAcquiredUsers).toFixed(2)) : null,
    };
  });

  return { rows, total: Number(total) || 0 };
}

export interface CreativesPageParams {
  page: number;
  pageSize: number;
  q?: string;
}

export interface CreativePageRow {
  creative: string; // '' == campaigns that never got a creative tag
  campaignsCount: number;
  totalPrice: number;
  totalSubs: number;
  totalRevenue: number;
  avgCps: number | null;
  avgPricePerSub: number | null;
  avgRetention24h: number | null;
  avgRetention48h: number | null;
  cohortAcquiredUsers: number;
  avgCohortLtv: number | null;
}

// Same shape as getAdvertisersPage, but grouped by the campaign's "creative"
// tag instead of its advertiser — this is what powers the «По креативам» mode,
// where the point is comparing creatives against each other rather than
// buyers. The tagKey filter lives in the LEFT JOIN's ON clause on purpose: put
// it in WHERE and the left join silently degrades into an inner one, dropping
// every campaign without a creative tag out of the totals instead of
// collecting them into one "no creative" bucket.
export async function getCreativesPage(
  params: CreativesPageParams
): Promise<{ rows: CreativePageRow[]; total: number }> {
  const { page, pageSize } = params;
  const q = params.q?.trim();
  const offset = (page - 1) * pageSize;

  const creativeKey = sql<string>`coalesce(${campaignTags.tagValue}, '')`;
  const creativeJoin = and(
    eq(campaignTags.campaignId, campaigns.id),
    eq(campaignTags.tagKey, "creative")
  );

  const searchCond = q
    ? and(
        isNull(campaigns.deletedAt),
        sql`lower_unicode(coalesce(${campaignTags.tagValue}, '')) LIKE lower_unicode(${`%${q}%`})`
      )
    : isNull(campaigns.deletedAt);

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${creativeKey})` })
    .from(campaigns)
    .leftJoin(campaignTags, creativeJoin)
    .where(searchCond);

  if (Number(total) === 0) return { rows: [], total: 0 };

  const campaignAgg = db
    .select({
      campaignId: dailyStats.campaignId,
      subs: sql<number>`sum(${dailyStats.subs})`.as("subs"),
      revenue: sql<number>`sum(${dailyStats.revenue})`.as("revenue"),
    })
    .from(dailyStats)
    .groupBy(dailyStats.campaignId)
    .as("campaign_agg");

  const grouped = await db
    .select({
      creative: creativeKey,
      campaignsCount: sql<number>`count(*)`,
      totalPrice: sql<number>`coalesce(sum(${campaigns.price}), 0)`,
      totalSubs: sql<number>`coalesce(sum(${campaignAgg.subs}), 0)`,
      totalRevenue: sql<number>`coalesce(sum(${campaignAgg.revenue}), 0)`,
    })
    .from(campaigns)
    .leftJoin(campaignTags, creativeJoin)
    .leftJoin(campaignAgg, eq(campaignAgg.campaignId, campaigns.id))
    .where(searchCond)
    .groupBy(creativeKey)
    .orderBy(sql`coalesce(sum(${campaignAgg.revenue}), 0) desc`)
    .limit(pageSize)
    .offset(offset);

  if (grouped.length === 0) return { rows: [], total: Number(total) || 0 };

  // Campaign counts here are small, so resolving "which campaigns belong to
  // the creatives on this page" in JS is simpler (and safer) than trying to
  // feed a SQL expression into inArray().
  const allCampaigns = await db
    .select({ id: campaigns.id, creative: creativeKey })
    .from(campaigns)
    .leftJoin(campaignTags, creativeJoin)
    .where(isNull(campaigns.deletedAt));

  const wanted = new Set(grouped.map((g) => g.creative));
  const campaignIdsByCreative = new Map<string, number[]>();
  for (const c of allCampaigns) {
    if (!wanted.has(c.creative)) continue;
    const arr = campaignIdsByCreative.get(c.creative) || [];
    arr.push(c.id);
    campaignIdsByCreative.set(c.creative, arr);
  }
  const allCampaignIds = [...campaignIdsByCreative.values()].flat();

  const paymentRows = allCampaignIds.length
    ? await db
        .select({ campaignId: links.campaignId, tgUserId: events.tgUserId })
        .from(events)
        .innerJoin(links, eq(events.linkId, links.id))
        .where(and(inArray(links.campaignId, allCampaignIds), eq(events.eventType, EVENT_TYPES.PAYMENT)))
    : [];
  const buyersByCampaign = new Map<number, Set<string>>();
  for (const row of paymentRows) {
    const set = buyersByCampaign.get(row.campaignId) ?? new Set<string>();
    set.add(row.tgUserId);
    buyersByCampaign.set(row.campaignId, set);
  }

  const retentionByCampaign = new Map<number, { retention24h: number | null; retention48h: number | null }>();
  await Promise.all(
    allCampaignIds.map(async (id) => {
      retentionByCampaign.set(id, await getRetentionStats(id));
    })
  );

  const { byCampaign: cohortByCampaign } = await getCohortLtv();

  const rows: CreativePageRow[] = grouped.map((g) => {
    const campIds = campaignIdsByCreative.get(g.creative) || [];
    const uniqueBuyers = new Set<string>();
    const retentions24: number[] = [];
    const retentions48: number[] = [];
    let cohortAcquiredUsers = 0;
    let cohortRevenue = 0;
    for (const id of campIds) {
      for (const buyer of buyersByCampaign.get(id) ?? []) {
        uniqueBuyers.add(buyer);
      }
      const ret = retentionByCampaign.get(id);
      if (ret?.retention24h !== null && ret?.retention24h !== undefined) retentions24.push(ret.retention24h);
      if (ret?.retention48h !== null && ret?.retention48h !== undefined) retentions48.push(ret.retention48h);
      const cohort = cohortByCampaign.get(id);
      if (cohort) {
        cohortAcquiredUsers += cohort.acquiredUsers;
        cohortRevenue += cohort.cohortRevenue;
      }
    }
    const totalBuyers = uniqueBuyers.size;
    const totalPrice = Number(g.totalPrice) || 0;
    const totalSubs = Number(g.totalSubs) || 0;
    const totalRevenue = Number(g.totalRevenue) || 0;

    return {
      creative: g.creative,
      campaignsCount: Number(g.campaignsCount) || 0,
      totalPrice,
      totalSubs,
      totalRevenue,
      avgCps: totalBuyers > 0 ? Number((totalPrice / totalBuyers).toFixed(2)) : null,
      avgPricePerSub: totalSubs > 0 ? Number((totalPrice / totalSubs).toFixed(2)) : null,
      avgRetention24h:
        retentions24.length > 0
          ? Number((retentions24.reduce((s, r) => s + r, 0) / retentions24.length).toFixed(2))
          : null,
      avgRetention48h:
        retentions48.length > 0
          ? Number((retentions48.reduce((s, r) => s + r, 0) / retentions48.length).toFixed(2))
          : null,
      cohortAcquiredUsers,
      avgCohortLtv: cohortAcquiredUsers > 0 ? Number((cohortRevenue / cohortAcquiredUsers).toFixed(2)) : null,
    };
  });

  return { rows, total: Number(total) || 0 };
}

export async function getMetrics() {
  const statsList = await db.select().from(dailyStats);
  const campaignsList = await db.select().from(campaigns).where(isNull(campaigns.deletedAt));
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

export interface PromoCodeStats {
  promoCode: string;
  /** Paid orders that used the code — first purchases and renewals alike. */
  redemptions: number;
  /** Distinct people who used it, which differs from redemptions on renewals. */
  buyers: number;
  /** Money actually received on those orders, already net of the discount. */
  revenue: number;
  /** Total given away. Revenue plus this is what the same orders would have cost. */
  discountGiven: number;
  /** Average cheque on the discounted orders. */
  avgOrder: number;
  lastUsedAt: Date | null;
}

/**
 * Per-code promo performance, busiest first.
 *
 * Reads the payment events rather than the bots' own tables, so it covers every
 * bot reporting into this service and needs no cross-database access. `amount`
 * on an event is already the sum charged, so revenue here is real money in —
 * `discountGiven` is what it would additionally have been at list price.
 */
export async function getPromoStats(): Promise<PromoCodeStats[]> {
  const rows = await db
    .select({
      promoCode: events.promoCode,
      redemptions: sql<number>`count(*)`,
      buyers: sql<number>`count(distinct ${events.tgUserId})`,
      revenue: sql<number>`coalesce(sum(${events.amount}), 0)`,
      discountGiven: sql<number>`coalesce(sum(${events.discountAmount}), 0)`,
      lastUsedTs: sql<number | null>`max(${events.ts})`,
    })
    .from(events)
    .where(
      and(
        isNotNull(events.promoCode),
        inArray(events.eventType, [EVENT_TYPES.PAYMENT, EVENT_TYPES.RENEWAL])
      )
    )
    .groupBy(events.promoCode)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r) => ({
    promoCode: r.promoCode as string,
    redemptions: Number(r.redemptions),
    buyers: Number(r.buyers),
    revenue: Number(r.revenue),
    discountGiven: Number(r.discountGiven),
    avgOrder: Number(r.redemptions) > 0 ? Number(r.revenue) / Number(r.redemptions) : 0,
    lastUsedAt: r.lastUsedTs ? new Date(Number(r.lastUsedTs) * 1000) : null,
  }));
}
