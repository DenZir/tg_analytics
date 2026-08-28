import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { utmLinks, utmEvents } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";

// Local to this mechanic - do not import the unrelated EVENT_TYPES from src/db/eventTypes.ts,
// that enum belongs to the campaigns/links/events attribution model.
const UTM_EVENT_TYPES = { START: "start", PAYMENT: "payment", RENEWAL: "renewal" } as const;

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

type UtmEventRow = typeof utmEvents.$inferSelect;

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

export async function listUtmLinksWithMetrics() {
  const linksList = await db.select().from(utmLinks);
  const allEvents = await db.select().from(utmEvents);

  const eventsByLink = new Map<number, UtmEventRow[]>();
  for (const e of allEvents) {
    const list = eventsByLink.get(e.utmLinkId) || [];
    list.push(e);
    eventsByLink.set(e.utmLinkId, list);
  }

  return linksList.map((link) => {
    const rows = eventsByLink.get(link.id) || [];
    return {
      ...link,
      deepLink: buildDeepLink(link),
      ...computeMetrics(rows, link.spend ?? null),
    };
  });
}

export async function getUtmLinkDetail(id: number) {
  const link = await getUtmLinkById(id);
  if (!link) return null;

  const rows = await db
    .select()
    .from(utmEvents)
    .where(eq(utmEvents.utmLinkId, id));

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
  const allEvents = await db.select().from(utmEvents);

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

  const result = [];
  for (const [utmSource, sourceLinks] of linksBySource.entries()) {
    const rows: UtmEventRow[] = [];
    let totalSpend = 0;
    let hasSpend = false;
    for (const link of sourceLinks) {
      rows.push(...(eventsByLink.get(link.id) || []));
      if (link.spend !== null && link.spend !== undefined) {
        hasSpend = true;
        totalSpend += link.spend;
      }
    }
    const metrics = computeMetrics(rows, hasSpend ? totalSpend : null);
    result.push({
      utmSource,
      linksCount: sourceLinks.length,
      ...metrics,
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
): Promise<{ found: false } | { found: true; event: UtmEventRow | null }> {
  const link = await getUtmLinkBySlug(slug);
  if (!link) return { found: false };

  try {
    const [inserted] = await db
      .insert(utmEvents)
      .values({
        utmLinkId: link.id,
        tgUserId,
        eventType: UTM_EVENT_TYPES.START,
        amount: 0,
        languageCode: languageCode ?? null,
      })
      .returning();
    return { found: true, event: inserted };
  } catch (error: any) {
    // Unique constraint violation indicates duplicate delivery (e.g. Telegram retry) on an
    // otherwise valid slug -> treat as an idempotent success, not an unknown-slug failure.
    if (
      error?.code === "SQLITE_CONSTRAINT" ||
      error?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error?.message?.includes("UNIQUE constraint failed")
    ) {
      return { found: true, event: null };
    }
    throw error;
  }
}

export async function recordUtmPurchase(
  tgUserId: string,
  amount: number,
  eventType: "payment" | "renewal"
) {
  return db.transaction((tx) => {
    const lastStart = tx
      .select()
      .from(utmEvents)
      .where(and(eq(utmEvents.tgUserId, tgUserId), eq(utmEvents.eventType, UTM_EVENT_TYPES.START)))
      .orderBy(desc(utmEvents.ts), desc(utmEvents.id))
      .limit(1)
      .all();

    if (lastStart.length === 0) {
      return { attributed: false as const };
    }

    const utmLinkId = lastStart[0].utmLinkId;

    tx.insert(utmEvents)
      .values({
        utmLinkId,
        tgUserId,
        eventType,
        amount,
      })
      .run();

    return { attributed: true as const, utmLinkId };
  });
}
