CREATE TABLE `ad_post_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat` text NOT NULL,
	`message_id` integer NOT NULL,
	`published_at` integer NOT NULL,
	`delete_at` integer,
	`removed_at` integer,
	`place_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`place_id`) REFERENCES `ad_sale_places`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_post_reports_msg_unique` ON `ad_post_reports` (`chat`,`message_id`);