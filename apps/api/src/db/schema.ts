import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { CatalogMatch, DimensionKind, DimensionSource, Locale, LoginMethod, UserRole } from "@yourtask/contracts";

/**
 * Человек YourTask — локальная проекция человека из общего каталога YourSpace (R-2.2, docs/adr/0009).
 * Паролей и других секретов входа здесь нет (R-2.1, docs/adr/0003). Имя и почта приходят из каталога;
 * YourTask ведёт язык, норму WIP, колодцы и фичекоманды.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /**
     * Неизменяемый идентификатор аккаунта YourSpace (`sub` и id в каталоге). Пусто только у людей,
     * заведённых вручную до подключения каталога и ещё не сопоставленных (docs/adr/0009).
     */
    yourspaceSubject: text("yourspace_subject"),
    /** Контактная почта из каталога; может отсутствовать. */
    email: text("email"),
    name: text("name").notNull(),
    role: text("role").$type<UserRole>().notNull().default("member"),
    locale: text("locale").$type<Locale>().notNull().default("ru"),
    /** Личная норма WIP; логика нормы — YT-19. */
    wipLimit: integer("wip_limit"),
    /** Тестовые пользователи видны только тестовым пользователям (docs/adr/0006). */
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    /** Деактивирован в каталоге: вход закрыт, сессии отозваны, имя и история остаются (R-2.2). */
    deactivatedAt: integer("deactivated_at"),
    catalogMatch: text("catalog_match").$type<CatalogMatch>().notNull().default("unresolved"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastLoginAt: integer("last_login_at"),
    /** Роль «Режима показа», выбранная один раз (R-2.20, docs/adr/0014). */
    showProfileId: text("show_profile_id"),
  },
  (table) => [
    uniqueIndex("users_yourspace_subject_unique").on(table.yourspaceSubject),
    index("users_email_idx").on(table.email),
  ],
);

/** Кэш профиля каталога: нечувствительные поля и маски чувствительных (R-2.2). */
export const catalogProfiles = sqliteTable("catalog_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  fullName: text("full_name"),
  nickname: text("nickname"),
  telegram: text("telegram"),
  vk: text("vk"),
  city: text("city"),
  timezone: text("timezone"),
  portfolio: text("portfolio"),
  roleTitle: text("role_title"),
  membershipStatus: text("membership_status"),
  joinedAt: text("joined_at"),
  tenure: text("tenure"),
  availabilityHours: integer("availability_hours"),
  giteaLogin: text("gitea_login"),
  perforceLogin: text("perforce_login"),
  masks: text("masks").notNull().default("{}"),
  revision: integer("revision").notNull().default(0),
  syncedAt: integer("synced_at").notNull(),
});

export const catalogState = sqliteTable("catalog_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    method: text("method").$type<LoginMethod>().notNull(),
    mfa: integer("mfa", { mode: "boolean" }).notNull().default(false),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    /** «Смотреть как» / «Режим показа» в этой сессии (docs/adr/0014). */
    lensKind: text("lens_kind").$type<"profile" | "person">(),
    lensId: text("lens_id"),
    lensShow: integer("lens_show", { mode: "boolean" }).notNull().default(false),
    /** Токен доступа YourSpace (AES-GCM ключом сервера) — для вызовов YourWiki от имени человека (docs/adr/0018). */
    yourspaceToken: text("yourspace_token"),
    yourspaceTokenExpiresAt: integer("yourspace_token_expires_at"),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

/** Незавершённые входы через YourSpace: state, nonce и PKCE-верификатор. */
export const authFlows = sqliteTable("auth_flows", {
  stateHash: text("state_hash").primaryKey(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  method: text("method").$type<LoginMethod>().notNull(),
  requireMfa: integer("require_mfa", { mode: "boolean" }).notNull().default(false),
  returnTo: text("return_to").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    /** Ограничители подчинения типов включены (R-2.7, docs/adr/0010). Остальные таблицы YT-04 — в SQL. */
    enforceSubordination: integer("enforce_subordination", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("spaces_slug_unique").on(table.slug)],
);

/** Колодец — профессиональное объединение людей с лидом (R-2.14, docs/adr/0008). */
export const guilds = sqliteTable(
  "guilds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    leadId: text("lead_id").references(() => users.id, { onDelete: "set null" }),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("guilds_name_unique").on(table.name)],
);

export const guildMembers = sqliteTable(
  "guild_members",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] }), index("guild_members_user_idx").on(table.userId)],
);

/** Фичекоманда — продуктовая команда с ПМом (R-2.14, docs/adr/0008). */
export const featureTeams = sqliteTable(
  "feature_teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    pmId: text("pm_id").references(() => users.id, { onDelete: "set null" }),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("feature_teams_name_unique").on(table.name)],
);

export const featureTeamMembers = sqliteTable(
  "feature_team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => featureTeams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index("feature_team_members_user_idx").on(table.userId),
  ],
);

/** Измерение — ось для фильтров и досок (R-2.15, docs/adr/0008). */
export const dimensions = sqliteTable(
  "dimensions",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<DimensionKind>().notNull(),
    source: text("source").$type<DimensionSource>(),
    multiple: integer("multiple", { mode: "boolean" }).notNull().default(false),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("dimensions_key_unique").on(table.key)],
);

export const dimensionOptions = sqliteTable(
  "dimension_options",
  {
    id: text("id").primaryKey(),
    dimensionId: text("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [uniqueIndex("dimension_options_label_unique").on(table.dimensionId, table.label)],
);
