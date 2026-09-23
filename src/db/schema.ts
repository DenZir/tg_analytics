import { sqliteTable, integer, text, real, unique, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// A project owns up to one channel and one bot; `type` is derived from which of
// the two it has (see db/projectTypes.ts) and is never set independently.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  telegramChatId: text("telegram_chat_id"),
  botUsername: text("bot_username"),
});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  advertiser: text("advertiser").notNull(),
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
