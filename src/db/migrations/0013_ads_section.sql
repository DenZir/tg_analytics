CREATE TABLE `ad_buys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`campaign_id` integer,
	`utm_link_id` integer,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`format` text DEFAULT '1/24' NOT NULL,
	`status` text DEFAULT 'plan' NOT NULL,
	`price_mode` text DEFAULT 'fix' NOT NULL,
	`price` real,
	`cpm_rate` real,
	`views` integer,
	`cpm_state` text,
	`cpm_fixed_at` integer,
	`creative` text,
	`post_url` text,
	`notes` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`utm_link_id`) REFERENCES `utm_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ad_buys_date_idx` ON `ad_buys` (`date`);--> statement-breakpoint
CREATE INDEX `ad_buys_project_date_idx` ON `ad_buys` (`project_id`,`date`);--> statement-breakpoint
CREATE INDEX `ad_buys_contact_idx` ON `ad_buys` (`contact_id`);--> statement-breakpoint
CREATE INDEX `ad_buys_campaign_idx` ON `ad_buys` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `ad_sale_places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`share` real,
	`views` integer,
	`cpm_state` text,
	`cpm_fixed_at` integer,
	`post_url` text,
	`published_at` integer,
	FOREIGN KEY (`sale_id`) REFERENCES `ad_sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ad_sale_places_project_idx` ON `ad_sale_places` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_sale_places_sale_project_unique` ON `ad_sale_places` (`sale_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `ad_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`format` text DEFAULT '1/24' NOT NULL,
	`status` text DEFAULT 'plan' NOT NULL,
	`price_mode` text DEFAULT 'fix' NOT NULL,
	`cpm_rate` real,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ad_sales_date_idx` ON `ad_sales` (`date`);--> statement-breakpoint
CREATE INDEX `ad_sales_contact_idx` ON `ad_sales` (`contact_id`);--> statement-breakpoint
CREATE TABLE `ad_settlement_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`settlement_id` integer NOT NULL,
	`kind` text NOT NULL,
	`deal_id` integer NOT NULL,
	FOREIGN KEY (`settlement_id`) REFERENCES `ad_settlements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ad_settlement_items_deal_idx` ON `ad_settlement_items` (`kind`,`deal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_settlement_items_unique` ON `ad_settlement_items` (`settlement_id`,`kind`,`deal_id`);--> statement-breakpoint
CREATE TABLE `ad_settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`net` real NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ad_settlements_contact_idx` ON `ad_settlements` (`contact_id`);--> statement-breakpoint
CREATE TABLE `ad_status_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`deal_id` integer NOT NULL,
	`status` text NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ad_status_history_deal_idx` ON `ad_status_history` (`kind`,`deal_id`);--> statement-breakpoint
CREATE TABLE `contact_usernames` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`username` text NOT NULL,
	`replaced_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_usernames_lower_idx` ON `contact_usernames` (lower("username"));--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`username` text,
	`tg_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_username_lower_unique` ON `contacts` (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tg_user_id_unique` ON `contacts` (`tg_user_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `mandatory_slots` text;--> statement-breakpoint
-- Backfill: one contact per existing campaign advertiser. "@x" becomes username x
-- (named after a plain "x" campaign if there is one, so "@tenshi" and "tenshi"
-- end up as the same person); plain names get no username. The automatic
-- "Не размечено (авто)" bucket is not a person and gets no contact.
INSERT INTO `contacts` (`name`, `username`)
SELECT
	COALESCE(
		(SELECT MIN(trim(c2.`advertiser`)) FROM `campaigns` c2
			WHERE lower(trim(c2.`advertiser`)) = lower(substr(trim(c.`advertiser`), 2))),
		MIN(substr(trim(c.`advertiser`), 2))
	),
	MIN(substr(trim(c.`advertiser`), 2))
FROM `campaigns` c
WHERE trim(c.`advertiser`) LIKE '@%' AND length(trim(c.`advertiser`)) > 1
GROUP BY lower(substr(trim(c.`advertiser`), 2));
--> statement-breakpoint
INSERT INTO `contacts` (`name`)
SELECT MIN(trim(c.`advertiser`))
FROM `campaigns` c
WHERE trim(c.`advertiser`) NOT LIKE '@%'
	AND trim(c.`advertiser`) <> ''
	AND trim(c.`advertiser`) <> 'Не размечено (авто)'
	AND NOT EXISTS (SELECT 1 FROM `contacts` k WHERE lower(k.`username`) = lower(trim(c.`advertiser`)))
GROUP BY lower(trim(c.`advertiser`));
--> statement-breakpoint
UPDATE `campaigns` SET `contact_id` = (
	SELECT k.`id` FROM `contacts` k
	WHERE (trim(`campaigns`.`advertiser`) LIKE '@%'
			AND lower(k.`username`) = lower(substr(trim(`campaigns`.`advertiser`), 2)))
		OR (trim(`campaigns`.`advertiser`) NOT LIKE '@%'
			AND (lower(k.`username`) = lower(trim(`campaigns`.`advertiser`))
				OR (k.`username` IS NULL AND lower(k.`name`) = lower(trim(`campaigns`.`advertiser`)))))
	ORDER BY k.`id` LIMIT 1
)
WHERE trim(`advertiser`) <> 'Не размечено (авто)';
