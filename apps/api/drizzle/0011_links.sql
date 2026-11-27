-- YT-12: связи между тикетами и блок ссылок (R-2.13, R-2.24, R-2.40, R-2.17; docs/adr/0018).
-- Тип связи читается с двух сторон: со стороны «откуда» — name («блокирует»), со стороны «куда» — inverse_name
-- («заблокирован»). Симметричный тип («связан с») читается одинаково. Родитель/ребёнок — иерархия (ADR 0015), не связь.
CREATE TABLE `link_types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`inverse_name` text NOT NULL,
	`symmetric` integer DEFAULT 0 NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_types_key_unique` ON `link_types` (`key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `link_types` (`id`, `key`, `name`, `inverse_name`, `symmetric`, `is_system`, `is_test`, `created_at`, `updated_at`) VALUES
	('link-relates', 'relates', 'Связан с', 'Связан с', 1, 1, 0, 1795040000000, 1795040000000),
	('link-blocks', 'blocks', 'Блокирует', 'Заблокирован', 0, 1, 0, 1795040000000, 1795040000000),
	('link-duplicates', 'duplicates', 'Дублирует', 'Дублируется', 0, 1, 0, 1795040000000, 1795040000000),
	('link-clones', 'clones', 'Клонирован из', 'Клонирован в', 0, 1, 0, 1795040000000, 1795040000000),
	('link-causes', 'causes', 'Вызывает', 'Вызван', 0, 1, 0, 1795040000000, 1795040000000);
--> statement-breakpoint
-- Связь хранится один раз и видна с обеих сторон. Удаление связи не трогает тикеты.
CREATE TABLE `ticket_links` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL REFERENCES `link_types`(`id`),
	`from_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`to_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`created_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	CHECK (`from_id` <> `to_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_links_unique` ON `ticket_links` (`type_id`, `from_id`, `to_id`);
--> statement-breakpoint
CREATE INDEX `ticket_links_to_idx` ON `ticket_links` (`to_id`);
--> statement-breakpoint
-- Блок ссылок: любой адрес с заголовком страницы или документ YourWiki (по id документа; название — живое, из API).
CREATE TABLE `ticket_web_links` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`kind` text NOT NULL CHECK (`kind` IN ('web', 'yourwiki')),
	`url` text NOT NULL,
	`document_id` text,
	`title` text,
	`title_fetched_at` integer,
	`position` real NOT NULL,
	`created_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	CHECK ((`kind` = 'yourwiki') = (`document_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `ticket_web_links_ticket_idx` ON `ticket_web_links` (`ticket_id`, `position`);
--> statement-breakpoint
-- Заглушка YourWiki для разработки и автотестов (как заглушка YourSpace, docs/adr/0003): документы, доступ, запросы.
CREATE TABLE `dev_yourwiki_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL CHECK (`state` IN ('active', 'trashed', 'deleted')),
	`open_to_all` integer DEFAULT 1 NOT NULL,
	`original_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dev_yourwiki_access` (
	`document_id` text NOT NULL REFERENCES `dev_yourwiki_documents`(`id`) ON DELETE cascade,
	`subject` text NOT NULL,
	`original` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_id`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `dev_yourwiki_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL REFERENCES `dev_yourwiki_documents`(`id`) ON DELETE cascade,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Токен доступа YourSpace в сессии (зашифрован ключом сервера): YourWiki по WK-02 узнаёт человека только по нему.
ALTER TABLE `sessions` ADD COLUMN `yourspace_token` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `yourspace_token_expires_at` integer;
--> statement-breakpoint
-- Запросы доступа к документам, отправленные из YourTask: WK-02 не отдаёт их состояние, помним сами для «Запрос отправлен».
CREATE TABLE `yourwiki_access_requests` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`url` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `url`)
);
