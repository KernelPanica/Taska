-- YT-15: TQL и поиск (R-2.28, R-5.3, R-3.4; docs/adr/0021).
-- Латинское системное имя команды и колодца: «team = Frogs», «stream = GD» (R-5.3). Отображаемое имя — в кавычках.
ALTER TABLE `guilds` ADD `key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `guilds_key_unique` ON `guilds` (lower(`key`)) WHERE `key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `feature_teams` ADD `key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_teams_key_unique` ON `feature_teams` (lower(`key`)) WHERE `key` IS NOT NULL;
--> statement-breakpoint
-- Старый номер Taiga: только чтение, заполняет импорт (YT-29).
ALTER TABLE `tickets` ADD `legacy_number` text;
--> statement-breakpoint
CREATE INDEX `tickets_legacy_number_idx` ON `tickets` (`legacy_number`) WHERE `legacy_number` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `tickets_space_alive_idx` ON `tickets` (`space_id`, `deleted_at`, `archived_at`);
--> statement-breakpoint
-- Полнотекст: триграммы — поиск подстроки без учёта регистра (кириллица тоже); «ё» приводится к «е».
-- Документ тикета (ключ, название, описание, старый номер) и отдельно комментарии; rowid = rowid строки-источника.
CREATE VIRTUAL TABLE `ticket_text` USING fts5(`body`, tokenize = 'trigram remove_diacritics 1');
--> statement-breakpoint
CREATE VIRTUAL TABLE `comment_text` USING fts5(`ticket_id` UNINDEXED, `body`, tokenize = 'trigram remove_diacritics 1');
--> statement-breakpoint
INSERT INTO `ticket_text` (`rowid`, `body`)
SELECT `rowid`, replace(replace(`key` || ' ' || `title` || ' ' || `description` || ' ' || coalesce(`legacy_number`, ''), 'ё', 'е'), 'Ё', 'Е')
FROM `tickets`;
--> statement-breakpoint
INSERT INTO `comment_text` (`rowid`, `ticket_id`, `body`)
SELECT `rowid`, `ticket_id`, replace(replace(`body`, 'ё', 'е'), 'Ё', 'Е') FROM `ticket_comments` WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `ticket_text_insert` AFTER INSERT ON `tickets`
BEGIN
	INSERT INTO `ticket_text` (`rowid`, `body`) VALUES (new.`rowid`,
		replace(replace(new.`key` || ' ' || new.`title` || ' ' || new.`description` || ' ' || coalesce(new.`legacy_number`, ''), 'ё', 'е'), 'Ё', 'Е'));
END;
--> statement-breakpoint
CREATE TRIGGER `ticket_text_update` AFTER UPDATE OF `key`, `title`, `description`, `legacy_number` ON `tickets`
BEGIN
	DELETE FROM `ticket_text` WHERE `rowid` = old.`rowid`;
	INSERT INTO `ticket_text` (`rowid`, `body`) VALUES (new.`rowid`,
		replace(replace(new.`key` || ' ' || new.`title` || ' ' || new.`description` || ' ' || coalesce(new.`legacy_number`, ''), 'ё', 'е'), 'Ё', 'Е'));
END;
--> statement-breakpoint
CREATE TRIGGER `ticket_text_delete` AFTER DELETE ON `tickets`
BEGIN
	DELETE FROM `ticket_text` WHERE `rowid` = old.`rowid`;
END;
--> statement-breakpoint
CREATE TRIGGER `comment_text_insert` AFTER INSERT ON `ticket_comments` WHEN new.`deleted_at` IS NULL
BEGIN
	INSERT INTO `comment_text` (`rowid`, `ticket_id`, `body`) VALUES (new.`rowid`, new.`ticket_id`, replace(replace(new.`body`, 'ё', 'е'), 'Ё', 'Е'));
END;
--> statement-breakpoint
CREATE TRIGGER `comment_text_update` AFTER UPDATE OF `body`, `deleted_at` ON `ticket_comments`
BEGIN
	DELETE FROM `comment_text` WHERE `rowid` = old.`rowid`;
	INSERT INTO `comment_text` (`rowid`, `ticket_id`, `body`)
	SELECT new.`rowid`, new.`ticket_id`, replace(replace(new.`body`, 'ё', 'е'), 'Ё', 'Е') WHERE new.`deleted_at` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `comment_text_delete` AFTER DELETE ON `ticket_comments`
BEGIN
	DELETE FROM `comment_text` WHERE `rowid` = old.`rowid`;
END;
--> statement-breakpoint
-- Сохранённые фильтры (R-2.28): личные (space_id NULL, shared 0) или общие для пространства по праву «Настраивать доски».
CREATE TABLE `saved_filters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`owner_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`space_id` text REFERENCES `spaces`(`id`) ON DELETE cascade,
	`shared` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_filters_owner_idx` ON `saved_filters` (`owner_id`);
--> statement-breakpoint
CREATE INDEX `saved_filters_space_idx` ON `saved_filters` (`space_id`, `shared`);
