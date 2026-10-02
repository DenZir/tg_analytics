/**
 * Ad posts: where a post is, what a check of it means, and what is wrong with it.
 *
 * Everything here is pure — no database, no Telegram — so the rules that decide
 * money (CPM fixation) and accusations (an admin deleted a post early) can be
 * tested on their own. jobs/adChecks.ts feeds it observations; adDeals.ts uses
 * deriveChecks() to show the result.
 */
import { AD_FORMAT_HOURS, AD_SLOT_TIME, type AdFormat, type AdSlot } from "../db/adTypes.js";

/** Slots that are an exact time rather than a part of the day — lateness only counts there. */
const EXACT_SLOTS: AdSlot[] = ["n9", "n17"];
/** How late a post on an exact slot may come out before it is "late". */
export const LATE_TOLERANCE_MIN = 10;
/** A post must hold the top of the channel this long. */
export const TOP_MINUTES = 60;
/** Slack for "deleted early": the poster's own timer is rarely to the minute. */
export const EARLY_TOLERANCE_MIN = 15;
/** CPM views are fixed this many minutes before the post's term runs out. */
export const CPM_FIX_LEAD_MIN = 10;
/** A post that has been out this long and brought nobody is worth a word. */
export const NO_CLICKS_AFTER_MIN = 180;
/** A post that has not appeared this long after its slot is "not out". */
export const NOT_OUT_AFTER_MIN = 60;

export const AD_TIMEZONE = process.env.ADS_TIMEZONE || "Europe/Moscow";

// --- post links ------------------------------------------------------------

export interface PostRef {
  /** A channel username, or a marked id ("-100…") for a private channel. */
  chat: string;
  messageId: number;
  /** The same link, normalized — what gets stored as post_url. */
  url: string;
}

/**
 * Reads a link to a channel post: t.me/name/123, t.me/s/name/123,
 * t.me/c/1234567890/123 (a private channel), with or without ?single and the
 * like. A topic link (t.me/c/123/45/67) points at its last number.
 */
export function parsePostLink(raw: string): PostRef | null {
  const s = String(raw ?? "").trim();
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(.+?)\/?(?:[?#].*)?$/i.exec(s);
  if (!m) return null;
  const parts = m[1].split("/").filter(Boolean);
  if (parts[0] === "s") parts.shift();
  if (parts[0] === "c") {
    if (parts.length < 3 || !/^\d{5,20}$/.test(parts[1])) return null;
    const msg = Number(parts[parts.length - 1]);
    if (!Number.isInteger(msg) || msg <= 0) return null;
    return { chat: `-100${parts[1]}`, messageId: msg, url: `https://t.me/c/${parts[1]}/${msg}` };
  }
  if (parts.length < 2 || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(parts[0])) return null;
  const msg = Number(parts[parts.length - 1]);
  if (!Number.isInteger(msg) || msg <= 0) return null;
  return { chat: parts[0], messageId: msg, url: `https://t.me/${parts[0]}/${msg}` };
}

// --- time ------------------------------------------------------------------

/** Minutes the zone is ahead of UTC at a given moment. */
function zoneOffsetMin(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - at) / 60000);
}

/** The moment a slot starts: "2026-10-08" + "19:00" in the channel's time zone. */
export function slotStart(date: string, slot: AdSlot, tz = AD_TIMEZONE): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = AD_SLOT_TIME[slot].split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // two passes: the first offset may belong to the other side of a DST switch
  let at = naive - zoneOffsetMin(naive, tz) * 60000;
  at = naive - zoneOffsetMin(at, tz) * 60000;
  return new Date(at);
}

/** "19:04" in the channel's time zone. */
export function clockIn(at: Date, tz = AD_TIMEZONE): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** "2026-10-08" in the channel's time zone. */
export function dateIn(at: Date, tz = AD_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const minutes = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60000);

// --- what a post's checks say ----------------------------------------------

/** The fields of a buy or a sale place that the checks read. */
export interface CheckedPost {
  date: string;
  slot: AdSlot;
  format: AdFormat;
  status: string;
  priceMode: string;
  cpmState: string | null;
  postChat: string | null;
  publishedAt: Date | null;
  removedAt: Date | null;
  nextPostAt: Date | null;
  viewsSeen: number | null;
  viewsAt: Date | null;
  checkError: string | null;
}

