import { sqliteTable, integer, text, real, unique, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  telegramChatId: text("telegram_chat_id"),
  botUsername: text("bot_username"),
  linkedProjectId: integer("linked_project_id"),
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
    linkId: integer("link_id")
      .notNull()
      .references(() => links.id),
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
    unique("events_link_user_type_ts_unique").on(
      table.linkId,
      table.tgUserId,
      table.eventType,
      table.ts
    ),
    index("events_user_ts_idx").on(table.tgUserId, table.ts),
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

// --- Independent UTM-tracking mechanic (separate from the campaigns/links/events model above) ---

export const utmLinks = sqliteTable("utm_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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

export const utmEvents = sqliteTable(
  "utm_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    utmLinkId: integer("utm_link_id")
      .notNull()
      .references(() => utmLinks.id),
    tgUserId: text("tg_user_id").notNull(),
    eventType: text("event_type").notNull(), // 'start' | 'payment' | 'renewal'
    amount: real("amount").notNull().default(0),
    languageCode: text("language_code"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    unique("utm_events_link_user_type_ts_unique").on(
      table.utmLinkId,
      table.tgUserId,
      table.eventType,
      table.ts
    ),
    index("utm_events_user_ts_idx").on(table.tgUserId, table.ts),
    index("utm_events_link_idx").on(table.utmLinkId),
  ]
);

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
