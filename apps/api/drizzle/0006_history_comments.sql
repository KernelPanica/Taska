-- YT-07: неизменяемый журнал изменений тикета и комментарии (docs/adr/0013).
-- Журнал только дописывается: правку и удаление записей запрещают триггеры, API таких действий не имеет.
CREATE TABLE `ticket_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`),
	`at` integer NOT NULL,
	`actor_id` text REFERENCES `users`(`id`),
	`actor_name` text,
	`source` text NOT NULL CHECK (`source` IN ('person', 'system', 'rule', 'assistant')),
	`source_detail` text,
	`field` text NOT NULL,
	`field_label` text,
	`from_value` text,
	`to_value` text
);
--> statement-breakpoint
CREATE INDEX `ticket_history_ticket_idx` ON `ticket_history` (`ticket_id`, `id`);
--> statement-breakpoint
CREATE INDEX `ticket_history_field_idx` ON `ticket_history` (`field`, `at`);
--> statement-breakpoint
CREATE TRIGGER `ticket_history_no_update` BEFORE UPDATE ON `ticket_history`
BEGIN
	SELECT RAISE(ABORT, 'ticket history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `ticket_history_no_delete` BEFORE DELETE ON `ticket_history`
BEGIN
	SELECT RAISE(ABORT, 'ticket history is append-only');
END;
--> statement-breakpoint
-- Тикеты, созданные до журнала: запись о создании и стартовом статусе от имени системы.
INSERT INTO `ticket_history` (`ticket_id`, `at`, `actor_id`, `actor_name`, `source`, `source_detail`, `field`, `from_value`, `to_value`)
SELECT t.`id`, t.`created_at`, NULL, NULL, 'system', 'history started', 'status', NULL,
	json_object('raw', json_object('id', s.`id`, 'name', s.`name`, 'category', s.`category`), 'text', s.`name`)
FROM `tickets` t JOIN `scheme_statuses` s ON s.`id` = t.`status_id`;
--> statement-breakpoint
CREATE TABLE `ticket_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`),
	`author_id` text REFERENCES `users`(`id`),
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by` text REFERENCES `users`(`id`),
	`created_ticket_id` text REFERENCES `tickets`(`id`),
	`is_test` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_comments_ticket_idx` ON `ticket_comments` (`ticket_id`, `created_at`);
--> statement-breakpoint
-- Упоминания людей и тикетов в комментариях (для ссылок и уведомлений YT-18).
CREATE TABLE `comment_mentions` (
	`comment_id` text NOT NULL REFERENCES `ticket_comments`(`id`) ON DELETE cascade,
	`kind` text NOT NULL CHECK (`kind` IN ('person', 'ticket')),
	`target_id` text NOT NULL,
	PRIMARY KEY(`comment_id`, `kind`, `target_id`)
);
