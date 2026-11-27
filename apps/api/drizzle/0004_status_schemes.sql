-- YT-05: схемы статусов и исходы (docs/adr/0011).
-- Исходы завершённых статусов — на тип; «отменено» есть всегда.
ALTER TABLE `ticket_types` ADD COLUMN `outcomes` text DEFAULT '[{"key":"done","label":"Выполнено"},{"key":"cancelled","label":"Отменено"}]' NOT NULL
--> statement-breakpoint
UPDATE `ticket_types` SET `outcomes` = '[{"key":"fixed","label":"Исправлено"},{"key":"wont_fix","label":"Не исправляем"},{"key":"duplicate","label":"Дубль"},{"key":"cancelled","label":"Отменено"}]' WHERE `id` = 'type-bug'
--> statement-breakpoint
-- Исполнители — встроенная часть тикета (несколько человек, YT-06), а не поле типа.
DELETE FROM `ticket_type_fields` WHERE `field_id` = 'field-assignee'
--> statement-breakpoint
DELETE FROM `ticket_fields` WHERE `id` = 'field-assignee'
--> statement-breakpoint
-- Схема статусов на тип: space_id NULL — по умолчанию для всех пространств, иначе своя у пространства.
CREATE TABLE `status_schemes` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL REFERENCES `ticket_types`(`id`) ON DELETE cascade,
	`space_id` text REFERENCES `spaces`(`id`) ON DELETE cascade,
	`strict_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `status_schemes_unique` ON `status_schemes` (`type_id`, ifnull(`space_id`, ''))
--> statement-breakpoint
CREATE TABLE `scheme_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`scheme_id` text NOT NULL REFERENCES `status_schemes`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`category` text NOT NULL CHECK (`category` IN ('queue', 'in_progress', 'done')),
	`waiting` integer DEFAULT 0 NOT NULL,
	`outcomes` text DEFAULT '[]' NOT NULL,
	`requirements` text DEFAULT '[]' NOT NULL,
	`responsible_roles` text DEFAULT '[]' NOT NULL,
	`freeze_requirements` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	CHECK ((`category` = 'done') = (`outcomes` != '[]'))
)
--> statement-breakpoint
CREATE INDEX `scheme_statuses_scheme_idx` ON `scheme_statuses` (`scheme_id`, `position`)
--> statement-breakpoint
-- Стартовые схемы — R-5.1 (условия входа — таблица «Обязательно на входе»; привязка к цели и комментарии появятся с YT-07/YT-09)
INSERT OR IGNORE INTO `status_schemes` (`id`, `type_id`, `space_id`, `strict_order`, `created_at`, `updated_at`) VALUES
	('scheme-story', 'type-story', NULL, 0, 1794970000000, 1794970000000),
	('scheme-bug', 'type-bug', NULL, 0, 1794970000000, 1794970000000),
	('scheme-task', 'type-task', NULL, 0, 1794970000000, 1794970000000),
	('scheme-request', 'type-request', NULL, 0, 1794970000000, 1794970000000),
	('scheme-epic', 'type-epic', NULL, 0, 1794970000000, 1794970000000),
	('scheme-goal', 'type-goal', NULL, 0, 1794970000000, 1794970000000)
