/**
 * «Отслежка» — what an admin I bought a place from sees about it.
 *
 * The admin opens my tracking bot through a link (anyone with the link can, by
 * the owner's choice) and gets a card: how many came through my link, how many
 * of them left, how many stayed, and what a subscriber cost. The card refreshes
 * while the post stands; when its term is over the admin gets the final result
 * for exactly the time the post stood. Revenue, purchases and ROI stay mine —
 * none of that is on the card.
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { adBuys, adTrackLinks, adTrackViews, events, links, projects, utmLinks } from "../db/schema.js";
import { AD_FORMAT_HOURS, type AdBuyKind, type AdFormat, type AdSlot } from "../db/adTypes.js";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";
import { AdInputError } from "./adContacts.js";
import { amountOfBuy } from "./adDeals.js";
import { clockIn, dateIn } from "./adPosts.js";
import { buildDeepLink } from "./utm.js";

type Buy = typeof adBuys.$inferSelect;

export interface TrackStats {
  joined: number;
  left: number;
  stayed: number;
  /** distinct people who asked to join (a join-request link) */
  requests: number;
}

/**
 * Who came through the buy's link up to `until`, and who of them has left
 * since — the same counting as the rest of the section: a person counts once,
 * by their first entry; leaving means a leave/churn in the same project after it.
 */
export async function trackStats(buy: Pick<Buy, "projectId" | "campaignId" | "utmLinkId">, until: Date): Promise<TrackStats> {
  const linkIds = buy.campaignId
    ? (await db.select({ id: links.id }).from(links).where(eq(links.campaignId, buy.campaignId))).map((l) => l.id)
    : [];
  const all = [
    ...(linkIds.length ? await db.select().from(events).where(and(inArray(events.linkId, linkIds), lte(events.ts, until))) : []),
    ...(buy.utmLinkId
      ? await db.select().from(events).where(and(eq(events.utmLinkId, buy.utmLinkId), isNull(events.linkId), lte(events.ts, until)))
      : []),
  ];
  const entries = all.filter((e) => (FUNNEL_ENTRY_TYPES as readonly string[]).includes(e.eventType));
  const requests = new Set(all.filter((e) => e.eventType === EVENT_TYPES.JOIN_REQUEST).map((e) => e.tgUserId)).size;

  const first = new Map<string, number>();
  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    const prev = first.get(e.tgUserId);
    if (prev === undefined || t < prev) first.set(e.tgUserId, t);
  }
  if (!first.size) return { joined: 0, left: 0, stayed: 0, requests };

  const exits = await db
    .select({ tgUserId: events.tgUserId, ts: events.ts })
    .from(events)
    .where(
      and(
        eq(events.projectId, buy.projectId),
        inArray(events.tgUserId, [...first.keys()]),
        inArray(events.eventType, [EVENT_TYPES.LEAVE, EVENT_TYPES.CHURN]),
        lte(events.ts, until)
      )
    );
  let left = 0;
  for (const [user, t] of first) {
    if (exits.some((x) => x.tgUserId === user && new Date(x.ts).getTime() >= t)) left++;
  }
  return { joined: first.size, left, stayed: first.size - left, requests };
}

// --- the card --------------------------------------------------------------

const SLOT_LABEL: Record<AdSlot, string> = {
  morning: "Утро",
  day: "День",
  evening: "Вечер",
  night: "Ночь",
  stories: "Сторис",
  n9: "Нейтрал на 9",
  n17: "Нейтрал на 17",
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rub = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString("ru-RU")} ₽`;
const dur = (min: number) => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h >= 48) return `${Math.floor(h / 24)} дн${h % 24 ? ` ${h % 24} ч` : ""}`;
  return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${m} мин`;
};
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export interface CardInput {
  buyId: number;
  project: string;
  /** post | welcome | requests — a welcome / requests buy runs until stopped and is paid per unit */
  kind: AdBuyKind;
  unitPrice: number | null;
  /** the count frozen at the stop (may be corrected by hand) */
  units: number | null;
  stoppedAt: Date | null;
  date: string;
  slot: AdSlot;
  format: AdFormat;
  track: string | null;
  postUrl: string | null;
  priceMode: string;
  amount: number | null; // known cost: fixed price, or a fixed CPM
  cpmRate: number | null;
  publishedAt: Date | null;
  removedAt: Date | null;
  stats: TrackStats;
  now: Date;
  /** The term is over: the card shows the result, frozen. */
  final?: boolean;
}

/**
 * When the watch is over: for a post — removed, or its 24/48 h are up (null —
 * not out yet); for a welcome / requests buy — when it was stopped.
 */
export function termEnd(c: Pick<CardInput, "kind" | "publishedAt" | "removedAt" | "format" | "stoppedAt">): Date | null {
  if (c.kind !== "post") return c.stoppedAt;
  if (!c.publishedAt) return null;
  const full = new Date(c.publishedAt.getTime() + AD_FORMAT_HOURS[c.format] * 3600_000);
  return c.removedAt && c.removedAt < full ? c.removedAt : full;
}