export type WarnCode = "early" | "top" | "late" | "cpmfail" | "noclicks" | "notout" | "nolook" | "nopost";
export interface Warn {
  code: WarnCode;
  sev: "high" | "mid";
  /** Numbers the text needs ("не хватило 40 мин") — the dashboard words them. */
  data?: Record<string, number | string>;
}

export interface Checks {
  reach: { views: number; at: string } | null;
  time: { plan: string; fact: string; late: boolean; lateMin: number } | null;
  top: { wait: true } | { ok: true } | { ok: false; short: number } | null;
  life:
    | { wait: true; elapsed: number; hours: number }
    | { ok: true; hours: number }
    | { ok: false; lived: number; short: number }
    | null;
}

/**
 * Turns what the checker saw into the card's "Автоматические проверки" and the
 * warnings. `subs` is the number of people the buy's link brought (null when
 * the buy has no tracking link — then "no clicks" is not ours to claim).
 */
export function deriveChecks(p: CheckedPost, now: Date, subs: number | null, tz = AD_TIMEZONE): { checks: Checks | null; warns: Warn[] } {
  const warns: Warn[] = [];
  if (p.status === "cancel") return { checks: null, warns };
  if (p.cpmState === "failed") warns.push({ code: "cpmfail", sev: "high" });
  const start = slotStart(p.date, p.slot, tz);
  if (!p.postChat) {
    // A booked place has no post yet, and that is fine — until the post should
    // have come out: then without its link the checker cannot see it at all.
    if ((p.status === "agreed" || p.status === "live") && minutes(now, start) >= NOT_OUT_AFTER_MIN) {
      warns.push({ code: "nopost", sev: "mid" });
    }
    return { checks: null, warns };
  }

  if (p.checkError) warns.push({ code: "nolook", sev: "mid", data: { reason: p.checkError } });
  const pub = p.viewsAt ? p.publishedAt : null; // only a post the checker has actually seen
  if (!pub) {
    if (!p.checkError && minutes(now, start) >= NOT_OUT_AFTER_MIN && (p.status === "agreed" || p.status === "plan")) {
      warns.push({ code: "notout", sev: "mid", data: { after: minutes(now, start) } });
    }
    return { checks: null, warns };
  }

  const hours = AD_FORMAT_HOURS[p.format];
  const lateMin = minutes(pub, start);
  const late = EXACT_SLOTS.includes(p.slot) && lateMin > LATE_TOLERANCE_MIN;
  if (late) warns.push({ code: "late", sev: "mid", data: { fact: clockIn(pub, tz), plan: AD_SLOT_TIME[p.slot] } });

  let top: Checks["top"];
  if (p.nextPostAt && minutes(p.nextPostAt, pub) < TOP_MINUTES) {
    top = { ok: false, short: TOP_MINUTES - Math.max(0, minutes(p.nextPostAt, pub)) };
    warns.push({ code: "top", sev: "high", data: { short: top.short } });
  } else if (!p.nextPostAt && minutes(now, pub) < TOP_MINUTES && !p.removedAt) top = { wait: true };
  else top = { ok: true };

  let life: Checks["life"];
  if (p.removedAt) {
    const lived = Math.max(0, minutes(p.removedAt, pub));
    if (lived < hours * 60 - EARLY_TOLERANCE_MIN) {
      life = { ok: false, lived, short: hours * 60 - lived };
      warns.push({ code: "early", sev: "high", data: { lived, short: life.short } });
    } else life = { ok: true, hours };
  } else if (minutes(now, pub) < hours * 60) life = { wait: true, elapsed: minutes(now, pub), hours };
  else life = { ok: true, hours };

  if (subs === 0 && minutes(now, pub) >= NO_CLICKS_AFTER_MIN) warns.push({ code: "noclicks", sev: "high" });

  return {
    checks: {
      reach: p.viewsSeen != null && p.viewsAt ? { views: p.viewsSeen, at: p.viewsAt.toISOString() } : null,
      time: { plan: AD_SLOT_TIME[p.slot], fact: clockIn(pub, tz), late, lateMin },
      top,
      life,
    },
    warns,
  };
}