--> statement-breakpoint
INSERT OR IGNORE INTO `scheme_statuses` (`id`, `scheme_id`, `name`, `category`, `waiting`, `outcomes`, `requirements`, `responsible_roles`, `freeze_requirements`, `position`) VALUES
	('status-story-backlog', 'scheme-story', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-story-discovery', 'scheme-story', 'Discovery', 'in_progress', 0, '[]', '[{"kind": "people", "role": "assignees"}, {"kind": "field", "fieldKey": "due_date"}]', '["gd"]', 0, 1),
	('status-story-discovery-done', 'scheme-story', 'Discovery Done', 'in_progress', 1, '[]', '[{"kind": "description"}]', '["pm"]', 1, 2),
	('status-story-to-do', 'scheme-story', 'To Do', 'queue', 0, '[]', '[{"kind": "field", "fieldKey": "size"}, {"kind": "people", "role": "assignees"}, {"kind": "field", "fieldKey": "estimate_days"}, {"kind": "field", "fieldKey": "due_date"}]', '["assignees"]', 0, 3),
	('status-story-analysis', 'scheme-story', 'Analysis', 'in_progress', 0, '[]', '[]', '[]', 0, 4),
	('status-story-analysis-done', 'scheme-story', 'Analysis Done', 'in_progress', 1, '[]', '[]', '[]', 0, 5),
	('status-story-design', 'scheme-story', 'Design', 'in_progress', 0, '[]', '[]', '[]', 0, 6),
	('status-story-design-done', 'scheme-story', 'Design Done', 'in_progress', 1, '[]', '[]', '[]', 0, 7),
	('status-story-creation', 'scheme-story', 'Creation', 'in_progress', 0, '[]', '[{"kind": "field", "fieldKey": "due_date"}]', '["assignees"]', 0, 8),
	('status-story-creation-done', 'scheme-story', 'Creation Done', 'in_progress', 1, '[]', '[]', '[]', 0, 9),
	('status-story-implementation', 'scheme-story', 'Implementation', 'in_progress', 0, '[]', '[{"kind": "field", "fieldKey": "due_date"}]', '["assignees"]', 0, 10),
	('status-story-implementation-done', 'scheme-story', 'Implementation Done', 'in_progress', 1, '[]', '[]', '[]', 0, 11),
	('status-story-test', 'scheme-story', 'Test', 'in_progress', 0, '[]', '[{"kind": "field", "fieldKey": "due_date"}, {"kind": "people", "role": "tester"}]', '["tester", "assignees"]', 0, 12),
	('status-story-done', 'scheme-story', 'Done', 'done', 0, '["done", "cancelled"]', '[{"kind": "checklist_done"}]', '[]', 0, 13),
	('status-bug-backlog', 'scheme-bug', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-bug-discovery', 'scheme-bug', 'Discovery', 'in_progress', 0, '[]', '[{"kind": "people", "role": "assignees"}, {"kind": "field", "fieldKey": "due_date"}]', '["gd"]', 0, 1),
	('status-bug-discovery-done', 'scheme-bug', 'Discovery Done', 'in_progress', 1, '[]', '[]', '["pm"]', 0, 2),
	('status-bug-to-do', 'scheme-bug', 'To Do', 'queue', 0, '[]', '[{"kind": "description"}, {"kind": "people", "role": "assignees"}]', '["assignees"]', 0, 3),
	('status-bug-implementation', 'scheme-bug', 'Implementation', 'in_progress', 0, '[]', '[]', '["assignees"]', 0, 4),
	('status-bug-implementation-done', 'scheme-bug', 'Implementation Done', 'in_progress', 1, '[]', '[]', '[]', 0, 5),
	('status-bug-test', 'scheme-bug', 'Test', 'in_progress', 0, '[]', '[{"kind": "people", "role": "tester"}]', '["tester"]', 0, 6),
	('status-bug-done', 'scheme-bug', 'Done', 'done', 0, '["fixed", "wont_fix", "duplicate", "cancelled"]', '[]', '[]', 0, 7),
	('status-task-backlog', 'scheme-task', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-task-to-do', 'scheme-task', 'To Do', 'queue', 0, '[]', '[]', '[]', 0, 1),
	('status-task-creation', 'scheme-task', 'Creation', 'in_progress', 0, '[]', '[]', '[]', 0, 2),
	('status-task-done', 'scheme-task', 'Done', 'done', 0, '["done", "cancelled"]', '[]', '[]', 0, 3),
	('status-request-backlog', 'scheme-request', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-request-to-do', 'scheme-request', 'To Do', 'queue', 0, '[]', '[]', '[]', 0, 1),
	('status-request-creation', 'scheme-request', 'Creation', 'in_progress', 0, '[]', '[]', '[]', 0, 2),
	('status-request-done', 'scheme-request', 'Done', 'done', 0, '["done", "cancelled"]', '[]', '[]', 0, 3),
	('status-epic-backlog', 'scheme-epic', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-epic-in-progress', 'scheme-epic', 'In Progress', 'in_progress', 0, '[]', '[]', '[]', 0, 1),
	('status-epic-done', 'scheme-epic', 'Done', 'done', 0, '["done", "cancelled"]', '[]', '[]', 0, 2),
	('status-goal-backlog', 'scheme-goal', 'Backlog', 'queue', 0, '[]', '[]', '[]', 0, 0),
	('status-goal-in-progress', 'scheme-goal', 'In Progress', 'in_progress', 0, '[]', '[]', '[]', 0, 1),
	('status-goal-done', 'scheme-goal', 'Done', 'done', 0, '["done", "cancelled"]', '[]', '[]', 0, 2)
