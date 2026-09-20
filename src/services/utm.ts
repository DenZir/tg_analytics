import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { utmLinks, events } from "../db/schema.js";
import { eq, isNotNull } from "drizzle-orm";
import { EVENT_TYPES } from "../db/eventTypes.js";
import { logEvent } from "./events.js";

// UTM events are ordinary events now — same table, same vocabulary. What this
// mechanic used to call a "start" is what the rest of the system calls a lead:
// somebody pressed start in the bot. Keeping the old word would have left every
// UTM arrival outside the funnel, since only EVENT_TYPES.LEAD counts as an entry.
const UTM_EVENT_TYPES = {
  START: EVENT_TYPES.LEAD,
  PAYMENT: EVENT_TYPES.PAYMENT,
  RENEWAL: EVENT_TYPES.RENEWAL,
} as const;

const SLUG_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function generateSlug(length = 8): string {
  const bytes = randomBytes(length);
  let slug = "";
  for (let i = 0; i < length; i++) {
    slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return slug;
}

export interface CreateUtmLinkInput {
  /**
   * Which project this link feeds. Required: a UTM link that belongs to no
   * project is how the dashboard ended up unable to say where its traffic went.
   */
  projectId: number;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent?: string;
  label?: string;
  spend?: number;
  slug?: string;
  botUsername?: string;
}

// A deep link only exists once a bot username is known — either passed in at
// creation time, or (for links created before botUsername was persisted)
// never. Kept as one place so create/list/detail all agree on the format.
export function buildDeepLink(link: { slug: string; botUsername?: string | null }): string | null {
  return link.botUsername ? `https://t.me/${link.botUsername}?start=${link.slug}` : null;
}

const SLUG_GENERATION_ATTEMPTS = 3;

export async function createUtmLink(input: CreateUtmLinkInput) {
  let slug = input.slug;

  if (slug) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(
        `Invalid slug "${slug}": must match [A-Za-z0-9_-]{1,64}`
      );
    }
    const existing = await getUtmLinkBySlug(slug);
    if (existing) {
      throw new Error(`Slug "${slug}" is already taken`);
    }
  } else {
    let candidate = generateSlug();
    for (let attempt = 0; attempt < SLUG_GENERATION_ATTEMPTS; attempt++) {
      const existing = await getUtmLinkBySlug(candidate);
      if (!existing) break;
      candidate = generateSlug();
    }
    slug = candidate;
  }

  const [created] = await db
    .insert(utmLinks)
    .values({
      projectId: input.projectId,
      slug,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmContent: input.utmContent,
      label: input.label,
      spend: input.spend,
      botUsername: input.botUsername,
    })
    .returning();

  return created;
}

