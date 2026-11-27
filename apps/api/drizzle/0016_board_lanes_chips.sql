-- YT-17: дорожки и чипы-фильтры TQL на доске (R-2.18, R-2.14; docs/adr/0023).
-- [{id, name, query}]: дорожки — сверху доски («Срочно»: priority = Urgent), чипы — «Ещё: Только люди колодца ГД».
ALTER TABLE `boards` ADD `tql_lanes` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `boards` ADD `tql_chips` text DEFAULT '[]' NOT NULL;
