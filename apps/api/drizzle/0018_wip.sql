-- YT-19: WIP-лимиты и перегруз (R-2.21, R-2.27; docs/adr/0025).
-- Режим «предупреждение» / «запрет» — на пространство и на фичекоманду (дорожку команды).
ALTER TABLE `spaces` ADD `wip_mode` text DEFAULT 'warn' NOT NULL CHECK (`wip_mode` IN ('warn', 'block'));
--> statement-breakpoint
ALTER TABLE `feature_teams` ADD `wip_mode` text DEFAULT 'warn' NOT NULL CHECK (`wip_mode` IN ('warn', 'block'));
--> statement-breakpoint
-- Лимит на схему: сколько тикетов этой схемы одновременно в работе (без статусов «ожидание»).
ALTER TABLE `status_schemes` ADD `wip_limit` integer CHECK (`wip_limit` IS NULL OR `wip_limit` >= 1);
--> statement-breakpoint
-- Общие настройки: норма по умолчанию (R-5.5: 3), окно накопления уведомлений, порог «перегружена команда»
-- (доля участников, по умолчанию треть), час утренней сводки.
CREATE TABLE `wip_settings` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`default_norm` integer DEFAULT 3 NOT NULL CHECK (`default_norm` >= 1),
	`window_minutes` integer DEFAULT 15 NOT NULL CHECK (`window_minutes` >= 0),
	`team_share` integer DEFAULT 34 NOT NULL CHECK (`team_share` BETWEEN 1 AND 100),
	`digest_hour` integer DEFAULT 9 NOT NULL CHECK (`digest_hour` BETWEEN 0 AND 23)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `wip_settings` (`id`) VALUES (1);
--> statement-breakpoint
-- Состояние перегруза человека для уведомлений: вход, ожидание окна, день последнего уведомления.
CREATE TABLE `overload_state` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`overloaded` integer DEFAULT 0 NOT NULL,
	`entered_at` integer,
	`pending` integer DEFAULT 0 NOT NULL,
	`notified_day` text
);
--> statement-breakpoint
-- Утренняя сводка: день, когда получатель её уже получил.
CREATE TABLE `wip_digest` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`day` text NOT NULL
);
