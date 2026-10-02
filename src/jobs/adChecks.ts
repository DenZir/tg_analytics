/**
 * Ad post checker: every 5 minutes, looks at the ad posts the section knows of
 * and records what it saw.
 *
 * For a buy the post is in someone else's channel — its link is pasted into the
 * buy's card. For a sale it is in one of mine — posting reports it (see
 * POST /api/ads/posts). Either way the check is the same: is the post there,
 * when did it come out, how many views, when did the channel post next. The
 * rules that turn that into statuses, CPM amounts and warnings live in
 * services/adPosts.ts; this file only fetches, writes and notifies.
 *
 * Without an account session (`npm run tg:login`) the checker stays off and
 * says so on the dashboard; nothing else depends on it.
 */
import cron from "node-cron";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { adBuys, adPostSnapshots, adSalePlaces, adSales, adStatusHistory, projects } from "../db/schema.js";
import type { AdFormat, AdSlot } from "../db/adTypes.js";
import { accountConfig, clientReader, createClient, hasLogin, type PostReader } from "../telegram/account.js";
import { applyObservation, dateIn, deriveChecks, needsCheck, type Observation, type Warn } from "../services/adPosts.js";
import { resultsFor, syncTracking } from "../services/adDeals.js";
import { contactLabel, getContact } from "../services/adContacts.js";
import { notifyAdmins, warnLine } from "../services/adNotify.js";
import { matchPendingReports, settleSale } from "../services/adPostReports.js";

const PAUSE_MS = 400; // between looks — a few dozen posts are not worth a flood wait

// --- the reader ------------------------------------------------------------

let reader: PostReader | null = null;
let status: { enabled: boolean; reason: string | null; lastRun: Date | null; lastError: string | null } = {
  enabled: false,
  reason: "ещё не запускалась",
  lastRun: null,
  lastError: null,
};

/** For the dashboard: is the checker on, and if not — why. */
export function checkerStatus() {
  return { ...status };
}

