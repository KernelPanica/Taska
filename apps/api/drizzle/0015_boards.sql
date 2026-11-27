-- YT-16: доски и зоны (R-2.18, R-2.19, R-5.1; docs/adr/0022).
-- Доска = базовый фильтр TQL + раскладка + чипы. Тикеты не хранит: только ручной порядок карточек.
-- Владелец — пространство (space_id) или человек (owner_id); kind = 'mine' — стартовая личная «Мои задачи».
-- Дерево зон — JSON на доске: [{id, key, name, parentId, position, statuses: [имя статуса], wipLimit}].
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL CHECK (`kind` IN ('custom', 'mine')),
	`space_id` text REFERENCES `spaces`(`id`) ON DELETE cascade,
	`owner_id` text REFERENCES `users`(`id`) ON DELETE cascade,
	`query` text NOT NULL,
	`lanes` text DEFAULT 'none' NOT NULL,
	`sort` text DEFAULT 'due' NOT NULL,
	`done_days` integer DEFAULT 14 NOT NULL,
	`chips` text DEFAULT '["type"]' NOT NULL,
	`zones` text NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK ((`space_id` IS NULL) != (`owner_id` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `boards_space_idx` ON `boards` (`space_id`);
--> statement-breakpoint
CREATE INDEX `boards_owner_idx` ON `boards` (`owner_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_mine_unique` ON `boards` (`owner_id`) WHERE `kind` = 'mine';
--> statement-breakpoint
-- Личные настройки доски: детализация, свёрнутые зоны и уровни, плотность, выключенные чипы (R-2.19).
CREATE TABLE `board_prefs` (
	`board_id` text NOT NULL REFERENCES `boards`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`prefs` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`board_id`, `user_id`)
);
--> statement-breakpoint
-- Стабильный ручной порядок карточек на доске (общий для всех зрителей доски).
CREATE TABLE `board_ranks` (
	`board_id` text NOT NULL REFERENCES `boards`(`id`) ON DELETE cascade,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`rank` real NOT NULL,
	PRIMARY KEY (`board_id`, `ticket_id`)
);
--> statement-breakpoint
CREATE INDEX `tickets_status_changed_idx` ON `tickets` (`status_id`, `status_changed_at`);
