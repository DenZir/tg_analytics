import { db } from "../db/index.js";
import { links, events } from "../db/schema.js";
import { eq, inArray, desc } from "drizzle-orm";

// Approximate "geo" proxy built from Telegram's `language_code` field (the one
// locale-ish signal the Bot API exposes on almost every User object). This is
// explicitly NOT real geolocation/IP — see project notes for why that's out of
// scope. Keep this mapping small and maintainable; unmapped/missing codes fall
// back to "Другое/неизвестно".
export const LANGUAGE_GEO_MAP: Record<string, { label: string; flag: string }> = {
  ru: { label: "Русский", flag: "🇷🇺" },
  uk: { label: "Украинский", flag: "🇺🇦" },
  be: { label: "Белорусский", flag: "🇧🇾" },
  kk: { label: "Казахский", flag: "🇰🇿" },
  uz: { label: "Узбекский", flag: "🇺🇿" },
  ky: { label: "Киргизский", flag: "🇰🇬" },
  tg: { label: "Таджикский", flag: "🇹🇯" },
  az: { label: "Азербайджанский", flag: "🇦🇿" },
  hy: { label: "Армянский", flag: "🇦🇲" },
  ka: { label: "Грузинский", flag: "🇬🇪" },
  en: { label: "Английский", flag: "🇬🇧" },
  de: { label: "Немецкий", flag: "🇩🇪" },
  es: { label: "Испанский", flag: "🇪🇸" },
};

const UNKNOWN_GEO = { label: "Другое/неизвестно", flag: "🌐" };

export function resolveGeoLabel(
  languageCode: string | null | undefined
): { label: string; flag: string } {
  if (!languageCode) return UNKNOWN_GEO;

  const primarySubtag = languageCode.split("-")[0].toLowerCase();
  return LANGUAGE_GEO_MAP[primarySubtag] ?? UNKNOWN_GEO;
}

export async function getCampaignGeoBreakdown(
  campaignId: number
): Promise<Array<{ flag: string; label: string; count: number; pct: number }>> {
  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, campaignId));

  const linkIds = campaignLinks.map((l) => l.id);
  if (linkIds.length === 0) return [];

  const campaignEvents = await db
    .select()
    .from(events)
    .where(inArray(events.linkId, linkIds))
    .orderBy(desc(events.ts));

  if (campaignEvents.length === 0) return [];

  // One row per distinct tgUserId: their most recent event carrying a
  // non-null languageCode, or "unknown" if none of their events have one.
  // campaignEvents is already ordered by ts DESC, so the first match per
  // user encountered while scanning is their most recent one.
  const languageByUser = new Map<string, string | null>();
  for (const e of campaignEvents) {
    if (!languageByUser.has(e.tgUserId)) {
      languageByUser.set(e.tgUserId, null);
    }
    if (e.languageCode && languageByUser.get(e.tgUserId) === null) {
      languageByUser.set(e.tgUserId, e.languageCode);
    }
  }

  const bucketCounts = new Map<string, { flag: string; label: string; count: number }>();
  for (const languageCode of languageByUser.values()) {
    const geo = resolveGeoLabel(languageCode);
    const key = `${geo.flag}:${geo.label}`;
    const existing = bucketCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      bucketCounts.set(key, { flag: geo.flag, label: geo.label, count: 1 });
    }
  }

  const totalUsers = languageByUser.size;
  const breakdown = Array.from(bucketCounts.values()).map((bucket) => ({
    ...bucket,
    pct: totalUsers > 0 ? Math.round((bucket.count / totalUsers) * 100) : 0,
  }));

  breakdown.sort((a, b) => b.count - a.count);

  return breakdown;
}
