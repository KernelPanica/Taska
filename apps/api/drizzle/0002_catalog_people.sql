-- YT-03: люди из общего каталога YourSpace (docs/adr/0009).
-- Пересборка users: почта — данные каталога (может быть пустой, уникальность обеспечивает YourSpace),
-- деактивация вместо удаления, способ сопоставления с каталогом.
CREATE TABLE `users_new` (
	`id` text PRIMARY KEY NOT NULL,
	`yourspace_subject` text,
	`email` text,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL CHECK (`role` IN ('superadmin', 'member')),
	`locale` text DEFAULT 'ru' NOT NULL CHECK (`locale` IN ('ru', 'en')),
	`wip_limit` integer CHECK (`wip_limit` IS NULL OR (`wip_limit` >= 0 AND `wip_limit` <= 1000)),
	`is_test` integer DEFAULT 0 NOT NULL,
	`deactivated_at` integer,
	`catalog_match` text DEFAULT 'unresolved' NOT NULL CHECK (`catalog_match` IN ('subject', 'email', 'manual', 'created', 'retired', 'unresolved')),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
INSERT INTO `users_new` (`id`, `yourspace_subject`, `email`, `name`, `role`, `locale`, `wip_limit`, `is_test`, `deactivated_at`, `catalog_match`, `created_at`, `updated_at`, `last_login_at`)
SELECT `id`, `yourspace_subject`, `email`, `name`, `role`, `locale`, `wip_limit`, `is_test`, NULL,
	CASE WHEN `yourspace_subject` IS NULL THEN 'unresolved' ELSE 'subject' END, `created_at`, `updated_at`, `last_login_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_new` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_yourspace_subject_unique` ON `users` (`yourspace_subject`);
--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);
--> statement-breakpoint
-- Кэш профиля из каталога: только нечувствительные поля и маски чувствительных (R-2.2).
CREATE TABLE `catalog_profiles` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`username` text NOT NULL,
	`full_name` text,
	`nickname` text,
	`telegram` text,
	`vk` text,
	`city` text,
	`timezone` text,
	`portfolio` text,
	`role_title` text,
	`membership_status` text,
	`joined_at` text,
	`tenure` text,
	`availability_hours` integer,
	`gitea_login` text,
	`perforce_login` text,
	`masks` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
-- Курсор событий каталога и состояние синхронизации.
CREATE TABLE `catalog_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
