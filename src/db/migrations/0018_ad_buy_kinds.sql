ALTER TABLE `ad_buys` ADD `kind` text DEFAULT 'post' NOT NULL;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `unit_price` real;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `units` integer;--> statement-breakpoint
ALTER TABLE `ad_buys` ADD `stopped_at` integer;