// --- applying one observation ----------------------------------------------

export interface Observation {
  present: boolean;
  /** When the post came out (the message date). */
  date?: Date;
  views?: number | null;
  /** When the channel's next post came out, if one has. */
  nextDate?: Date | null;
}

export interface ObservedFields {
  status: string;
  format: AdFormat;
  priceMode: string;
  cpmState: string | null;
  views: number | null;
  publishedAt: Date | null;
  removedAt: Date | null;
  nextPostAt: Date | null;
  viewsSeen: number | null;
  viewsAt: Date | null;
}

export interface ObservationResult {
  /** Columns to write on the buy / sale place. */
  patch: Partial<ObservedFields> & { cpmFixedAt?: Date | null; checkedAt: Date; checkError: null };
  /** The deal's new status, when the observation moves it. */
  status?: "live" | "done";
}

/**
 * What one look at a post changes. The rules:
 *  - found: it is out — the message date is the real publication time, an
 *    "agreed" deal becomes "live", and once its term (24/48 h) is over, "done";
 *  - a CPM price is fixed from the views just before the term ends;
 *  - gone after having been seen: it was removed now — the deal is "done", and
 *    a CPM price still waiting is settled from the last views, marked "failed"
 *    (an estimate to agree on, not a measurement);
 *  - gone without ever having been seen: nothing — the link may simply point at
 *    a post that is not out yet.
 */
export function applyObservation(f: ObservedFields, obs: Observation, now: Date): ObservationResult {
  const patch: ObservationResult["patch"] = { checkedAt: now, checkError: null };
  let status: ObservationResult["status"];
  const hours = AD_FORMAT_HOURS[f.format];
  const cpmWaiting = f.priceMode === "cpm" && (f.cpmState === "wait" || f.cpmState == null);

  if (obs.present && obs.date) {
    patch.publishedAt = obs.date;
    patch.viewsSeen = obs.views ?? f.viewsSeen;
    patch.viewsAt = now;
    if (f.removedAt) patch.removedAt = null; // seen again: the earlier "gone" was a glitch
    // The earliest next post is what ended the top; later checks may only see later ones.
    if (obs.nextDate && (!f.nextPostAt || obs.nextDate < f.nextPostAt)) patch.nextPostAt = obs.nextDate;
    const ends = obs.date.getTime() + hours * 3600_000;
    if (f.status === "plan" || f.status === "agreed") status = "live";
    if (now.getTime() >= ends && f.status !== "done") status = "done";
    if (cpmWaiting && obs.views != null && now.getTime() >= ends - CPM_FIX_LEAD_MIN * 60_000) {
      patch.views = obs.views;
      patch.cpmState = "fixed";
      patch.cpmFixedAt = now;
    }
  } else if (!obs.present && f.viewsAt && !f.removedAt) {
    patch.removedAt = now;
    if (f.status === "live" || f.status === "agreed" || f.status === "plan") status = "done";
    if (cpmWaiting && f.viewsSeen != null) {
      patch.views = f.viewsSeen;
      patch.cpmState = "failed";
      patch.cpmFixedAt = null;
    }
  }
  return { patch, status };
}

/** Is a post still worth looking at — or has everything there is to know been seen? */
export function needsCheck(f: Pick<ObservedFields, "status" | "format" | "publishedAt" | "removedAt" | "viewsAt"> & { date: string; slot: AdSlot }, now: Date, tz = AD_TIMEZONE): boolean {
  if (f.status === "cancel") return false;
  if (f.removedAt) return false;
  const hours = AD_FORMAT_HOURS[f.format];
  if (f.publishedAt && f.viewsAt) {
    // one more look after the term, to see whether it was removed on time
    return now.getTime() < f.publishedAt.getTime() + (hours + 2) * 3600_000;
  }
  // not seen yet: keep looking from a day before the slot until two days after it
  const start = slotStart(f.date, f.slot, tz).getTime();
  return now.getTime() > start - 24 * 3600_000 && now.getTime() < start + 48 * 3600_000;
}
