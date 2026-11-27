-- YT-06: тикеты (docs/adr/0012). Ключ AOS-N — один сквозной счётчик; номер не переиспользуется (R-2.6).
CREATE TABLE `ticket_counter` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`last_number` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `ticket_counter` (`id`, `last_number`) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL,
	`space_id` text NOT NULL REFERENCES `spaces`(`id`),
	`type_id` text NOT NULL REFERENCES `ticket_types`(`id`),
	`status_id` text NOT NULL REFERENCES `scheme_statuses`(`id`),
	`outcome` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`checklist` text DEFAULT '[]' NOT NULL,
	`field_values` text DEFAULT '{}' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL CHECK (`priority` IN ('highest', 'high', 'normal', 'low', 'lowest')),
	`tags` text DEFAULT '[]' NOT NULL,
	`start_date` text,
	`end_date` text,
	`blocked` integer DEFAULT 0 NOT NULL,
	`blocked_reason` text,
	`cancel_reason` text,
	`archived_at` integer,
	`archive_reason` text CHECK (`archive_reason` IS NULL OR `archive_reason` IN ('done', 'postponed', 'unmarked')),
	`version` integer DEFAULT 1 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_by` text REFERENCES `users`(`id`),
	`updated_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`status_changed_at` integer NOT NULL,
	CHECK ((`archived_at` IS NULL) = (`archive_reason` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_number_unique` ON `tickets` (`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_key_unique` ON `tickets` (`key`);
--> statement-breakpoint
CREATE INDEX `tickets_space_idx` ON `tickets` (`space_id`, `archived_at`);
--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status_id`);
--> statement-breakpoint
CREATE INDEX `tickets_type_idx` ON `tickets` (`type_id`);
--> statement-breakpoint
-- Люди тикета: несколько исполнителей, заказчик, тестировщик, наблюдатели. Один человек может быть в нескольких ролях.
CREATE TABLE `ticket_people` (
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`role` text NOT NULL CHECK (`role` IN ('assignee', 'customer', 'tester', 'watcher')),
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`ticket_id`, `user_id`, `role`)
);
--> statement-breakpoint
CREATE INDEX `ticket_people_user_idx` ON `ticket_people` (`user_id`, `role`);
