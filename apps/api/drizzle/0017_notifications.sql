-- YT-18: уведомления и очередь событий (R-2.27, R-2.20; docs/adr/0024).
-- Живая запись: непрочитанное уведомление с тем же live_key обновляется на месте, а не множится.
ALTER TABLE `notifications` ADD `live_key` text;
--> statement-breakpoint
ALTER TABLE `notifications` ADD `updated_at` integer;
--> statement-breakpoint
UPDATE `notifications` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `notifications_live_idx` ON `notifications` (`user_id`, `live_key`) WHERE `live_key` IS NOT NULL AND `read_at` IS NULL;
--> statement-breakpoint
-- Очередь событий: одно сообщение на получателя и канал (колокольчик, тестовый адаптер; позже почта, Telegram).
-- Канал читает сообщения из очереди; новый канал подключается без переделки событий.
CREATE TABLE `event_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`live_key` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `event_queue_pending_idx` ON `event_queue` (`channel`, `delivered_at`, `created_at`);
--> statement-breakpoint
-- Какие виды событий человек отключил в профиле (по умолчанию включено всё).
CREATE TABLE `notification_prefs` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY (`user_id`, `kind`)
);
