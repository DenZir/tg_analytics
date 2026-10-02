/**
 * Reports from posting about posts marked «Реклама» in my own channels.
 *
 * posting publishes those posts, so it knows the channel, the message number
 * and the exact moment — the sale does not need its post link pasted. Each
 * report is matched to a sale place: same channel, same day, the slot whose
 * start is closest to the publication. From then on the post checker treats it
 * like any other ad post.
 *
 * A report that matches nothing is kept: the sale may be entered after the post
 * is out, and jobs/adChecks.ts retries the match on every pass.
 */
import { and, eq, gte, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { adPostReports, adSalePlaces, adSales, adStatusHistory, projects } from "../db/schema.js";
import { AD_FORMAT_HOURS, type AdFormat, type AdSlot } from "../db/adTypes.js";
import { AdInputError } from "./adContacts.js";
import { applyObservation, dateIn, slotStart } from "./adPosts.js";

/** How far from a slot's start a post may come out and still be that slot's. */
const WINDOW_MIN: Record<AdSlot, number> = {
  morning: 180,
  day: 180,
  evening: 180,
  night: 180,
  stories: 180,
  n9: 45,
  n17: 45,
};
const EXACT: AdSlot[] = ["n9", "n17"];

export interface Candidate {
  placeId: number;
  saleId: number;
  date: string;
  slot: AdSlot;
  format: AdFormat;
}

/**
 * Which sale place a published post belongs to — or none. Closest slot start
 * wins; between equals, the one whose format matches posting's removal timer.
 */
export function pickPlace(cands: Candidate[], publishedAt: Date, deleteAt: Date | null, tz?: string): Candidate | null {
  const termH = deleteAt ? (deleteAt.getTime() - publishedAt.getTime()) / 3600_000 : null;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of cands) {
    const diff = Math.abs(publishedAt.getTime() - slotStart(c.date, c.slot, tz).getTime()) / 60000;
    if (diff > WINDOW_MIN[c.slot]) continue;
    // an exact slot beats a part of the day at the same distance: "17:00" is a promise
    let score = diff - (EXACT.includes(c.slot) ? 1 : 0);
    if (termH != null && Math.abs(termH - AD_FORMAT_HOURS[c.format]) <= 2) score -= 0.5;
    if (!best || score < best.score) best = { c, score };
  }
  return best?.c ?? null;
}

const privateLink = (chat: string, messageId: number) => `https://t.me/c/${chat.replace(/^-100/, "")}/${messageId}`;

function parseReport(body: Record<string, unknown>) {
  const event = body.event;
  if (event !== "published" && event !== "removed") throw new AdInputError("event — published или removed");
  const chat = String(body.chatId ?? "").trim();
  if (!/^-100\d{5,20}$/.test(chat)) throw new AdInputError("chatId — id канала вида -100…");
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new AdInputError("messageId — номер сообщения");
  const at = new Date(String(body.at ?? ""));
  if (Number.isNaN(at.getTime())) throw new AdInputError("at — момент в ISO 8601");
  let deleteAt: Date | null = null;
  if (body.deleteAt != null && body.deleteAt !== "") {
    deleteAt = new Date(String(body.deleteAt));
    if (Number.isNaN(deleteAt.getTime())) throw new AdInputError("deleteAt — момент в ISO 8601");
  }
  return { event, chat, messageId, at, deleteAt };
}

/** Binds a report to a sale place if one fits. Returns the place id, or null. */
export async function matchReport(reportId: number): Promise<number | null> {
  const r = await db.query.adPostReports.findFirst({ where: eq(adPostReports.id, reportId) });
  if (!r) return null;
  if (r.placeId) return r.placeId;
  const project = await db.query.projects.findFirst({ where: eq(projects.telegramChatId, r.chat) });
  if (!project) return null;

  const day = dateIn(r.publishedAt);
  const rows = await db
    .select({ place: adSalePlaces, sale: adSales })
    .from(adSalePlaces)
    .innerJoin(adSales, eq(adSales.id, adSalePlaces.saleId))
    .where(
      and(
        eq(adSalePlaces.projectId, project.id),
        eq(adSales.date, day),
        ne(adSales.status, "cancel"),
        // a place that already has its post is taken — unless it is this very post
        or(isNull(adSalePlaces.postChat), and(eq(adSalePlaces.postChat, r.chat), eq(adSalePlaces.postMessageId, r.messageId)))
      )
    );
  const taken = new Set(
    (await db.select({ placeId: adPostReports.placeId }).from(adPostReports)).map((x) => x.placeId).filter(Boolean)
  );
  const pick = pickPlace(
    rows
      .filter((x) => !taken.has(x.place.id))
      .map((x) => ({ placeId: x.place.id, saleId: x.sale.id, date: x.sale.date, slot: x.sale.slot as AdSlot, format: x.sale.format as AdFormat })),
    r.publishedAt,
    r.deleteAt
  );
  if (!pick) return null;

  const sale = rows.find((x) => x.sale.id === pick.saleId)!.sale;
  db.transaction((tx) => {
    tx.update(adPostReports).set({ placeId: pick.placeId }).where(eq(adPostReports.id, r.id)).run();
    tx.update(adSalePlaces)
      .set({
        postUrl: privateLink(r.chat, r.messageId),
        postChat: r.chat,
        postMessageId: r.messageId,
        publishedAt: r.publishedAt,
        ...(r.removedAt ? { removedAt: r.removedAt } : {}),
      })
      .where(eq(adSalePlaces.id, pick.placeId))
      .run();
    if (sale.status === "plan" || sale.status === "agreed") {
      tx.update(adSales).set({ status: "live", updatedAt: new Date() }).where(eq(adSales.id, sale.id)).run();
      tx.insert(adStatusHistory).values({ kind: "sale", dealId: sale.id, status: "live", at: r.publishedAt }).run();
    }
  });
  if (r.removedAt) settleSale(sale.id, new Date());
  return pick.placeId;
}

