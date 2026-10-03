import { sqliteTable, integer, text, real, unique, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// A project owns up to one channel and one bot; `type` is derived from which of
// the two it has (see db/projectTypes.ts) and is never set independently.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  telegramChatId: text("telegram_chat_id"),
  botUsername: text("bot_username"),
  // Ad section: the slots this channel must sell every day, as a JSON array of
  // AD_SLOTS values. Null means the default (morning, day, evening). Ignored
  // for a project without a channel — there is nothing to sell there.
  mandatorySlots: text("mandatory_slots"),
  // Ad section: does it buy placements for this project / sell places in it.
  // Null — the default for its make-up (see adsModesOf in db/projectTypes.ts).
  adsBuy: integer("ads_buy", { mode: "boolean" }),
  adsSell: integer("ads_sell", { mode: "boolean" }),
});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  advertiser: text("advertiser").notNull(),
  // Who the placement was bought from, as a contact. `advertiser` stays as the
  // display text it always was; the contact is what ties this campaign to the
  // same person's other buys and sales.
  contactId: integer("contact_id").references(() => contacts.id),
  price: real("price").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  // Soft-delete: null means active. Set when an admin moves the campaign to
  // the trash; the campaign (and its links/tags/stats/events) is only
  // actually removed once purgeCampaignCascade() runs, either manually or
  // via the daily auto-purge job once TRASH_RETENTION_DAYS has elapsed.
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const campaignTags = sqliteTable("campaign_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  tagKey: text("tag_key").notNull(),
  tagValue: text("tag_value").notNull(),
});

export const links = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  telegramRef: text("telegram_ref").notNull().unique(),
  linkType: text("link_type").notNull(),
  label: text("label"),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // The project is the only thing an event is always sure about. Attribution
    // is not: a buyer who never touched a tracked link or a UTM slug still
    // spent real money, and used to be dropped on the floor because link_id
    // was mandatory. Both attribution columns are now optional and `source`
    // records which one actually resolved — so "by link + by UTM + organic"
    // always adds back up to the project's total, with nothing missing.
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    linkId: integer("link_id").references(() => links.id),
    utmLinkId: integer("utm_link_id").references(() => utmLinks.id),
    source: text("source").notNull().default("organic"),
    tgUserId: text("tg_user_id").notNull(),
    eventType: text("event_type").notNull(),
    amount: real("amount").notNull().default(0),
    // Promo code spent on this purchase, and what it took off. `amount` is
    // already net of the discount — it is the money actually received — so
    // revenue metrics need no adjustment; these two only answer "which codes
    // are working".
    promoCode: text("promo_code"),
    discountAmount: real("discount_amount").notNull().default(0),
    languageCode: text("language_code"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Deduplication key for Telegram's habit of redelivering the same update.
    // It used to lead with link_id, which no longer works: SQLite treats NULLs
    // as distinct, so every organic event would slip past the constraint. The
    // project is never null, and two different links cannot both be the true
    // source for one user, one event type and one second.
    unique("events_project_user_type_ts_unique").on(
      table.projectId,
      table.tgUserId,
      table.eventType,
      table.ts
    ),
    index("events_user_ts_idx").on(table.tgUserId, table.ts),
    index("events_project_ts_idx").on(table.projectId, table.ts),
    index("events_link_idx").on(table.linkId),
    index("events_utm_link_idx").on(table.utmLinkId),
  ]
);

export const dailyStats = sqliteTable(
  "daily_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    date: text("date").notNull(),
    subs: integer("subs").notNull().default(0),
    revenue: real("revenue").notNull().default(0),
    cps: real("cps"),
  },
  (table) => [
    unique("daily_stats_campaign_date_unique").on(
      table.campaignId,
      table.date
    ),
  ]
);

// --- UTM tracking: a second way to attribute an event, not a second ledger ---
//
// UTM links used to own their own event table and stood outside the project
// model entirely, which is why the dashboard could never say which project a
// UTM hit belonged to. They now hang off a project like everything else, and
// the events they generate live in `events` alongside the rest.

