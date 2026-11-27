-- YT-04: конструктор типов, полей, шаблонов и шкал оценки (docs/adr/0010).
-- Ограничители подчинения включаются по пространству; по умолчанию выключены (R-2.7).
ALTER TABLE `spaces` ADD COLUMN `enforce_subordination` integer DEFAULT 0 NOT NULL
--> statement-breakpoint
CREATE TABLE `estimate_scales` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('ordinal', 'numeric')),
	`unit` text,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `estimate_scales_key_unique` ON `estimate_scales` (`key`)
--> statement-breakpoint
CREATE TABLE `estimate_scale_values` (
	`id` text PRIMARY KEY NOT NULL,
	`scale_id` text NOT NULL REFERENCES `estimate_scales`(`id`) ON DELETE cascade,
	`label` text NOT NULL,
	`position` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `estimate_scale_values_label_unique` ON `estimate_scale_values` (`scale_id`, `label`)
--> statement-breakpoint
-- Конвертер: space_id NULL — по умолчанию для всех пространств; value_id NULL — одна единица числовой шкалы.
CREATE TABLE `estimate_converter_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text REFERENCES `spaces`(`id`) ON DELETE cascade,
	`scale_id` text NOT NULL REFERENCES `estimate_scales`(`id`) ON DELETE cascade,
	`value_id` text REFERENCES `estimate_scale_values`(`id`) ON DELETE cascade,
	`min_days` real NOT NULL CHECK (`min_days` >= 0),
	`max_days` real NOT NULL,
	CHECK (`max_days` >= `min_days`)
)
--> statement-breakpoint
CREATE UNIQUE INDEX `estimate_converter_entries_unique` ON `estimate_converter_entries` (ifnull(`space_id`, ''), `scale_id`, ifnull(`value_id`, ''))
--> statement-breakpoint
CREATE TABLE `ticket_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('text', 'number', 'date', 'list', 'person', 'estimate', 'dimension')),
	`multiple` integer DEFAULT 0 NOT NULL,
	`scale_id` text REFERENCES `estimate_scales`(`id`),
	`dimension_id` text REFERENCES `dimensions`(`id`),
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK ((`kind` = 'estimate') = (`scale_id` IS NOT NULL)),
	CHECK ((`kind` = 'dimension') = (`dimension_id` IS NOT NULL))
)
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_fields_key_unique` ON `ticket_fields` (`key`)
--> statement-breakpoint
CREATE TABLE `ticket_field_options` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL REFERENCES `ticket_fields`(`id`) ON DELETE cascade,
	`label` text NOT NULL,
	`position` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_field_options_label_unique` ON `ticket_field_options` (`field_id`, `label`)