/** A package is done once every channel's post has been removed or served its term. */
export function settleSale(saleId: number, now: Date) {
  const sale = db.select().from(adSales).where(eq(adSales.id, saleId)).get();
  if (!sale || sale.status === "cancel" || sale.status === "done") return;
  const places = db.select().from(adSalePlaces).where(eq(adSalePlaces.saleId, saleId)).all();
  const hours = AD_FORMAT_HOURS[sale.format as AdFormat];
  const over = (p: (typeof places)[number]) =>
    !!p.removedAt || (!!p.publishedAt && now.getTime() >= p.publishedAt.getTime() + hours * 3600_000);
  const anyOut = places.some((p) => p.publishedAt);
  const next = places.length && places.every(over) ? "done" : anyOut ? "live" : sale.status;
  if (next === sale.status) return;
  db.transaction((tx) => {
    tx.update(adSales).set({ status: next, updatedAt: now }).where(eq(adSales.id, saleId)).run();
    tx.insert(adStatusHistory).values({ kind: "sale", dealId: saleId, status: next, at: now }).run();
  });
}

/** POST /api/ads/posts — one report from posting. Idempotent: posting may resend. */
export async function recordReport(body: Record<string, unknown>) {
  const r = parseReport(body);
  const existing = await db.query.adPostReports.findFirst({
    where: and(eq(adPostReports.chat, r.chat), eq(adPostReports.messageId, r.messageId)),
  });

  if (r.event === "published") {
    const row = existing
      ? db.update(adPostReports).set({ publishedAt: r.at, deleteAt: r.deleteAt }).where(eq(adPostReports.id, existing.id)).returning().get()
      : db.insert(adPostReports).values({ chat: r.chat, messageId: r.messageId, publishedAt: r.at, deleteAt: r.deleteAt }).returning().get();
    const placeId = await matchReport(row.id);
    return { report: row.id, matched: placeId != null, placeId };
  }

  // removed — of a post we may never have heard published (posting resends both)
  const row =
    existing ??
    db.insert(adPostReports).values({ chat: r.chat, messageId: r.messageId, publishedAt: r.at, removedAt: r.at }).returning().get();
  if (existing && !existing.removedAt) db.update(adPostReports).set({ removedAt: r.at }).where(eq(adPostReports.id, existing.id)).run();
  // A removal alone says nothing about which slot the post was for: it is
  // matched only through its publication report.
  const placeId = existing?.placeId ?? null;
  if (placeId) {
    const p = db.select({ place: adSalePlaces, sale: adSales }).from(adSalePlaces).innerJoin(adSales, eq(adSales.id, adSalePlaces.saleId)).where(eq(adSalePlaces.id, placeId)).get();
    if (p && !p.place.removedAt) {
      // Seen by the checker: the usual rules (CPM still waiting → last measurement).
      // Not seen: at least the moment it went is known.
      const patch = p.place.viewsAt
        ? applyObservation({ ...p.place, status: p.sale.status, format: p.sale.format as AdFormat, priceMode: p.sale.priceMode }, { present: false }, r.at).patch
        : { removedAt: r.at };
      db.update(adSalePlaces).set(patch).where(eq(adSalePlaces.id, placeId)).run();
    }
    if (p) settleSale(p.sale.id, new Date());
  }
  return { report: row.id, matched: placeId != null, placeId };
}

/** Reports from the last days still without a place — the checker retries them. */
export async function matchPendingReports(now = new Date()) {
  const since = new Date(now.getTime() - 3 * 86400_000);
  const rows = await db
    .select({ id: adPostReports.id })
    .from(adPostReports)
    .where(and(isNull(adPostReports.placeId), gte(adPostReports.publishedAt, since)));
  let matched = 0;
  for (const r of rows) if (await matchReport(r.id)) matched++;
  return matched;
}