/** What a subscriber cost: the price over those who stayed. */
function perSub(c: CardInput): string {
  if (c.amount == null) return c.priceMode === "cpm" ? "станет известно после фиксации просмотров" : "—";
  return c.stats.stayed ? rub(c.amount / c.stats.stayed) : "—";
}

function priceLine(c: CardInput): string {
  if (c.amount != null) return `💰 Цена: <b>${rub(c.amount)}</b>${c.priceMode === "cpm" && c.cpmRate ? ` (CPM ${rub(c.cpmRate)})` : ""} · подписчик ${perSub(c)}`;
  if (c.priceMode === "cpm") return `💰 CPM ${c.cpmRate ? rub(c.cpmRate) : "—"} за 1000 просмотров — сумма после фиксации`;
  return "💰 Цена: —";
}

const UNIT_KIND: Record<Exclude<AdBuyKind, "post">, { title: string; per: string }> = {
  welcome: { title: "Приветка", per: "подписчика" },
  requests: { title: "Заявки", per: "заявку" },
};

/** What a welcome / requests buy counts — subscribers or requests. */
const countOf = (c: CardInput) => (c.kind === "requests" ? c.stats.requests : c.stats.joined);

function unitPriceLine(c: CardInput): string {
  const per = UNIT_KIND[c.kind as Exclude<AdBuyKind, "post">].per;
  if (c.unitPrice == null) return "💰 Цена: —";
  if (c.stoppedAt && c.amount != null) return `💰 К оплате: <b>${rub(c.amount)}</b> (${c.units} × ${rub(c.unitPrice)})`;
  return `💰 ${rub(c.unitPrice)} за ${per} · сейчас <b>${rub(c.unitPrice * countOf(c))}</b>`;
}

/** The card of a welcome / requests buy: no slot, no post, runs until stopped. */
function renderUnitCard(c: CardInput): string {
  const k = UNIT_KIND[c.kind as Exclude<AdBuyKind, "post">];
  const since = c.publishedAt ?? new Date(`${c.date}T00:00:00Z`);
  const counts =
    c.kind === "requests"
      ? [
          `📨 Заявок: <b>${c.stats.requests}</b>`,
          ...(c.stats.joined ? [`👥 Принято: <b>${c.stats.joined}</b> · 🚪 Ушло: <b>${c.stats.left}</b> · ✅ Осталось: <b>${c.stats.stayed}</b>`] : []),
        ]
      : [`👥 Пришло: <b>${c.stats.joined}</b> · 🚪 Ушло: <b>${c.stats.left}</b> · ✅ Осталось: <b>${c.stats.stayed}</b>`];
  const state = c.stoppedAt
    ? `🏁 Остановлено ${dm(dateIn(c.stoppedAt))} в ${clockIn(c.stoppedAt)}`
    : `⏱ Идёт ${dur(Math.max(0, c.now.getTime() - since.getTime()) / 60000)}`;
  return [
    `📊 <b>Отслежка закупа З-${c.buyId}</b>`,
    `Реклама: <b>${esc(c.project)}</b>`,
    `${k.title} · с ${dm(c.date)}`,
    ...(c.track ? [`Ссылка: ${esc(c.track.replace(/^https:\/\//, ""))}`] : []),
    "",
    ...counts,
    unitPriceLine(c),
    state,
    "",
    c.final
      ? "<i>Итог — на момент остановки, дальше не меняется</i>"
      : `<i>Обновлено ${dm(dateIn(c.now))} в ${clockIn(c.now)} · обновляется само</i>`,
  ].join("\n");
}

/** The live card. */
export function renderCard(c: CardInput): string {
  if (c.kind !== "post") return renderUnitCard(c);
  const end = termEnd(c);
  const hours = AD_FORMAT_HOURS[c.format];
  let stand: string;
  if (!c.publishedAt) stand = "⏳ Пост ещё не вышел";
  else if (end && c.now >= end) {
    const stood = (end.getTime() - c.publishedAt.getTime()) / 60000;
    stand = c.removedAt && c.removedAt <= end && stood < hours * 60 ? `🗑 Пост снят через ${dur(stood)}` : `🏁 Пост отстоял ${hours} ч`;
  } else stand = `⏱ Пост стоит ${dur((c.now.getTime() - c.publishedAt.getTime()) / 60000)} из ${hours} ч`;

  return [
    `📊 <b>Отслежка закупа З-${c.buyId}</b>`,
    `Реклама: <b>${esc(c.project)}</b>`,
    `Место: ${dm(c.date)} · ${SLOT_LABEL[c.slot]} · ${c.format}`,
    ...(c.postUrl ? [`Пост: ${esc(c.postUrl)}`] : []),
    ...(c.track ? [`Ссылка: ${esc(c.track.replace(/^https:\/\//, ""))}`] : []),
    "",
    `👥 Пришло: <b>${c.stats.joined}</b> · 🚪 Ушло: <b>${c.stats.left}</b> · ✅ Осталось: <b>${c.stats.stayed}</b>`,
    priceLine(c),
    stand,
    "",
    c.final
      ? "<i>Итог — на момент окончания срока, дальше не меняется</i>"
      : `<i>Обновлено ${dm(dateIn(c.now))} в ${clockIn(c.now)} · обновляется само</i>`,
  ].join("\n");
}

