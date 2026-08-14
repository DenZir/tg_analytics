CREATE TABLE `utm_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`utm_link_id` integer NOT NULL,
	`tg_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`utm_link_id`) REFERENCES `utm_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `utm_events_user_ts_idx` ON `utm_events` (`tg_user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `utm_events_link_idx` ON `utm_events` (`utm_link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `utm_events_link_user_type_ts_unique` ON `utm_events` (`utm_link_id`,`tg_user_id`,`event_type`,`ts`);--> statement-breakpoint
CREATE TABLE `utm_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`utm_source` text NOT NULL,
	`utm_medium` text NOT NULL,
	`utm_campaign` text NOT NULL,
	`utm_content` text,
	`label` text,
	`spend` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `utm_links_slug_unique` ON `utm_links` (`slug`);