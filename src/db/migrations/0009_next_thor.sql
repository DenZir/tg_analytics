CREATE TABLE `admin_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`details` text,
	`ts` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_actions_target_idx` ON `admin_actions` (`target_type`,`target_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `deleted_at` integer;