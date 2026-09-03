ALTER TABLE `events` ADD `promo_code` text;--> statement-breakpoint
ALTER TABLE `events` ADD `discount_amount` real DEFAULT 0 NOT NULL;