/** The final result — the counts for exactly the time the post stood (or the buy ran). */
export function renderFinal(c: CardInput): string {
  if (c.kind !== "post") {
    const k = UNIT_KIND[c.kind as Exclude<AdBuyKind, "post">];
    const stop = c.stoppedAt!;
    const since = c.publishedAt ?? new Date(`${c.date}T00:00:00Z`);
    return [
      `🏁 <b>Итог закупа З-${c.buyId}</b> · ${esc(c.project)}`,
      `${k.title} с ${dm(c.date)} по ${dm(dateIn(stop))} · шло ${dur(Math.max(0, stop.getTime() - since.getTime()) / 60000)}`,
      "",
      c.kind === "requests"
        ? `За это время подано заявок: <b>${c.stats.requests}</b>.`
        : `За это время пришло <b>${c.stats.joined}</b>, ушло <b>${c.stats.left}</b>, осталось <b>${c.stats.stayed}</b>.`,
      ...(c.amount != null && c.unitPrice != null
        ? [`К оплате <b>${rub(c.amount)}</b> (${c.units} × ${rub(c.unitPrice)}).`]
        : []),
    ].join("\n");
  }
  const end = termEnd(c)!;
  const stood = (end.getTime() - c.publishedAt!.getTime()) / 60000;
  return [
    `🏁 <b>Итог закупа З-${c.buyId}</b> · ${esc(c.project)}`,
    `${dm(c.date)} · ${SLOT_LABEL[c.slot]} · пост простоял ${dur(stood)}`,
    "",
    `За это время пришло <b>${c.stats.joined}</b>, ушло <b>${c.stats.left}</b>, осталось <b>${c.stats.stayed}</b>.`,
    ...(c.amount != null
      ? [`Подписчик обошёлся в <b>${perSub(c)}</b> (${rub(c.amount)} за ${c.stats.stayed}).`]
      : c.priceMode === "cpm"
        ? ["Цена по CPM станет известна после фиксации просмотров."]
        : []),
  ].join("\n");
}

// --- links and data ----------------------------------------------------------

/** The tracking link of a buy, made on first request. */
export async function getOrCreateTrack(buyId: number) {
  const buy = await db.query.adBuys.findFirst({ where: eq(adBuys.id, buyId) });
  if (!buy) throw new AdInputError("Закуп не найден", 404);
  const existing = await db.query.adTrackLinks.findFirst({ where: eq(adTrackLinks.buyId, buyId) });
  if (existing) return existing;
  return db
    .insert(adTrackLinks)
    .values({ buyId, token: randomBytes(12).toString("base64url") })
    .returning()
    .get();
}

export async function trackViewsCount(trackId: number) {
  return (await db.select({ id: adTrackViews.id }).from(adTrackViews).where(eq(adTrackViews.trackId, trackId))).length;
}

/** Everything the card needs for one buy, counted as of `now` (or as of the term's end for the final). */
export async function cardInput(buyId: number, now: Date, final = false): Promise<CardInput | null> {
  const buy = await db.query.adBuys.findFirst({ where: eq(adBuys.id, buyId) });
  if (!buy) return null;
  const project = await db.query.projects.findFirst({ where: eq(projects.id, buy.projectId) });
  let track: string | null = null;
  if (buy.campaignId) {
    const [l] = await db.select().from(links).where(eq(links.campaignId, buy.campaignId)).orderBy(links.id).limit(1);
    track = l?.telegramRef ?? null;
  } else if (buy.utmLinkId) {
    const u = await db.query.utmLinks.findFirst({ where: eq(utmLinks.id, buy.utmLinkId) });
    track = u ? buildDeepLink(u) : null;
  }
  const base = {
    buyId: buy.id,
    project: project?.name ?? "—",
    kind: buy.kind as AdBuyKind,
    unitPrice: buy.unitPrice,
    units: buy.units,
    stoppedAt: buy.stoppedAt,
    date: buy.date,
    slot: buy.slot as AdSlot,
    format: buy.format as AdFormat,
    track,
    postUrl: buy.postUrl,
    priceMode: buy.priceMode,
    amount: amountOfBuy(buy),
    cpmRate: buy.cpmRate,
    publishedAt: buy.publishedAt,
    removedAt: buy.removedAt,
    now,
  };
  const end = termEnd(base);
  const until = final && end ? end : now;
  return { ...base, stats: await trackStats(buy, until) };
}