--> statement-breakpoint
CREATE TABLE `ticket_types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`rollups` text DEFAULT '{}' NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_types_key_unique` ON `ticket_types` (`key`)
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_types_name_unique` ON `ticket_types` (`name`)
--> statement-breakpoint
CREATE TABLE `ticket_type_fields` (
	`type_id` text NOT NULL REFERENCES `ticket_types`(`id`) ON DELETE cascade,
	`field_id` text NOT NULL REFERENCES `ticket_fields`(`id`) ON DELETE cascade,
	`position` integer NOT NULL,
	PRIMARY KEY(`type_id`, `field_id`)
)
--> statement-breakpoint
CREATE INDEX `ticket_type_fields_field_idx` ON `ticket_type_fields` (`field_id`)
--> statement-breakpoint
CREATE TABLE `ticket_type_parents` (
	`type_id` text NOT NULL REFERENCES `ticket_types`(`id`) ON DELETE cascade,
	`parent_type_id` text NOT NULL REFERENCES `ticket_types`(`id`) ON DELETE cascade,
	PRIMARY KEY(`type_id`, `parent_type_id`)
)
--> statement-breakpoint
CREATE TABLE `ticket_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL REFERENCES `ticket_types`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`checklist` text DEFAULT '[]' NOT NULL,
	`field_values` text DEFAULT '{}' NOT NULL,
	`position` integer NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_templates_name_unique` ON `ticket_templates` (`type_id`, `name`)
--> statement-breakpoint
-- Стартовые шкалы: майки XS–XL и дни; конвертер по умолчанию (R-2.26)
INSERT OR IGNORE INTO `estimate_scales` (`id`, `key`, `name`, `kind`, `unit`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('scale-tshirt', 'tshirt', 'Майки', 'ordinal', NULL, 1, 0, 1794960000000, 1794960000000),
	('scale-days', 'days', 'Дни', 'numeric', 'дн.', 1, 0, 1794960000000, 1794960000000)
--> statement-breakpoint
INSERT OR IGNORE INTO `estimate_scale_values` (`id`, `scale_id`, `label`, `position`) VALUES
	('scale-tshirt-xs', 'scale-tshirt', 'XS', 0),
	('scale-tshirt-s', 'scale-tshirt', 'S', 1),
	('scale-tshirt-m', 'scale-tshirt', 'M', 2),
	('scale-tshirt-l', 'scale-tshirt', 'L', 3),
	('scale-tshirt-xl', 'scale-tshirt', 'XL', 4)
--> statement-breakpoint
INSERT OR IGNORE INTO `estimate_converter_entries` (`id`, `space_id`, `scale_id`, `value_id`, `min_days`, `max_days`) VALUES
	('converter-default-tshirt-xs', NULL, 'scale-tshirt', 'scale-tshirt-xs', 0.5, 1),
	('converter-default-tshirt-s', NULL, 'scale-tshirt', 'scale-tshirt-s', 1, 2),
	('converter-default-tshirt-m', NULL, 'scale-tshirt', 'scale-tshirt-m', 3, 5),
	('converter-default-tshirt-l', NULL, 'scale-tshirt', 'scale-tshirt-l', 6, 10),
	('converter-default-tshirt-xl', NULL, 'scale-tshirt', 'scale-tshirt-xl', 11, 20)
--> statement-breakpoint
-- Стартовые поля
INSERT OR IGNORE INTO `ticket_fields` (`id`, `key`, `name`, `kind`, `multiple`, `scale_id`, `dimension_id`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('field-assignee', 'assignee', 'Исполнитель', 'person', 0, NULL, NULL, 1, 0, 1794960000000, 1794960000000),
	('field-team', 'team', 'Фичекоманда', 'dimension', 0, NULL, 'dimension-team', 1, 0, 1794960000000, 1794960000000),
	('field-stream', 'stream', 'Стрим', 'dimension', 0, NULL, 'dimension-stream', 1, 0, 1794960000000, 1794960000000),
	('field-due-date', 'due_date', 'Срок', 'date', 0, NULL, NULL, 1, 0, 1794960000000, 1794960000000),
	('field-size', 'size', 'Размер', 'estimate', 0, 'scale-tshirt', NULL, 1, 0, 1794960000000, 1794960000000),
	('field-estimate-days', 'estimate_days', 'Оценка в днях', 'estimate', 0, 'scale-days', NULL, 1, 0, 1794960000000, 1794960000000),
	('field-severity', 'severity', 'Серьёзность', 'list', 0, NULL, NULL, 1, 0, 1794960000000, 1794960000000)
--> statement-breakpoint
INSERT OR IGNORE INTO `ticket_field_options` (`id`, `field_id`, `label`, `position`) VALUES
	('field-severity-blocker', 'field-severity', 'Блокер', 0),
	('field-severity-critical', 'field-severity', 'Критичный', 1),
	('field-severity-normal', 'field-severity', 'Обычный', 2),
	('field-severity-minor', 'field-severity', 'Незначительный', 3)
--> statement-breakpoint
-- Стартовые типы (R-2.7; «Отсутствие» — YT-25). Свёртки — только настройки, считает YT-10
INSERT OR IGNORE INTO `ticket_types` (`id`, `key`, `name`, `color`, `icon`, `rollups`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('type-goal', 'goal', 'Цель', '#7C3AED', 'target', '{"status": true, "progress": "children", "progressByEstimate": false, "dates": true, "estimates": true}', 1, 0, 1794960000000, 1794960000000),
	('type-epic', 'epic', 'Эпик', '#9333EA', 'lightning', '{"status": true, "progress": "children", "progressByEstimate": false, "dates": true, "estimates": true}', 1, 0, 1794960000000, 1794960000000),
	('type-story', 'story', 'Стори', '#16A34A', 'book-open', '{"status": false, "progress": "both", "progressByEstimate": false, "dates": false, "estimates": true}', 1, 0, 1794960000000, 1794960000000),
	('type-task', 'task', 'Задача', '#2563EB', 'check-square', '{"status": false, "progress": "checklist", "progressByEstimate": false, "dates": false, "estimates": false}', 1, 0, 1794960000000, 1794960000000),
	('type-bug', 'bug', 'Баг', '#DC2626', 'bug', '{"status": false, "progress": "checklist", "progressByEstimate": false, "dates": false, "estimates": false}', 1, 0, 1794960000000, 1794960000000),
	('type-request', 'request', 'Реквест', '#D97706', 'megaphone', '{"status": false, "progress": "checklist", "progressByEstimate": false, "dates": false, "estimates": false}', 1, 0, 1794960000000, 1794960000000)
--> statement-breakpoint
INSERT OR IGNORE INTO `ticket_type_fields` (`type_id`, `field_id`, `position`) VALUES
	('type-goal', 'field-assignee', 0),
	('type-goal', 'field-due-date', 1),
	('type-goal', 'field-size', 2),
	('type-epic', 'field-assignee', 0),
	('type-epic', 'field-team', 1),
	('type-epic', 'field-stream', 2),
	('type-epic', 'field-due-date', 3),
	('type-epic', 'field-size', 4),
	('type-epic', 'field-estimate-days', 5),
	('type-story', 'field-assignee', 0),
	('type-story', 'field-team', 1),
	('type-story', 'field-stream', 2),
	('type-story', 'field-size', 3),
	('type-story', 'field-estimate-days', 4),
	('type-story', 'field-due-date', 5),
	('type-task', 'field-assignee', 0),
	('type-task', 'field-team', 1),
	('type-task', 'field-stream', 2),
	('type-task', 'field-estimate-days', 3),
	('type-task', 'field-due-date', 4),
	('type-bug', 'field-assignee', 0),
	('type-bug', 'field-team', 1),
	('type-bug', 'field-stream', 2),
	('type-bug', 'field-severity', 3),
	('type-bug', 'field-estimate-days', 4),
	('type-request', 'field-assignee', 0),
	('type-request', 'field-team', 1),
	('type-request', 'field-stream', 2),
	('type-request', 'field-due-date', 3)
--> statement-breakpoint
-- Стартовые шаблоны (R-2.7): «Стори», «Обычная задача», «Баг» (Инструкция по работе в Тайге, раздел 7)
INSERT OR IGNORE INTO `ticket_templates` (`id`, `type_id`, `name`, `description`, `checklist`, `field_values`, `position`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('template-story', 'type-story', 'Стори', '## Задача


## Документы
- 

## Цели
1. 

## Требования
1. 

## Список контента
- 

## Шаги производства
1. 

## Критерии приёмки
- 
', '["Документы по ссылкам прочитаны", "Критерии приёмки проверены", "Техдока и инструкция обновлены"]', '{}', 0, 1, 0, 1794960000000, 1794960000000),
	('template-task', 'type-task', 'Обычная задача', '## Что сделать


## Результат

', '[]', '{}', 0, 1, 0, 1794960000000, 1794960000000),
	('template-bug', 'type-bug', 'Баг', '## Краткое описание


## Шаги воспроизведения
1. 
2. 

## Ожидаемый результат


## Фактический результат


## Материалы
Скриншоты, видео, логи, сборка.

## Связь с фичей
Ключ фичи, после которой найден баг (связь «вызывает»).
', '[]', '{"severity": "field-severity-normal"}', 0, 1, 0, 1794960000000, 1794960000000)
