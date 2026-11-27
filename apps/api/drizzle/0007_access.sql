-- YT-08: права «кто × где × что», видимость тикетов, маска полей, «Смотреть как» и «Режим показа» (R-2.20, R-5.2; docs/adr/0014).
-- Профиль — набор прав; у права — области, где оно действует (all, team, stream, no_team, own, own_queued, own_deleted).
CREATE TABLE `access_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`rights` text DEFAULT '{}' NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_profiles_key_unique` ON `access_profiles` (`key`);
--> statement-breakpoint
-- Шесть готовых профилей по матрице R-5.2 (тест сверяет их с матрицей в contracts/access.ts).
INSERT OR IGNORE INTO `access_profiles` (`id`, `key`, `name`, `rights`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('profile-superadmin', 'superadmin', 'Суперадмин', '{"view":["all"],"comment":["all"],"create":["all"],"edit":["all"],"status":["all"],"assign":["all"],"dates":["all"],"move":["all"],"trash":["all"],"visibility":["all"],"bulk":["all"],"assistant":["all"],"boards_space":["all"],"boards_personal":["all"],"configure":["all"],"automation":["all"],"wip_override":["all"],"grant":["all"],"org":["all"],"purge":["all"],"restore":["all"],"export":["all"],"directory":["all"],"tags":["all"],"frozen":["all"]}', 1, 0, 1795000000000, 1795000000000),
	('profile-space-admin', 'space_admin', 'Админ пространства', '{"view":["all"],"comment":["all"],"create":["all"],"edit":["all"],"status":["all"],"assign":["all"],"dates":["all"],"move":["all"],"trash":["all"],"visibility":["all"],"bulk":["all"],"assistant":["all"],"boards_space":["all"],"boards_personal":["all"],"configure":["all"],"automation":["all"],"wip_override":["all"],"grant":["all"],"restore":["all"],"export":["all"],"tags":["all"],"frozen":["all"]}', 1, 0, 1795000000000, 1795000000000),
	('profile-team-pm', 'team_pm', 'ПМ команды', '{"view":["all"],"comment":["all"],"create":["all"],"edit":["team"],"status":["team"],"assign":["team"],"dates":["team"],"move":["team"],"trash":["team"],"bulk":["team"],"assistant":["all"],"boards_space":["team"],"boards_personal":["all"],"restore":["team"],"directory":["team"],"frozen":["team"]}', 1, 0, 1795000000000, 1795000000000),
	('profile-guild-lead', 'guild_lead', 'Лид колодца', '{"view":["all"],"comment":["all"],"create":["all"],"edit":["stream"],"status":["no_team"],"assign":["no_team"],"dates":["no_team"],"move":["stream"],"trash":["stream"],"bulk":["stream"],"assistant":["all"],"boards_space":["own"],"boards_personal":["all"],"restore":["own_deleted"],"directory":["stream"],"frozen":["stream"]}', 1, 0, 1795000000000, 1795000000000),
	('profile-member', 'member', 'Участник', '{"view":["all"],"comment":["all"],"create":["all"],"edit":["team"],"status":["team"],"assign":["team"],"dates":["team"],"move":["team"],"trash":["own_queued"],"boards_personal":["all"],"restore":["own_deleted"],"directory":["own"]}', 1, 0, 1795000000000, 1795000000000),
	('profile-observer', 'observer', 'Наблюдатель', '{"view":["all"],"comment":["all"],"boards_personal":["all"]}', 1, 0, 1795000000000, 1795000000000);
--> statement-breakpoint
-- Выдача: кто (человек, команда, колодец, ПМ команды, лид колодца, все) × где (пространство, ветка, значение измерения) × профиль.
-- У team_pm и guild_lead пустой subject_id значит «ПМ любой команды» / «лид любого колодца»: права берутся из карточки группы.
CREATE TABLE `access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_kind` text NOT NULL CHECK (`subject_kind` IN ('person', 'team', 'guild', 'team_pm', 'guild_lead', 'everyone')),
	`subject_id` text,
	`space_id` text REFERENCES `spaces`(`id`) ON DELETE cascade,
	`branch_id` text REFERENCES `tickets`(`id`) ON DELETE cascade,
	`field_key` text,
	`field_value` text,
	`profile_id` text NOT NULL REFERENCES `access_profiles`(`id`) ON DELETE cascade,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	CHECK ((`subject_kind` IN ('person', 'team', 'guild') AND `subject_id` IS NOT NULL) OR (`subject_kind` = 'everyone' AND `subject_id` IS NULL) OR `subject_kind` IN ('team_pm', 'guild_lead')),
	CHECK ((`field_key` IS NULL) = (`field_value` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `access_grants_subject_idx` ON `access_grants` (`subject_kind`, `subject_id`);
--> statement-breakpoint
CREATE INDEX `access_grants_space_idx` ON `access_grants` (`space_id`);
--> statement-breakpoint
-- Участники пространств YT-01 становятся выдачами: владелец → админ пространства, участник → участник.
INSERT INTO `access_grants` (`id`, `subject_kind`, `subject_id`, `space_id`, `profile_id`, `is_test`, `created_at`)
SELECT lower(hex(randomblob(16))), 'person', m.`user_id`, m.`space_id`,
	CASE m.`role` WHEN 'owner' THEN 'profile-space-admin' ELSE 'profile-member' END, s.`is_test`, m.`created_at`
FROM `space_members` m JOIN `spaces` s ON s.`id` = m.`space_id`;
--> statement-breakpoint
-- Стартовые выдачи по R-2.16: Производство — фичекоманды и колодцы, Инфраструктура — все, Core — ПМы и лиды, Дирекция — только выданные лично.
INSERT OR IGNORE INTO `access_grants` (`id`, `subject_kind`, `subject_id`, `space_id`, `profile_id`, `is_test`, `created_at`) VALUES
	('grant-production-everyone', 'everyone', NULL, 'space-production', 'profile-member', 0, 1795000000000),
	('grant-production-pm', 'team_pm', NULL, 'space-production', 'profile-team-pm', 0, 1795000000000),
	('grant-production-lead', 'guild_lead', NULL, 'space-production', 'profile-guild-lead', 0, 1795000000000),
	('grant-infrastructure-everyone', 'everyone', NULL, 'space-infrastructure', 'profile-member', 0, 1795000000000),
	('grant-core-pm', 'team_pm', NULL, 'space-core', 'profile-team-pm', 0, 1795000000000),
	('grant-core-lead', 'guild_lead', NULL, 'space-core', 'profile-guild-lead', 0, 1795000000000);
--> statement-breakpoint
DROP TABLE `space_members`;
--> statement-breakpoint
-- Видимость тикета: пусто — наследуется, open — явно открыт (снимает ограничения предков), title_only, hidden.
ALTER TABLE `tickets` ADD COLUMN `visibility` text CHECK (`visibility` IS NULL OR `visibility` IN ('open', 'title_only', 'hidden'));
--> statement-breakpoint
-- Кто допущен к содержимому тикета с ограниченной видимостью: люди, команды, колодцы.
CREATE TABLE `ticket_visibility_allow` (
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`subject_kind` text NOT NULL CHECK (`subject_kind` IN ('person', 'team', 'guild')),
	`subject_id` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `subject_kind`, `subject_id`)
);
--> statement-breakpoint
-- Действующие ограничения тикета (вычисляются по дереву): тикет-источник с явной ограниченной видимостью.
CREATE TABLE `ticket_restrictions` (
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`source_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	PRIMARY KEY(`ticket_id`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_restrictions_source_idx` ON `ticket_restrictions` (`source_id`);
--> statement-breakpoint
-- Маска полей: поле скрыто от профиля. Зритель видит поле, если хотя бы один его профиль у тикета не скрывает его.
CREATE TABLE `field_masks` (
	`field_id` text NOT NULL REFERENCES `ticket_fields`(`id`) ON DELETE cascade,
	`profile_id` text NOT NULL REFERENCES `access_profiles`(`id`) ON DELETE cascade,
	PRIMARY KEY(`field_id`, `profile_id`)
);
--> statement-breakpoint
-- «Смотреть как» и «Режим показа» действуют в одной сессии; роль режима показа запоминается у человека.
ALTER TABLE `sessions` ADD COLUMN `lens_kind` text CHECK (`lens_kind` IS NULL OR `lens_kind` IN ('profile', 'person'));
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `lens_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `lens_show` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `show_profile_id` text REFERENCES `access_profiles`(`id`) ON DELETE set null;
--> statement-breakpoint
-- Журнал безопасности (R-3.2): выдача прав, смена видимости, экспорт, «Смотреть как». Только дописывается.
CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text REFERENCES `users`(`id`),
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_events_at_idx` ON `security_events` (`at`);
--> statement-breakpoint
CREATE TRIGGER `security_events_no_update` BEFORE UPDATE ON `security_events`
BEGIN
	SELECT RAISE(ABORT, 'security log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `security_events_no_delete` BEFORE DELETE ON `security_events`
BEGIN
	SELECT RAISE(ABORT, 'security log is append-only');
END;
