CREATE TABLE `ad_post_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`target_id` integer NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`present` integer NOT NULL,
	`views` integer
);
--> statement-breakpoint
CREATE INDEX `ad_post_snapshots_target_idx` ON `ad_post_snapshots` (`target`,`target_id`,`at`);--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `post_chat` text;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `post_message_id` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `next_post_at` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `views_seen` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `views_at` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `checked_at` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `check_error` text;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `alerted` text;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `post_chat` text;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `post_message_id` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `next_post_at` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `views_seen` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `views_at` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `checked_at` integer;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `check_error` text;--> statement-breakpoint
ALTER TABLE `ad_sale_places` ADD `alerted` text;