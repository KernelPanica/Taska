-- YT-11: номер в потоке (R-2.9; docs/adr/0017). Номер — путь от верхнего предка по порядку детей: 1.3.2.
-- Ручной порядок верхних тикетов в пространстве; до первой перестановки — порядок создания.
ALTER TABLE `tickets` ADD COLUMN `root_position` real;
--> statement-breakpoint
UPDATE `tickets` SET `root_position` = `number`;
--> statement-breakpoint
-- Номера тикета: по одному на каждый путь от верхнего предка. parent_id — прямой родитель на этом пути
-- (для подписи «№ 1.3 в AOS-201»), пусто у верхних. Ведёт сервер; первое заполнение — при старте.
CREATE TABLE `ticket_numbers` (
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`number` text NOT NULL,
	`parent_id` text REFERENCES `tickets`(`id`) ON DELETE cascade,
	`sort_key` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `number`)
);
--> statement-breakpoint
CREATE INDEX `ticket_numbers_parent_idx` ON `ticket_numbers` (`parent_id`);
