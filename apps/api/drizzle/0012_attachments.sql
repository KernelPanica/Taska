-- YT-13: вложения (R-2.24, R-3.2; docs/adr/0019). Файлы лежат вне публичного каталога под случайными именами,
-- выдаются только через проверку прав. Лимиты и допустимые типы задаёт админ; меняются без перезапуска.
CREATE TABLE `attachment_settings` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`max_file_bytes` integer NOT NULL,
	`max_ticket_bytes` integer NOT NULL,
	`max_space_bytes` integer NOT NULL,
	`allowed` text NOT NULL,
	`updated_by` text REFERENCES `users`(`id`),
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- По умолчанию: файл до 500 МБ (видео записей багов), тикет до 2 ГБ, пространство до 100 ГБ; без SVG и HTML (R-3.2).
INSERT OR IGNORE INTO `attachment_settings` (`id`, `max_file_bytes`, `max_ticket_bytes`, `max_space_bytes`, `allowed`, `updated_at`) VALUES
	(1, 524288000, 2147483648, 107374182400, '["png","jpg","gif","webp","mp4","mov","webm","pdf","txt","md","csv","docx","xlsx","pptx","zip"]', 1795050000000);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`uploaded_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_ticket_idx` ON `attachments` (`ticket_id`, `created_at`);
--> statement-breakpoint
-- Незавершённые загрузки частями: докачка с места обрыва (received — сколько байт уже на сервере).
CREATE TABLE `attachment_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