export async function getUtmLinkBySlug(slug: string) {
  const rows = await db
    .select()
    .from(utmLinks)
    .where(eq(utmLinks.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUtmLinkById(id: number) {
  const rows = await db.select().from(utmLinks).where(eq(utmLinks.id, id)).limit(1);
  return rows[0] ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

type UtmEventRow = {
  utmLinkId: number;
  tgUserId: string;
  eventType: string;
  amount: number;
  ts: Date;
};

/**
 * Reads UTM-attributed rows out of the shared `events` table in the shape the
 * metric helpers below already expect, so moving the storage did not ripple
 * into any of the arithmetic.
 */
async function selectUtmEvents(utmLinkId?: number): Promise<UtmEventRow[]> {
  const rows = await db
    .select({
      utmLinkId: events.utmLinkId,
      tgUserId: events.tgUserId,
      eventType: events.eventType,
      amount: events.amount,
      ts: events.ts,
    })
    .from(events)
    .where(
      utmLinkId === undefined ? isNotNull(events.utmLinkId) : eq(events.utmLinkId, utmLinkId)
    );

  return rows.filter((r): r is UtmEventRow => r.utmLinkId !== null);
}

function computeMetrics(rows: UtmEventRow[], spend: number | null) {
  const startRows = rows.filter((r) => r.eventType === UTM_EVENT_TYPES.START);
  const paymentRows = rows.filter((r) => r.eventType === UTM_EVENT_TYPES.PAYMENT);
  const renewalRows = rows.filter((r) => r.eventType === UTM_EVENT_TYPES.RENEWAL);

  const starts = startRows.length;
  const uniqueStartUsers = new Set(startRows.map((r) => r.tgUserId));
  const uniqueStarts = uniqueStartUsers.size;

  const purchases = paymentRows.length;
  const uniquePurchaserUsers = new Set(paymentRows.map((r) => r.tgUserId));
  const uniquePurchasers = uniquePurchaserUsers.size;

  const revenue = paymentRows.reduce((sum, r) => sum + r.amount, 0);

  const renewals = renewalRows.length;
  const renewalsRevenue = renewalRows.reduce((sum, r) => sum + r.amount, 0);
  const uniqueRenewalUsers = new Set(renewalRows.map((r) => r.tgUserId));

  const conversionPct =
    uniqueStarts > 0 ? Number(((uniquePurchasers / uniqueStarts) * 100).toFixed(2)) : null;

  const cac =
    spend !== null && spend !== undefined && uniquePurchasers > 0
      ? Number((spend / uniquePurchasers).toFixed(2))
      : null;

  const roi =
    spend !== null && spend !== undefined && spend > 0
      ? Number((((revenue - spend) / spend) * 100).toFixed(2))
      : null;

  const renewalRatePct =
    uniquePurchasers > 0
      ? Number(((uniqueRenewalUsers.size / uniquePurchasers) * 100).toFixed(2))
      : null;

  // medianTimeToPurchaseHours: for each user with both a 'start' and a 'payment'
  // event on this link, (first payment ts - first start ts) in hours.
  const firstStartByUser = new Map<string, number>();
  for (const r of startRows) {
    const tsMs = r.ts.getTime();
    const existing = firstStartByUser.get(r.tgUserId);
    if (existing === undefined || tsMs < existing) {
      firstStartByUser.set(r.tgUserId, tsMs);
    }
  }
  const firstPaymentByUser = new Map<string, number>();
  for (const r of paymentRows) {
    const tsMs = r.ts.getTime();
    const existing = firstPaymentByUser.get(r.tgUserId);
    if (existing === undefined || tsMs < existing) {
      firstPaymentByUser.set(r.tgUserId, tsMs);
    }
  }
  const timeToPurchaseHours: number[] = [];
  for (const [userId, startTsMs] of firstStartByUser.entries()) {
    const paymentTsMs = firstPaymentByUser.get(userId);
    if (paymentTsMs !== undefined) {
      timeToPurchaseHours.push((paymentTsMs - startTsMs) / (1000 * 60 * 60));
    }
  }
  const medianRaw = median(timeToPurchaseHours);
  const medianTimeToPurchaseHours = medianRaw !== null ? Number(medianRaw.toFixed(2)) : null;

  return {
    starts,
    uniqueStarts,
    purchases,
    uniquePurchasers,
    revenue,
    renewals,
    renewalsRevenue,
    conversionPct,
    cac,
    roi,
    renewalRatePct,
    medianTimeToPurchaseHours,
  };
}

// Maps each tgUserId to the utm link of their very FIRST 'start' event, then
// sums ALL their lifetime payment+renewal amounts regardless of which link
// those later events are attributed to via last-touch (recordUtmPurchase
// resolves to whichever 'start' was most recent, same drift problem as the
// campaigns/channel model — see the parallel getCohortLtvByCampaign in
// services/metrics.ts). Unlike the purchases/revenue in computeMetrics(),
// this number never moves to a different link just because the user later
// started via a different one.
function computeCohortLtv(allEvents: UtmEventRow[]): Map<number, { acquiredUsers: number; cohortRevenue: number }> {
  const firstStartByUser = new Map<string, { utmLinkId: number; ts: number }>();
  for (const e of allEvents) {
    if (e.eventType !== UTM_EVENT_TYPES.START) continue;
    const tsMs = e.ts.getTime();
    const existing = firstStartByUser.get(e.tgUserId);
    if (!existing || tsMs < existing.ts) {
      firstStartByUser.set(e.tgUserId, { utmLinkId: e.utmLinkId, ts: tsMs });
    }
  }

  const revenueByUser = new Map<string, number>();
  for (const e of allEvents) {
    if (e.eventType !== UTM_EVENT_TYPES.PAYMENT && e.eventType !== UTM_EVENT_TYPES.RENEWAL) continue;
    revenueByUser.set(e.tgUserId, (revenueByUser.get(e.tgUserId) || 0) + e.amount);
  }

  const byLink = new Map<number, { acquiredUsers: number; cohortRevenue: number }>();
  for (const [tgUserId, touch] of firstStartByUser.entries()) {
    const agg = byLink.get(touch.utmLinkId) || { acquiredUsers: 0, cohortRevenue: 0 };
    agg.acquiredUsers += 1;
    agg.cohortRevenue += revenueByUser.get(tgUserId) || 0;
    byLink.set(touch.utmLinkId, agg);
  }
  return byLink;
}

export async function listUtmLinksWithMetrics() {
  const linksList = await db.select().from(utmLinks);
  const allEvents = await selectUtmEvents();

  const eventsByLink = new Map<number, UtmEventRow[]>();
  for (const e of allEvents) {
    const list = eventsByLink.get(e.utmLinkId) || [];
    list.push(e);
    eventsByLink.set(e.utmLinkId, list);
  }
  const cohortByLink = computeCohortLtv(allEvents);

  return linksList.map((link) => {
    const rows = eventsByLink.get(link.id) || [];
    const cohort = cohortByLink.get(link.id);
    const cohortAcquiredUsers = cohort?.acquiredUsers ?? 0;
    return {
      ...link,
      deepLink: buildDeepLink(link),
      ...computeMetrics(rows, link.spend ?? null),
      cohortAcquiredUsers,
      avgCohortLtv: cohort && cohortAcquiredUsers > 0 ? Number((cohort.cohortRevenue / cohortAcquiredUsers).toFixed(2)) : null,
    };
  });
}

export async function getUtmLinkDetail(id: number) {
  const link = await getUtmLinkById(id);
  if (!link) return null;

  const rows = await selectUtmEvents(id);

  const metrics = computeMetrics(rows, link.spend ?? null);

  const now = new Date();
  const MS_DAY = 24 * 60 * 60 * 1000;

  const dailyBuckets = new Map<string, { starts: number; purchases: number; revenue: number }>();
  for (const r of rows) {
    const key = dayKey(r.ts);
    const bucket = dailyBuckets.get(key) || { starts: 0, purchases: 0, revenue: 0 };
    if (r.eventType === UTM_EVENT_TYPES.START) {
      bucket.starts += 1;
    } else if (r.eventType === UTM_EVENT_TYPES.PAYMENT) {
      bucket.purchases += 1;
      bucket.revenue += r.amount;
    }
    dailyBuckets.set(key, bucket);
  }

  const dailySeries = [];
  for (let i = 29; i >= 0; i--) {
    const key = dayKey(new Date(now.getTime() - i * MS_DAY));
    const bucket = dailyBuckets.get(key) || { starts: 0, purchases: 0, revenue: 0 };
    dailySeries.push({ date: key, starts: bucket.starts, purchases: bucket.purchases, revenue: bucket.revenue });
  }

  return {
    ...link,
    deepLink: buildDeepLink(link),
    ...metrics,
    dailySeries,
  };
}

export async function getUtmSourceRollup() {
  const linksList = await db.select().from(utmLinks);
  const allEvents = await selectUtmEvents();

  const eventsByLink = new Map<number, UtmEventRow[]>();
  for (const e of allEvents) {
    const list = eventsByLink.get(e.utmLinkId) || [];
    list.push(e);
    eventsByLink.set(e.utmLinkId, list);
  }

  const linksBySource = new Map<string, typeof linksList>();
  for (const link of linksList) {
    const list = linksBySource.get(link.utmSource) || [];
    list.push(link);
    linksBySource.set(link.utmSource, list);
  }
  const cohortByLink = computeCohortLtv(allEvents);

  const result = [];
  for (const [utmSource, sourceLinks] of linksBySource.entries()) {
    const rows: UtmEventRow[] = [];
    let totalSpend = 0;
    let hasSpend = false;
    let cohortAcquiredUsers = 0;
    let cohortRevenue = 0;
    for (const link of sourceLinks) {
      rows.push(...(eventsByLink.get(link.id) || []));
      if (link.spend !== null && link.spend !== undefined) {
        hasSpend = true;
        totalSpend += link.spend;
      }
      const cohort = cohortByLink.get(link.id);
      if (cohort) {
        cohortAcquiredUsers += cohort.acquiredUsers;
        cohortRevenue += cohort.cohortRevenue;
      }
    }
    const metrics = computeMetrics(rows, hasSpend ? totalSpend : null);
    result.push({
      utmSource,
      linksCount: sourceLinks.length,
      ...metrics,
      cohortAcquiredUsers,
      avgCohortLtv: cohortAcquiredUsers > 0 ? Number((cohortRevenue / cohortAcquiredUsers).toFixed(2)) : null,
    });
  }

  return result;
}

// Bucket a timestamp to its UTC calendar date, mirroring dayKey() in
// src/services/metrics.ts (kept self-contained here rather than importing it,
// since that module belongs to the unrelated campaigns/links/events mechanic).
function dayKey(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

export async function recordUtmHit(
  slug: string,
  tgUserId: string,
  languageCode?: string
): Promise<{ found: false } | { found: true; recorded: boolean }> {
  const link = await getUtmLinkBySlug(slug);
  if (!link) return { found: false };

  // logEvent swallows the duplicate-key case and returns null, which is the
  // right answer for a Telegram retry: the hit is already on record.
  const event = await logEvent({
    utmLinkId: link.id,
    projectId: link.projectId,
    tgUserId,
    eventType: UTM_EVENT_TYPES.START,
    languageCode,
  });

  return { found: true, recorded: event !== null };
}

/**
 * Records a purchase made by a user who arrived through a UTM link — and, just
 * as importantly, one made by a user who did not.
 *
 * The old version returned `{ attributed: false }` and wrote nothing at all
 * when it could find no prior touch, which meant a real payment left no trace
 * anywhere. For a channel-backed project that was a slow leak; for a bot where
 * most arrivals are organic it would have hidden most of the revenue. Now the
 * unattributed case is recorded as organic against the project, and the return
 * value only reports which of the two happened.
 */
export async function recordUtmPurchase(
  tgUserId: string,
  amount: number,
  eventType: "payment" | "renewal",
  context: { projectId?: number; botUsername?: string } = {}
) {
  const event = await logEvent({
    tgUserId,
    eventType,
    amount,
    projectId: context.projectId,
    botUsername: context.botUsername,
  });

  // Nothing inserted means the unique key caught a redelivery of a purchase we
  // already have — not a failure, and not a second sale.
  if (!event) return { attributed: false as const, recorded: false as const };

  return {
    attributed: event.utmLinkId !== null,
    recorded: true as const,
    utmLinkId: event.utmLinkId,
    source: event.source,
  };
}
