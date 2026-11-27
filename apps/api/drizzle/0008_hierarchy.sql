-- YT-09: иерархия 0…n родителей без ограничения глубины, циклы запрещены (R-2.8; docs/adr/0015).
-- Родитель и ребёнок могут быть в разных пространствах (R-2.17). position — порядок детей у родителя.
CREATE TABLE `ticket_parents` (
	`parent_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`child_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`position` real NOT NULL,
	`created_by` text REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	PRIMARY KEY(`parent_id`, `child_id`),
	CHECK (`parent_id` <> `child_id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_parents_child_idx` ON `ticket_parents` (`child_id`);
--> statement-breakpoint
-- Замыкание дерева: все пары предок–потомок (глубина — кратчайший путь). Ведёт сервер при каждой правке иерархии;
-- по нему за один запрос проверяются циклы, ветки в правах, наследование видимости, охват и свёртки.
CREATE TABLE `ticket_closure` (
	`ancestor_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`descendant_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
	`depth` integer NOT NULL,
	PRIMARY KEY(`ancestor_id`, `descendant_id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_closure_descendant_idx` ON `ticket_closure` (`descendant_id`);
--> statement-breakpoint
-- Каждый тикет — сам себе предок на глубине 0: так добавление связи — один запрос «предки × потомки».
INSERT OR IGNORE INTO `ticket_closure` (`ancestor_id`, `descendant_id`, `depth`) SELECT `id`, `id`, 0 FROM `tickets`;
