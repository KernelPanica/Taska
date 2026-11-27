-- YT-14: корзина, след родителя и пересвязка (R-2.8, R-2.22, R-5.2; docs/adr/0020).
-- Удалённый тикет остаётся строкой с признаком: ключ не переиспользуется, история не трогается.
-- Связи удалённого снимаются и запоминаются в trash_relations — восстановление возвращает их, если вторая сторона жива.
ALTER TABLE `tickets` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `deleted_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `tickets` ADD `trash_batch_id` text;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `purged_at` integer;
--> statement-breakpoint
CREATE INDEX `tickets_deleted_idx` ON `tickets` (`deleted_at`);
--> statement-breakpoint
-- Одно удаление (тикет, выделение или ветка) — один пакет: «Отменить» возвращает его целиком.
CREATE TABLE `trash_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`deleted_by` text REFERENCES `users`(`id`),
	`deleted_at` integer NOT NULL,
	`children_mode` text NOT NULL,
	`target_id` text
);
--> statement-breakpoint
-- Связи удалённого на момент удаления: parent (тикет — ребёнок other), child (other — ребёнок тикета),
-- link (связь R-2.13; from_side — тикет был источником), checklist (пункт-ребёнок у родителя other).
CREATE TABLE `trash_relations` (
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`other_id` text NOT NULL,
	`position` real,
	`link_type_id` text,
	`from_side` integer,
	`item_id` text
);
--> statement-breakpoint
CREATE INDEX `trash_relations_ticket_idx` ON `trash_relations` (`ticket_id`);
--> statement-breakpoint
-- Связи, которые создало само удаление (дети к другому родителю или к родителю удаляемого): «Отменить» их снимает.
CREATE TABLE `trash_added_links` (
	`batch_id` text NOT NULL,
	`parent_id` text NOT NULL,
	`child_id` text NOT NULL,
	`removed_parent_id` text NOT NULL
);
--> statement-breakpoint
-- След родителя (R-2.8): навсегда, даже после очистки корзины. relinked_at — ребёнок снова привязан.
CREATE TABLE `parent_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`child_id` text NOT NULL REFERENCES `tickets`(`id`),
	`parent_id` text NOT NULL REFERENCES `tickets`(`id`),
	`parent_key` text NOT NULL,
	`parent_title` text NOT NULL,
	`batch_id` text NOT NULL,
	`created_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	`relinked_at` integer,
	`relinked_to` text
);
--> statement-breakpoint
CREATE INDEX `parent_traces_child_idx` ON `parent_traces` (`child_id`);
--> statement-breakpoint
CREATE INDEX `parent_traces_parent_idx` ON `parent_traces` (`parent_id`);
--> statement-breakpoint
-- Очистка корзины — системное правило: раз в retention_days (по умолчанию квартал).
CREATE TABLE `trash_settings` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`retention_days` integer NOT NULL,
	`last_purge_at` integer,
	`updated_by` text REFERENCES `users`(`id`),
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `trash_settings` (`id`, `retention_days`, `updated_at`) VALUES (1, 90, 1795060000000);
--> statement-breakpoint
-- Колокольчик (R-2.27): пока одно событие — удаление тикета команды лидом. Одно сообщение на пакет.
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`actor_id` text REFERENCES `users`(`id`),
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`, `created_at`);
