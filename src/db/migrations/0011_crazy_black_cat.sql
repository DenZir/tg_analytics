-- Attribution becomes optional; the project becomes mandatory.
--
-- Hand-written, for two reasons drizzle-kit cannot know about.
--
-- First, the data: project_id is derived through link -> campaign -> project,
-- utm_links must gain a project before events can borrow it, and the contents
-- of utm_events belong in events.
--
-- Second, the order. `PRAGMA foreign_keys=OFF` does nothing inside a
-- transaction, and that is exactly where drizzle runs migrations — so a table
-- cannot be dropped while anything still references it. utm_events therefore
-- has to lose its foreign key BEFORE utm_links is rebuilt, not after.

-- 1. utm_events becomes a free-standing archive.
--
-- Nothing will read it again: its rows are copied into `events` in step 4. It
-- survives this migration untouched so the merge can be checked against its
-- source, and it sheds its foreign key so that step 2 becomes possible at all.
CREATE TABLE `__new_utm_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`utm_link_id` integer NOT NULL,
	`tg_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`language_code` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_utm_events`("id", "utm_link_id", "tg_user_id", "event_type", "amount", "language_code", "ts")
SELECT "id", "utm_link_id", "tg_user_id", "event_type", "amount", "language_code", "ts" FROM `utm_events`;
--> statement-breakpoint
DROP TABLE `utm_events`;--> statement-breakpoint
ALTER TABLE `__new_utm_events` RENAME TO `utm_events`;--> statement-breakpoint

-- 2. utm_links gains a project.
--
-- SQLite rejects ALTER TABLE ADD COLUMN NOT NULL without a default on a table
-- that already has rows, so the table is rebuilt. The project is matched by bot
-- username — the only thread that exists between the two tables today. Links
-- created before bot_username was persisted fall back to the oldest bot
-- project, which is in practice where they came from; the final fallback to the
-- oldest project of any kind exists only so the migration cannot abort and take
-- the whole service down with it.
CREATE TABLE `__new_utm_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`slug` text NOT NULL,
	`utm_source` text NOT NULL,
	`utm_medium` text NOT NULL,
	`utm_campaign` text NOT NULL,
	`utm_content` text,
	`label` text,
	`spend` real,
	`bot_username` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_utm_links` ("id", "project_id", "slug", "utm_source", "utm_medium", "utm_campaign", "utm_content", "label", "spend", "bot_username", "created_at")
SELECT
	ul."id",
	COALESCE(
		(SELECT p."id" FROM `projects` p WHERE p."bot_username" IS NOT NULL AND p."bot_username" = ul."bot_username" ORDER BY p."id" LIMIT 1),
		(SELECT p."id" FROM `projects` p WHERE p."type" = 'bot_subscription' ORDER BY p."id" LIMIT 1),
		(SELECT p."id" FROM `projects` p ORDER BY p."id" LIMIT 1)
	),
	ul."slug", ul."utm_source", ul."utm_medium", ul."utm_campaign", ul."utm_content",
	ul."label", ul."spend", ul."bot_username", ul."created_at"
FROM `utm_links` ul;
--> statement-breakpoint
DROP TABLE `utm_links`;--> statement-breakpoint
ALTER TABLE `__new_utm_links` RENAME TO `utm_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `utm_links_slug_unique` ON `utm_links` (`slug`);--> statement-breakpoint

-- 3. events: link_id becomes optional, project_id/utm_link_id/source arrive.
-- Every existing row came in through a link, so it keeps source 'link'.
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`link_id` integer,
	`utm_link_id` integer,
	`source` text DEFAULT 'organic' NOT NULL,
	`tg_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`promo_code` text,
	`discount_amount` real DEFAULT 0 NOT NULL,
	`language_code` text,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`utm_link_id`) REFERENCES `utm_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_events` ("id", "project_id", "link_id", "utm_link_id", "source", "tg_user_id", "event_type", "amount", "promo_code", "discount_amount", "language_code", "ts")
SELECT
	e."id",
	COALESCE(
		(SELECT c."project_id" FROM `links` l JOIN `campaigns` c ON c."id" = l."campaign_id" WHERE l."id" = e."link_id"),
		(SELECT p."id" FROM `projects` p ORDER BY p."id" LIMIT 1)
	),
	e."link_id", NULL, 'link',
	e."tg_user_id", e."event_type", e."amount", e."promo_code", e."discount_amount", e."language_code", e."ts"
FROM `events` e;
--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint

-- 4. The archived UTM events move in. 'start' becomes 'lead': both mean
-- "pressed start in the bot", and only 'lead' is a funnel entry type, so
-- leaving it as 'start' would keep every UTM arrival out of every conversion
-- rate. Ids are left to AUTOINCREMENT so they cannot collide with the rows
-- copied above.
INSERT INTO `events` ("project_id", "link_id", "utm_link_id", "source", "tg_user_id", "event_type", "amount", "promo_code", "discount_amount", "language_code", "ts")
SELECT
	ul."project_id", NULL, ue."utm_link_id", 'utm', ue."tg_user_id",
	CASE ue."event_type" WHEN 'start' THEN 'lead' ELSE ue."event_type" END,
	ue."amount", NULL, 0, ue."language_code", ue."ts"
FROM `utm_events` ue
JOIN `utm_links` ul ON ul."id" = ue."utm_link_id";
--> statement-breakpoint

-- 5. The new deduplication key is stricter than the old one: it no longer
-- includes link_id, so two rows that differed only by which link they were
-- attributed to now collide. Those are duplicates in substance — one user
-- cannot arrive from two links in the same second — and the oldest row wins,
-- which also means a link-attributed row beats the UTM copy of the same touch.
-- Done before the index exists, because afterwards it would simply fail.
DELETE FROM `events` WHERE "id" NOT IN (
	SELECT MIN("id") FROM `events` GROUP BY "project_id", "tg_user_id", "event_type", "ts"
);
--> statement-breakpoint
CREATE INDEX `events_user_ts_idx` ON `events` (`tg_user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_project_ts_idx` ON `events` (`project_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_link_idx` ON `events` (`link_id`);--> statement-breakpoint
CREATE INDEX `events_utm_link_idx` ON `events` (`utm_link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_project_user_type_ts_unique` ON `events` (`project_id`,`tg_user_id`,`event_type`,`ts`);
