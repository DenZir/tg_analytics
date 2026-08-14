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
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
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
