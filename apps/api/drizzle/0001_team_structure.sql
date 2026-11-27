-- YT-02: люди, колодцы (guilds), фичекоманды, пространства, измерения (R-2.14 измерения, R-2.15 оргструктура, R-2.16 пространства).
-- Роль admin переименована в superadmin по глоссарию требований (раздел 1).
-- Пересборка users: человек может быть заведён до первого входа (yourspace_subject пустой), личная норма WIP.
CREATE TABLE `users_new` (
	`id` text PRIMARY KEY NOT NULL,
	`yourspace_subject` text,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL CHECK (`role` IN ('superadmin', 'member')),
	`locale` text DEFAULT 'ru' NOT NULL CHECK (`locale` IN ('ru', 'en')),
	`wip_limit` integer CHECK (`wip_limit` IS NULL OR (`wip_limit` >= 0 AND `wip_limit` <= 1000)),
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
INSERT INTO `users_new` (`id`, `yourspace_subject`, `email`, `name`, `role`, `locale`, `is_test`, `created_at`, `updated_at`, `last_login_at`)
SELECT `id`, `yourspace_subject`, lower(`email`), `name`, CASE `role` WHEN 'admin' THEN 'superadmin' ELSE `role` END, `locale`, `is_test`, `created_at`, `updated_at`, `last_login_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_new` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_yourspace_subject_unique` ON `users` (`yourspace_subject`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lead_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guilds_name_unique` ON `guilds` (`name`);
--> statement-breakpoint
CREATE TABLE `guild_members` (
	`guild_id` text NOT NULL REFERENCES `guilds`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `guild_members_user_idx` ON `guild_members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `feature_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pm_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_teams_name_unique` ON `feature_teams` (`name`);
--> statement-breakpoint
CREATE TABLE `feature_team_members` (
	`team_id` text NOT NULL REFERENCES `feature_teams`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `feature_team_members_user_idx` ON `feature_team_members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `dimensions` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('people_group', 'list')),
	`source` text CHECK (`source` IN ('feature_teams', 'guilds')),
	`multiple` integer DEFAULT 0 NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK ((`kind` = 'people_group' AND `source` IS NOT NULL) OR (`kind` = 'list' AND `source` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dimensions_key_unique` ON `dimensions` (`key`);
--> statement-breakpoint
CREATE TABLE `dimension_options` (
	`id` text PRIMARY KEY NOT NULL,
	`dimension_id` text NOT NULL REFERENCES `dimensions`(`id`) ON DELETE cascade,
	`label` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dimension_options_label_unique` ON `dimension_options` (`dimension_id`, `label`);
--> statement-breakpoint
-- Стартовые пространства (R-2.16) и измерения (R-2.14): «Фичекоманда» (team, одно значение или пусто)
-- и «Стрим» (stream, несколько значений) — реальные данные, есть в любой установке.
INSERT OR IGNORE INTO `spaces` (`id`, `slug`, `name`, `is_test`, `created_at`, `updated_at`) VALUES
	('space-direction', 'direction', 'Дирекция', 0, 1794852000000, 1794852000000),
	('space-core', 'core', 'Core', 0, 1794852000000, 1794852000000),
	('space-infrastructure', 'infrastructure', 'Инфраструктура', 0, 1794852000000, 1794852000000),
	('space-production', 'production', 'Производство', 0, 1794852000000, 1794852000000);
--> statement-breakpoint
INSERT OR IGNORE INTO `dimensions` (`id`, `key`, `name`, `kind`, `source`, `multiple`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('dimension-team', 'team', 'Фичекоманда', 'people_group', 'feature_teams', 0, 1, 0, 1794852000000, 1794852000000),
	('dimension-stream', 'stream', 'Стрим', 'people_group', 'guilds', 1, 1, 0, 1794852000000, 1794852000000);