async function getReader(): Promise<PostReader | null> {
  if (reader) return reader;
  const conf = accountConfig();
  if (!conf.ok) {
    status = { ...status, enabled: false, reason: conf.reason };
    return null;
  }
  if (!hasLogin(conf.cfg.storage)) {
    status = { ...status, enabled: false, reason: "нет входа в Telegram — выполните npm run tg:login" };
    return null;
  }
  const client = createClient(conf.cfg);
  // A dead proxy makes mtcute hang rather than fail: give it a deadline.
  let me;
  try {
    me = await Promise.race([
      client.getMe(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Telegram не ответил за 60 с")), 60_000)),
    ]);
  } catch (error) {
    // the next tick starts over with a fresh client, so this one must not linger
    await client.destroy().catch(() => {});
    throw error;
  }
  console.log(`[adChecks] Account session ready: ${me.displayName} (${me.id})`);
  reader = clientReader(client);
  status = { ...status, enabled: true, reason: null };
  return reader;
}

// --- one pass --------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseAlerted = (s: string | null): string[] => {
  try {
    const a = JSON.parse(s || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

async function look(r: PostReader, chat: string, messageId: number): Promise<Observation | { error: string }> {
  try {
    return await r.look(chat, messageId);
  } catch (error: any) {
    const msg = String(error?.message ?? error).slice(0, 200);
    console.warn(`[adChecks] Could not look at ${chat}/${messageId}: ${msg}`);
    return { error: msg };
  }
}

/** Warnings that are new since the last notification; remembers them as sent. */
function freshWarns(warns: Warn[], alerted: string | null): { fresh: Warn[]; alerted: string } {
  const seen = new Set(parseAlerted(alerted));
  const fresh = warns.filter((w) => !seen.has(w.code));
  for (const w of fresh) seen.add(w.code);
  return { fresh, alerted: JSON.stringify([...seen]) };
}

/** Old deals stay quiet: switching the checker on must not flood the chat with history. */
const recent = (date: string, now: Date) => date >= dateIn(new Date(now.getTime() - 3 * 86400_000));

export async function checkBuys(r: PostReader, now = new Date()) {
  const rows = await db
    .select()
    .from(adBuys)
    .where(and(isNotNull(adBuys.postChat), isNotNull(adBuys.postMessageId), ne(adBuys.status, "cancel")));
  let checked = 0;
  for (const b of rows) {
    if (!needsCheck({ ...b, slot: b.slot as AdSlot, format: b.format as AdFormat }, now)) continue;
    const obs = await look(r, b.postChat!, b.postMessageId!);
    checked++;
    if ("error" in obs) {
      db.update(adBuys).set({ checkedAt: now, checkError: obs.error }).where(eq(adBuys.id, b.id)).run();
    } else {
      const res = applyObservation({ ...b, format: b.format as AdFormat }, obs, now);
      db.transaction((tx) => {
        tx.update(adBuys)
          .set({ ...res.patch, ...(res.status ? { status: res.status } : {}), updatedAt: now })
          .where(eq(adBuys.id, b.id))
          .run();
        tx.insert(adPostSnapshots).values({ target: "buy", targetId: b.id, at: now, present: obs.present, views: obs.views ?? null }).run();
        if (res.status && res.status !== b.status) tx.insert(adStatusHistory).values({ kind: "buy", dealId: b.id, status: res.status, at: now }).run();
      });
      if (res.patch.cpmState) {
        const fresh = await db.query.adBuys.findFirst({ where: eq(adBuys.id, b.id) });
        const contact = await getContact(b.contactId);
        if (fresh && contact) await syncTracking(fresh, contactLabel(contact));
      }
    }
    await sleep(PAUSE_MS);
  }
  return checked;
}

export async function checkPlaces(r: PostReader, now = new Date()) {
  const rows = await db
    .select({ place: adSalePlaces, sale: adSales })
    .from(adSalePlaces)
    .innerJoin(adSales, eq(adSales.id, adSalePlaces.saleId))
    .where(and(isNotNull(adSalePlaces.postChat), isNotNull(adSalePlaces.postMessageId), ne(adSales.status, "cancel")));
  let checked = 0;
  const touched = new Set<number>();
  for (const { place: p, sale: s } of rows) {
    const f = { ...p, status: s.status, format: s.format as AdFormat, priceMode: s.priceMode };
    if (!needsCheck({ ...f, date: s.date, slot: s.slot as AdSlot }, now)) continue;
    const obs = await look(r, p.postChat!, p.postMessageId!);
    checked++;
    if ("error" in obs) {
      db.update(adSalePlaces).set({ checkedAt: now, checkError: obs.error }).where(eq(adSalePlaces.id, p.id)).run();
    } else {
      // The sale's status moves for the whole package below, not per channel.
      const { patch } = applyObservation(f, obs, now);
      db.transaction((tx) => {
        tx.update(adSalePlaces).set(patch).where(eq(adSalePlaces.id, p.id)).run();
        tx.insert(adPostSnapshots).values({ target: "place", targetId: p.id, at: now, present: obs.present, views: obs.views ?? null }).run();
      });
      touched.add(s.id);
    }
    await sleep(PAUSE_MS);
  }
  for (const saleId of touched) settleSale(saleId, now);
  return checked;
}

/** Sends each new warning once. */
export async function notifyFresh(now = new Date()) {
  const buys = await db.select().from(adBuys).where(and(isNotNull(adBuys.postChat), ne(adBuys.status, "cancel")));
  const live = buys.filter((b) => recent(b.date, now));
  const results = await resultsFor(live);
  for (const b of live) {
    const subs = b.campaignId || b.utmLinkId ? (results.get(b.id)?.subs ?? null) : null;
    const { warns } = deriveChecks({ ...b, slot: b.slot as AdSlot, format: b.format as AdFormat }, now, subs);
    const { fresh, alerted } = freshWarns(warns, b.alerted);
    if (!fresh.length) continue;
    const contact = await getContact(b.contactId);
    const project = await db.query.projects.findFirst({ where: eq(projects.id, b.projectId) });
    const sent = await notifyAdmins(
      `⚠️ <b>Закуп З-${b.id}</b> · ${contact ? contactLabel(contact) : "—"} · ${project?.name ?? ""}`,
      b.date,
      b.slot as AdSlot,
      fresh.map(warnLine),
      `З-${b.id}`
    );
    if (sent) db.update(adBuys).set({ alerted }).where(eq(adBuys.id, b.id)).run();
  }

  const rows = await db
    .select({ place: adSalePlaces, sale: adSales })
    .from(adSalePlaces)
    .innerJoin(adSales, eq(adSales.id, adSalePlaces.saleId))
    .where(and(isNotNull(adSalePlaces.postChat), ne(adSales.status, "cancel")));
  const projectIds = [...new Set(rows.map((r) => r.place.projectId))];
  const names = new Map(
    (projectIds.length ? await db.select().from(projects).where(inArray(projects.id, projectIds)) : []).map((p) => [p.id, p.name])
  );
  for (const { place: p, sale: s } of rows) {
    if (!recent(s.date, now)) continue;
    const { warns } = deriveChecks(
      { ...p, date: s.date, slot: s.slot as AdSlot, format: s.format as AdFormat, status: s.status, priceMode: s.priceMode },
      now,
      null
    );
    const { fresh, alerted } = freshWarns(warns, p.alerted);
    if (!fresh.length) continue;
    const contact = await getContact(s.contactId);
    const sent = await notifyAdmins(
      `⚠️ <b>Продажа П-${s.id}</b> · ${names.get(p.projectId) ?? ""} · покупатель ${contact ? contactLabel(contact) : "—"}`,
      s.date,
      s.slot as AdSlot,
      fresh.map(warnLine),
      `П-${s.id}`
    );
    if (sent) db.update(adSalePlaces).set({ alerted }).where(eq(adSalePlaces.id, p.id)).run();
  }
}

let running = false;
export async function runAdChecks() {
  if (running) return; // a slow pass must not overlap the next tick
  running = true;
  try {
    // posting's reports need no Telegram: match them even with the checker off
    const late = await matchPendingReports();
    if (late) console.log(`[adChecks] Matched ${late} posting report(s) to sales`);
    const r = await getReader();
    if (!r) return;
    const now = new Date();
    const n = (await checkBuys(r, now)) + (await checkPlaces(r, now));
    await notifyFresh(new Date());
    status = { ...status, lastRun: now, lastError: null };
    if (n) console.log(`[adChecks] Checked ${n} ad post(s)`);
  } catch (error: any) {
    console.error("[adChecks] Pass failed:", error);
    status = { ...status, lastError: String(error?.message ?? error).slice(0, 200) };
    // a broken client is rebuilt on the next tick rather than kept half-alive
    reader = null;
  } finally {
    running = false;
  }
}

cron.schedule("*/5 * * * *", () => {
  runAdChecks();
});