export const utmLinks = sqliteTable("utm_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  slug: text("slug").notNull().unique(),
  utmSource: text("utm_source").notNull(),
  utmMedium: text("utm_medium").notNull(),
  utmCampaign: text("utm_campaign").notNull(),
  utmContent: text("utm_content"),
  label: text("label"),
  spend: real("spend"),
  botUsername: text("bot_username"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// --- Dashboard admin login sessions (Telegram-based auth) ---

export const dashboardSessions = sqliteTable("dashboard_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  tgUserId: text("tg_user_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

/**
 * Archive of the old UTM event ledger. Migration 0011 copied every row into
 * `events` and left this table behind untouched, so the merge can be checked
 * against its source; nothing reads or writes it any more.
 *
 * Two deliberate differences from the original. It has no foreign key, because
 * the table it pointed at (`utm_links`) is rebuilt in that same migration and
 * SQLite cannot drop a referenced table inside a transaction — which is exactly
 * where drizzle runs migrations, making `PRAGMA foreign_keys=OFF` a no-op. And
 * it has no indexes, because nothing queries it.
 *
 * Safe to drop once the numbers have been confirmed in production.
 */
export const utmEvents = sqliteTable("utm_events", {
  id: integer("id").primaryKey(),
  utmLinkId: integer("utm_link_id").notNull(),
  tgUserId: text("tg_user_id").notNull(),
  eventType: text("event_type").notNull(),
  amount: real("amount").notNull().default(0),
  languageCode: text("language_code"),
  ts: integer("ts", { mode: "timestamp" }).notNull(),
});

// --- Audit trail for admin actions (e.g. campaign trash/restore/purge) ---

export const adminActions = sqliteTable(
  "admin_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    adminId: text("admin_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: integer("target_id").notNull(),
    details: text("details"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("admin_actions_target_idx").on(table.targetType, table.targetId)]
);

// --- Ad section: buying and selling placements ---------------------------
//
// One person is often on both sides — sells me a slot in their channels and
// buys one in mine — so both sides point at the same `contacts` row. That is
// what lets "all operations with X" net the two directions against each other.
// Vocabulary (slots, formats, statuses, price modes) lives in db/adTypes.ts.

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // Current Telegram username, stored without "@". Optional: contacts carried
    // over from old campaign advertisers often only ever had a name.
    username: text("username"),
    // The stable identity. Usernames change and get reused by someone else;
    // the user id does not. Filled in once the account session can resolve it.
    tgUserId: text("tg_user_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("contacts_username_lower_unique").on(sql`lower(${table.username})`),
    uniqueIndex("contacts_tg_user_id_unique").on(table.tgUserId),
  ]
);

// Usernames a contact used before — kept so search still finds them by the old
// one, and so a new contact claiming a freed username can be flagged.
export const contactUsernames = sqliteTable(
  "contact_usernames",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    // When this username stopped being the current one.
    replacedAt: integer("replaced_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("contact_usernames_lower_idx").on(sql`lower(${table.username})`)]
);

// A placement I bought. Its results (subscribers, buyers, revenue) are not
// stored: they come from `events` through the buy's tracking link — the
// campaign's invite link for a channel project, a UTM link for a bot-only one.
// The buy's price is the source of truth; the campaign's `price` mirrors it.
export const adBuys = sqliteTable(
  "ad_buys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    campaignId: integer("campaign_id").references(() => campaigns.id),
    utmLinkId: integer("utm_link_id").references(() => utmLinks.id),
    date: text("date").notNull(), // YYYY-MM-DD, the planned day
    slot: text("slot").notNull(),
    format: text("format").notNull().default("1/24"),
    status: text("status").notNull().default("plan"),
    // post | welcome | requests (see AD_BUY_KINDS). Welcome and requests have no
    // slot or post: date is when they start, slot/format are kept but unused.
    kind: text("kind").notNull().default("post"),
    priceMode: text("price_mode").notNull().default("fix"),
    price: real("price"), // fixed amount, ₽
    unitPrice: real("unit_price"), // ₽ per subscriber (welcome) / per request (requests)
    units: integer("units"), // count frozen when stopped — what is paid for
    stoppedAt: integer("stopped_at", { mode: "timestamp" }), // welcome/requests stopped by hand
    cpmRate: real("cpm_rate"), // ₽ per 1000 views
    views: integer("views"), // fixed (or last known) views for CPM
    cpmState: text("cpm_state"),
    cpmFixedAt: integer("cpm_fixed_at", { mode: "timestamp" }),
    creative: text("creative"),
    postUrl: text("post_url"),
    notes: text("notes"),
    publishedAt: integer("published_at", { mode: "timestamp" }), // actual time out
    // --- what the post checker saw (jobs/adChecks.ts) ---
    // The post itself: a channel username or a marked id ("-100…"), and the
    // message number in it. Parsed from the post link when it is saved.
    postChat: text("post_chat"),
    postMessageId: integer("post_message_id"),
    removedAt: integer("removed_at", { mode: "timestamp" }), // first check that found it gone
    nextPostAt: integer("next_post_at", { mode: "timestamp" }), // the channel's next post — end of "top"
    viewsSeen: integer("views_seen"), // last measured views
    viewsAt: integer("views_at", { mode: "timestamp" }),
    checkedAt: integer("checked_at", { mode: "timestamp" }),
    checkError: text("check_error"), // why the last check could not look at the post
    alerted: text("alerted"), // JSON array of warning codes already sent to the admins
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("ad_buys_date_idx").on(table.date),
    index("ad_buys_project_date_idx").on(table.projectId, table.date),
    index("ad_buys_contact_idx").on(table.contactId),
    index("ad_buys_campaign_idx").on(table.campaignId),
  ]
);

// A placement I sold — possibly as a package across several of my channels:
// one buyer, one price, the same day and slot everywhere. The price is split
// between channels in ad_sale_places so per-channel numbers still add up.
export const adSales = sqliteTable(
  "ad_sales",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    date: text("date").notNull(),
    slot: text("slot").notNull(),
    format: text("format").notNull().default("1/24"),
    status: text("status").notNull().default("plan"),
    priceMode: text("price_mode").notNull().default("fix"),
    cpmRate: real("cpm_rate"), // one rate for the whole package
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ad_sales_date_idx").on(table.date), index("ad_sales_contact_idx").on(table.contactId)]
);

export const adSalePlaces = sqliteTable(
  "ad_sale_places",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => adSales.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    share: real("share"), // this channel's part of a fixed price, ₽
    views: integer("views"),
    cpmState: text("cpm_state"),
    cpmFixedAt: integer("cpm_fixed_at", { mode: "timestamp" }),
    postUrl: text("post_url"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    // --- what the post checker saw (jobs/adChecks.ts) ---
    // The post itself: a channel username or a marked id ("-100…"), and the
    // message number in it. Parsed from the post link when it is saved.
    postChat: text("post_chat"),
    postMessageId: integer("post_message_id"),
    removedAt: integer("removed_at", { mode: "timestamp" }), // first check that found it gone
    nextPostAt: integer("next_post_at", { mode: "timestamp" }), // the channel's next post — end of "top"
    viewsSeen: integer("views_seen"), // last measured views
    viewsAt: integer("views_at", { mode: "timestamp" }),
    checkedAt: integer("checked_at", { mode: "timestamp" }),
    checkError: text("check_error"), // why the last check could not look at the post
    alerted: text("alerted"), // JSON array of warning codes already sent to the admins
  },
  (table) => [
    unique("ad_sale_places_sale_project_unique").on(table.saleId, table.projectId),
    index("ad_sale_places_project_idx").on(table.projectId),
  ]
);

// Every measurement of an ad post: the proof behind a CPM amount ("12 480 views
// at 16:58") and the trail that shows when a post disappeared.
export const adPostSnapshots = sqliteTable(
  "ad_post_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    target: text("target").notNull(), // buy | place (ad_sale_places row)
    targetId: integer("target_id").notNull(),
    at: integer("at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    present: integer("present", { mode: "boolean" }).notNull(),
    views: integer("views"),
  },
  (table) => [index("ad_post_snapshots_target_idx").on(table.target, table.targetId, table.at)]
);

export const adStatusHistory = sqliteTable(
  "ad_status_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // buy | sale
    dealId: integer("deal_id").notNull(),
    status: text("status").notNull(),
    at: integer("at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ad_status_history_deal_idx").on(table.kind, table.dealId)]
);

// «Рассчитались»: zeroes the running balance with a contact without touching a
// single deal. The items record which operations the settlement closed, so the
// balance afterwards counts only the rest — and undoing a settlement is just
// deleting it.
export const adSettlements = sqliteTable(
  "ad_settlements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    net: real("net").notNull(), // balance at the moment: >0 I owed them, <0 they owed me
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ad_settlements_contact_idx").on(table.contactId)]
);

export const adSettlementItems = sqliteTable(
  "ad_settlement_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    settlementId: integer("settlement_id")
      .notNull()
      .references(() => adSettlements.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // buy | sale
    dealId: integer("deal_id").notNull(),
  },
  (table) => [
    unique("ad_settlement_items_unique").on(table.settlementId, table.kind, table.dealId),
    index("ad_settlement_items_deal_idx").on(table.kind, table.dealId),
  ]
);

// What posting reported about my own channels' posts marked «Реклама»: it
// publishes them, so it knows the exact moment and the message number. Each
// report is kept even when no sale matches it yet — a sale entered after the
// post came out is matched on the next checker pass.
export const adPostReports = sqliteTable(
  "ad_post_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chat: text("chat").notNull(), // channel id as posting has it, "-100…"
    messageId: integer("message_id").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp" }).notNull(),
    deleteAt: integer("delete_at", { mode: "timestamp" }), // posting's removal timer
    removedAt: integer("removed_at", { mode: "timestamp" }),
    placeId: integer("place_id").references(() => adSalePlaces.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("ad_post_reports_msg_unique").on(table.chat, table.messageId)]
);

// «Отслежка»: an admin I bought a place from gets a link to my tracking bot and
// sees how the placement is doing — joined, left, stayed, cost per subscriber.
// Anyone with the link can open it (the owner's choice: like the market's
// tracking bots, the link is the access).
export const adTrackLinks = sqliteTable("ad_track_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  buyId: integer("buy_id")
    .notNull()
    .unique()
    .references(() => adBuys.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(), // the ?start= payload, unguessable
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Each card the tracking bot has sent: refreshed in place while the post stands,
// then frozen with the final result once its term is over.
export const adTrackViews = sqliteTable(
  "ad_track_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackId: integer("track_id")
      .notNull()
      .references(() => adTrackLinks.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(), // who opened it
    messageId: integer("message_id").notNull(), // the card in that chat
    lastText: text("last_text"), // what the card shows now — no edit when nothing changed
    finalSentAt: integer("final_sent_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("ad_track_views_chat_unique").on(table.trackId, table.chatId)]
);
