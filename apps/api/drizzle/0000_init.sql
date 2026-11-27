CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`yourspace_subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL CHECK (`role` IN ('admin', 'member')),
	`locale` text DEFAULT 'ru' NOT NULL CHECK (`locale` IN ('ru', 'en')),
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_yourspace_subject_unique` ON `users` (`yourspace_subject`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`method` text NOT NULL CHECK (`method` IN ('password', 'google')),
	`mfa` integer DEFAULT 0 NOT NULL,
	`user_agent` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `auth_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`method` text NOT NULL CHECK (`method` IN ('password', 'google')),
	`require_mfa` integer DEFAULT 0 NOT NULL,
	`return_to` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`is_test` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_slug_unique` ON `spaces` (`slug`);
--> statement-breakpoint
CREATE TABLE `space_members` (
	`space_id` text NOT NULL REFERENCES `spaces`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`role` text DEFAULT 'member' NOT NULL CHECK (`role` IN ('owner', 'member')),
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `space_members_user_idx` ON `space_members` (`user_id`);
