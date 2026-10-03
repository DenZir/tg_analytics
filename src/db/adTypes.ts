/**
 * Vocabulary of the ad section — buying placements in other people's channels
 * («Закуп») and selling placements in my own («Продажа»).
 *
 * Stored as plain text columns, like every other enum in this schema: there is
 * no SQL CHECK behind them, so these lists are the only place the allowed
 * values are written down. Validate against them at the API boundary.
 */

/**
 * Where in the day a post goes out. Always in this order — it is the column
 * order of every grid and matrix. Morning…night are parts of the day with no
 * exact time; the two neutrals are exact times (09:00 and 17:00).
 */
export const AD_SLOTS = ["morning", "day", "evening", "night", "stories", "n9", "n17"] as const;
export type AdSlot = (typeof AD_SLOTS)[number];

/** Rough start time of each slot — used for "has this slot already passed". */
export const AD_SLOT_TIME: Record<AdSlot, string> = {
  morning: "10:00",
  day: "14:00",
  evening: "19:00",
  night: "23:00",
  stories: "12:00",
  n9: "09:00",
  n17: "17:00",
};

/** Slots a channel must sell every day unless configured otherwise. */
export const DEFAULT_MANDATORY_SLOTS: AdSlot[] = ["morning", "day", "evening"];

/** 1/24 — an hour at the top of the feed, a day in it; 1/48 — two days. */
export const AD_FORMATS = ["1/24", "1/48"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];
export const AD_FORMAT_HOURS: Record<AdFormat, number> = { "1/24": 24, "1/48": 48 };

/** Same lifecycle for buys and sales. There is deliberately no "paid" mark. */
export const AD_STATUSES = ["plan", "agreed", "live", "done", "cancel"] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

/** Statuses that are an obligation: they count towards money owed. */
export const AD_COMMITTED_STATUSES: AdStatus[] = ["agreed", "live", "done"];
/** Statuses where the post has actually gone out. */
export const AD_PUBLISHED_STATUSES: AdStatus[] = ["live", "done"];

/** A fixed price, or a rate per 1000 views settled once views are fixed. */
export const AD_PRICE_MODES = ["fix", "cpm"] as const;
export type AdPriceMode = (typeof AD_PRICE_MODES)[number];

/**
 * Views for a CPM price are fixed just before the post is taken down.
 * `failed` means the post disappeared first; the last known count stands in,
 * and the amount derived from it is an estimate.
 */
export const AD_CPM_STATES = ["wait", "fixed", "failed"] as const;
export type AdCpmState = (typeof AD_CPM_STATES)[number];

/** What a status-history row or a settlement item refers to. */
export const AD_DEAL_KINDS = ["buy", "sale"] as const;
export type AdDealKind = (typeof AD_DEAL_KINDS)[number];

export const isAdSlot = (v: unknown): v is AdSlot => (AD_SLOTS as readonly unknown[]).includes(v);
export const isAdFormat = (v: unknown): v is AdFormat => (AD_FORMATS as readonly unknown[]).includes(v);
export const isAdStatus = (v: unknown): v is AdStatus => (AD_STATUSES as readonly unknown[]).includes(v);
export const isAdPriceMode = (v: unknown): v is AdPriceMode => (AD_PRICE_MODES as readonly unknown[]).includes(v);

/**
 * What kind of buy it is. A post: a placement in a slot, 24/48 h, checked by the
 * post checker. A welcome («приветка»): my link in the admin's welcome message,
 * traffic trickles in for as long as it runs. Requests («заявки»): a join-request
 * link — people ask to join; I may approve them later. Welcome and requests have
 * no slot and no post, run until stopped by hand, and are paid per unit.
 */
export const AD_BUY_KINDS = ["post", "welcome", "requests"] as const;
export type AdBuyKind = (typeof AD_BUY_KINDS)[number];
export const isAdBuyKind = (v: unknown): v is AdBuyKind => (AD_BUY_KINDS as readonly unknown[]).includes(v);

/** Per-unit price: for a welcome — per subscriber who came, for requests — per request. */
export const AD_UNIT_PRICE_MODE = "unit" as const;
