-- YT-10: свёртки статуса, прогресса, дат и оценок (R-2.12; docs/adr/0016). Хранятся у тикета и пересчитываются
-- сервером при изменении детей: смотрящий видит итог, даже если часть детей ему недоступна (R-2.17).
ALTER TABLE `tickets` ADD COLUMN `progress_done` real;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `progress_total` real;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `progress_percent` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `rollup_start` text;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `rollup_end` text;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `rollup_estimates` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `close_suggested` integer DEFAULT 0 NOT NULL;
