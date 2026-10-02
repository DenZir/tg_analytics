CREATE TABLE `ad_track_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`buy_id` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`buy_id`) REFERENCES `ad_buys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_track_links_buy_id_unique` ON `ad_track_links` (`buy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_track_links_token_unique` ON `ad_track_links` (`token`);--> statement-breakpoint
CREATE TABLE `ad_track_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_id` integer NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`last_text` text,
	`final_sent_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `ad_track_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_track_views_chat_unique` ON `ad_track_views` (`track_id`,`chat_id`);