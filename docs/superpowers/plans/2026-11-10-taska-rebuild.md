# Taska Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить Python MVP полноценной self-hosted Taska на Fastify, React и SQLite с командами, Issue-шаблонами, Kanban/Scrum и однофайловыми плагинами.

**Architecture:** Модульный монолит в npm workspaces. Fastify использует общие доменные сервисы и версионируемый plugin SDK; React использует те же контракты и mutations для всех представлений. Один production-контейнер хранит БД, вложения и плагины в `/data`.

**Tech Stack:** TypeScript strict, Node LTS, Fastify, React, Vite, SQLite, better-sqlite3, Drizzle ORM, Zod, TanStack Query, dnd-kit, Phosphor, Vitest, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-10-taska-rebuild-design.md`

## Global Constraints

- Один контейнер Taska, один Node-процесс, SQLite в `/data`; PostgreSQL, Redis и worker не добавлять.
- TypeUI Enterprise: dark theme, modular grids, glass-like panels, subtle gradients, soft shadows, IBM Plex Sans и токены из `DESIGN.md`.
- Все представления Issue используют один IssueService на сервере и `useIssueMutations` на клиенте.
- Только стандартные поля в шаблонах; никаких JQL, custom-field builder и публичной регистрации.
- Плагины доверенные ESM; auth UI создаётся ядром декларативно.
- Все списки API пагинируются; списки более 100 элементов на клиенте виртуализируются.
- Initial JS ≤ 200 KiB gzip; Lighthouse desktop performance ≥ 90; проверка на 10 000 Issue.
- Не выполнять git commit без отдельного запроса пользователя.

## Review Focus

- Циклы и глубокие иерархии команд/Issue: ожидается атомарный отказ без частичной записи; тесты в Task 3 и Task 5.
- Устаревшая `version` при одновременном редактировании: ожидается `409 Conflict` без потери чужих изменений; тест в Task 5.
- Поддельный/повторный OAuth callback или чужое приглашение: ожидается отказ и отсутствие автоматической привязки email; тесты в Task 7.
- Перенос в статус чужого workflow или переполненную WIP-колонку: ожидается понятный `409/422` и откат optimistic UI; тесты в Task 4, Task 5 и Task 9.
- Большой проект и медленный запрос: ожидаются пагинация, виртуализация, отмена устаревших запросов и отсутствие полного проекта в ответе; тесты в Task 6 и Task 10.

---

### Task 1: npm workspace и production-ready каркас

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `apps/api/package.json`, `apps/web/package.json`, `packages/contracts/package.json`, `packages/plugin-sdk/package.json`
- Create: `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/tests/health.test.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/vite.config.ts`
- Delete после успешной сборки каркаса: `src/taska`, `tests`, `pyproject.toml`, `requirements*.txt`

**Interfaces:**
- Produces: `createApp(): Promise<FastifyInstance>`; `GET /health` → `{ status: "ok", version: string }`; root scripts `dev/build/lint/typecheck/test/test:e2e`.

- [ ] **Step 1:** Создать failing `health.test.ts`: `const app = await createApp(); const response = await app.inject({ method: "GET", url: "/health" }); assert.equal(response.statusCode, 200); assert.deepEqual(response.json().status, "ok"); await app.close();`.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- health`; ожидается FAIL из-за отсутствующего `createApp`.
- [ ] **Step 3:** Настроить workspaces, pinned lockfile, strict TypeScript, ESLint и Vitest; реализовать Fastify app без глобального listen в `app.ts`, listen только в `index.ts` и OpenAPI `/api/openapi.json` с UI `/api/docs`.
- [ ] **Step 4:** Создать минимальный React/Vite entry и проверить `npm run typecheck && npm test && npm run build`; ожидается PASS и отдельные JS/CSS assets.
- [ ] **Step 5:** Удалить Python MVP и обновить `.gitignore` для `node_modules`, `dist`, coverage и Playwright, сохранив ignores секретов и `/data`.

### Task 2: SQLite, миграции и локальная аутентификация

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/db/{index.ts,schema.ts,migrate.ts}`, `apps/api/drizzle/0000_initial.sql`
- Create: `apps/api/src/modules/auth/{passwords.ts,sessions.ts,service.ts,routes.ts}`, `apps/api/src/modules/setup/routes.ts`
- Create: `apps/api/tests/{migrations.test.ts,auth.test.ts,helpers.ts}`

**Interfaces:**
- Produces: `openDatabase(path: string): Database`, `migrate(db: Database): void`, `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>`.
- Produces: `POST /api/v1/setup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/me`; session cookie `taska_session`; CSRF header `x-taska-csrf`.

- [ ] **Step 1:** Написать failing tests: повторный `migrate` не меняет схему; `hashPassword` создаёт разные salts и `verifyPassword` принимает верный/отклоняет неверный пароль; setup работает один раз; login создаёт HttpOnly cookie; mutation без CSRF → 403.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- migrations auth`; ожидается FAIL из-за отсутствующих модулей.
- [ ] **Step 3:** Реализовать config с fail-fast секретами, WAL/foreign_keys, начальные таблицы users/sessions/organization/invitations и Drizzle migrations; scrypt с timing-safe comparison.
- [ ] **Step 4:** Реализовать одноразовый setup key, сессии в БД, rate limit login и CSRF; setup недоступен после создания admin.
- [ ] **Step 5:** Запустить tests двумя последовательными вызовами; ожидается PASS и одинаковый результат повторного прогона.

### Task 3: Команды, подкоманды, проекты и policy

**Files:**
- Create: `apps/api/src/modules/teams/{service.ts,routes.ts}`, `apps/api/src/modules/projects/{service.ts,policy.ts,routes.ts}`
- Create: `apps/api/tests/{teams.test.ts,permissions.test.ts,projects.test.ts}`
- Modify: `apps/api/src/db/schema.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Produces: `TeamService.create(actorId: string, input: CreateTeamInput): Team`, `TeamService.move(actorId, teamId, parentId): Team`.
- Produces: `getEffectiveRole(userId: string, projectId: string): "lead" | "member" | "viewer" | null`, `requireProjectRole(...)` для routes.

- [ ] **Step 1:** Написать failing tests: parent lead наследуется вниз; child lead не получает parent access; direct viewer не понижает inherited lead; member/viewer не управляют проектом; cycle и перемещение команды в собственного потомка → 422 с неизменным деревом; invitation accept создаёт member, а повторный accept → 410/409 без второго пользователя.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- teams permissions projects`; ожидается FAIL на отсутствующем policy.
- [ ] **Step 3:** Добавить teams/memberships/projects/project_memberships и транзакционные команды; вычислять effective role через recursive CTE, запрещая циклы и cross-project доступ.
- [ ] **Step 4:** Подключить paginated CRUD `/api/v1/teams`, `/api/v1/projects`, создание одноразовых invitation links и `POST /api/v1/invitations/:token/accept` для локального пароля; повторный accept → 410/409, все mutations проходят policy.
- [ ] **Step 5:** Запустить `npm test --workspace @taska/api -- teams permissions projects`; ожидается PASS.

### Task 4: Workflow и шаблоны Issue

**Files:**
- Create: `packages/contracts/src/{issue.ts,workflow.ts,template.ts}`
- Create: `apps/api/src/modules/workflows/{service.ts,routes.ts}`, `apps/api/src/modules/templates/{service.ts,routes.ts,builtins.ts}`
- Create: `apps/api/tests/{workflows.test.ts,templates.test.ts}`

**Interfaces:**
- Produces: `WorkflowService.validateTransition(workflowId: string, fromStatusId: string | null, toStatusId: string): void`.
- Produces: `TemplateService.resolve(projectId: string, type: IssueType, templateId?: string): ResolvedTemplate` с `requiredFields`, `defaults`, `description`, `checklists`, `workflowId`, `blocks`.

- [ ] **Step 1:** Написать failing tests: built-in Epic/Story/Task/Bug/Subtask резолвятся; template другого проекта → 404; unknown workflow/block → 422; запрещённый переход и WIP overflow → 409/422 с machine-readable code.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- workflows templates`; ожидается FAIL.
- [ ] **Step 3:** Добавить workflows/statuses/transitions/templates; статус имеет `key`, `name`, `category`, `position`, `wipLimit`; layout допускает только known blocks `description/properties/children/links/checklists/comments/attachments/activity`.
- [ ] **Step 4:** Реализовать resolve/CRUD для lead и default workflow проекта; шаблон ссылается только на workflow того же проекта.
- [ ] **Step 5:** Запустить тесты Task 4 и regression Task 2–3; ожидается PASS.

### Task 5: Единый IssueService, Activity и связи

**Files:**
- Create: `apps/api/src/modules/issues/{hierarchy.ts,service.ts,routes.ts,queries.ts}`, `apps/api/src/modules/events/bus.ts`
- Create: `apps/api/tests/{issues.test.ts,hierarchy.test.ts,activity.test.ts}`

**Interfaces:**
- Produces: `IssueService.create(actorId, input: CreateIssueInput): Issue`, `update(actorId, issueId, input: UpdateIssueInput & { version: number }): Issue`, `transition(actorId, issueId, toStatusId, version): Issue`, `assign(actorId, issueId, assigneeId, version): Issue`.
- Produces: `GET /api/v1/projects/:id/issues?cursor=&limit=&status=&type=&assignee=&q=`; ответ `{ items, nextCursor }`, максимум `limit=100`.

- [ ] **Step 1:** Написать failing tests: Epic→Task→Subtask разрешён; Task→Task, Subtask→child и cross-project parent → 422; stale version → 409; successful mutation создаёт ровно одну Activity; failed mutation не создаёт Activity.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- issues hierarchy activity`; ожидается FAIL.
- [ ] **Step 3:** Реализовать issues/issue_links/activity с транзакциями, optimistic version и централизованной проверкой hierarchy/template/permissions.
- [ ] **Step 4:** Реализовать transition через WorkflowService, cursor pagination и индексированный поиск; после commit публиковать `issue.created/updated/transitioned` в event bus.
- [ ] **Step 5:** Запустить `npm test --workspace @taska/api -- issues hierarchy activity workflows`; ожидается PASS.

### Task 6: Спринты, совместная работа, SSE и отчёты

**Files:**
- Create: `apps/api/src/modules/sprints/{service.ts,reports.ts,routes.ts}`, `apps/api/src/modules/collaboration/{service.ts,routes.ts}`, `apps/api/src/modules/events/sse.ts`
- Create: `apps/api/tests/{sprints.test.ts,collaboration.test.ts,reports.test.ts}`, `apps/api/scripts/seed.ts`

**Interfaces:**
- Produces: `SprintService.activate(actorId, sprintId): Sprint`, `IssueService.moveToSprint(actorId, issueId, sprintId | null, version): Issue`.
- Produces: comments/checklists/watchers/tags/attachments/notifications APIs, `GET /api/v1/events` SSE, `GET /api/v1/projects/:id/reports` с Burndown/Velocity.

- [ ] **Step 1:** Написать failing tests: второй active sprint → 409; Issue в двух спринтах невозможен; comment создаёт notification watchers; одинаковый tag не дублируется; deleted attachment не оставляет файл; snapshot учитывает добавление/удаление Issue и remaining points; Velocity учитывает только done.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/api -- sprints collaboration reports`; ожидается FAIL.
- [ ] **Step 3:** Реализовать спринты, ежедневные snapshots, comments/checklists/watchers/tags/notifications и atomic file+metadata handling с limit размера и allowlist MIME.
- [ ] **Step 4:** Добавить SSE с heartbeat и scoped project events, reports API и seed-скрипт 10 000 Issue без изменения production БД.
- [ ] **Step 5:** Запустить tests и seed на временной БД; ожидается PASS, paginated response ≤ 100 и отсутствие полного проекта в payload.

### Task 7: Plugin SDK и однофайловый GitHub OAuth

**Files:**
- Create: `packages/plugin-sdk/src/index.ts`, `apps/api/src/plugins/{loader.ts,context.ts}`, `plugins/github-auth.js`, `plugins/README.md`
- Create: `apps/api/tests/{plugins.test.ts,github-auth.test.ts}`, `apps/web/src/features/auth/ProviderButtons.tsx`

**Interfaces:**
- Produces: `TaskaPlugin { manifest: PluginManifest; register(context: PluginContext): void | Promise<void> }`, `loadPlugins(directory: string, context: PluginContext): Promise<PluginLoadResult[]>`.
- PluginContext: `registerAuthProvider`, `registerRoutes`, `subscribe`, `registerNavigation`, `getConfig`; `apiVersion = "1"`.

- [ ] **Step 1:** Написать failing tests: valid plugin регистрируется; wrong apiVersion/throwing plugin возвращает error, но app продолжает старт; duplicate id отклоняется; auth provider появляется в публичном списке только при полной config.
- [ ] **Step 2:** Написать failing OAuth tests: state одноразовый; callback с неверным state → 403; без invite регистрация → 403; существующий аккаунт привязывается только после authenticated link; равный email сам по себе не привязывает identity.
- [ ] **Step 3:** Запустить `npm test --workspace @taska/api -- plugins github-auth`; ожидается FAIL.
- [ ] **Step 4:** Реализовать loader и SDK; GitHub plugin использует PKCE/state, env `TASKA_GITHUB_CLIENT_ID/SECRET`, mocked fetch в tests и одноразовые invite identities.
- [ ] **Step 5:** Реализовать generic ProviderButtons и инструкцию копирования одного JS-файла в `/data/plugins`; запустить tests — ожидается PASS.

### Task 8: TypeUI Enterprise shell и доступные базовые компоненты

**Files:**
- Create: `apps/web/src/styles/{tokens.css,global.css}`, `apps/web/src/components/ui/*`, `apps/web/src/components/AppShell.tsx`, `apps/web/src/app/router.tsx`
- Create: `apps/web/src/features/auth/{LoginPage.tsx,SetupPage.tsx}`, `apps/web/src/test/*.test.tsx`

**Interfaces:**
- Produces: общие `Button`, `Input`, `Select`, `Dialog`, `Tabs`, `Card`, `Badge`, `Toast`; protected/public routes и session query.

- [ ] **Step 1:** Написать failing component tests: Dialog управляет focus и Escape; Button имеет loading/disabled semantics; form errors связаны с fields; login поддерживает paste/password manager и показывает provider buttons.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/web`; ожидается FAIL на отсутствующих компонентах.
- [ ] **Step 3:** Реализовать TypeUI Enterprise tokens/components без per-page hex, responsive shell, lazy routes и TanStack Query с отменой устаревших запросов.
- [ ] **Step 4:** Проверить axe/keyboard/reduced motion tests и production bundle; ожидается PASS, initial JS ≤ 200 KiB gzip.

### Task 9: Рабочие экраны проектов и Issue

**Files:**
- Create: `apps/web/src/features/issues/{api.ts,useIssueMutations.ts,TemplateRenderer.tsx,Board.tsx,IssuePage.tsx,IssueList.tsx}`
- Create: `apps/web/src/features/projects/{ProjectPage.tsx,Backlog.tsx,Epics.tsx,Reports.tsx}`, `apps/web/src/features/teams/TeamsPage.tsx`, `apps/web/src/features/admin/{TemplatesPage.tsx,PluginsPage.tsx}`
- Create: `apps/web/src/features/issues/*.test.tsx`, `e2e/taska.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Produces: `useIssueMutations()` с `create/update/transition/assign/moveToSprint`; `TemplateRenderer({ template, issue, mode, onChange })`; общий query invalidation и SSE hook.

- [ ] **Step 1:** Написать failing component tests: Board и IssueList вызывают одинаковый `transition`; forbidden/WIP error откатывает optimistic card; TemplateRenderer скрывает/показывает blocks по template; keyboard move равен drag move; large list использует virtualizer.
- [ ] **Step 2:** Запустить `npm test --workspace @taska/web -- issues`; ожидается FAIL.
- [ ] **Step 3:** Реализовать страницы «Моя работа», команды, проектные Board/List/Backlog/Epics/Reports, IssuePage, comments/notifications и admin templates/plugins; filters хранятся в URL.
- [ ] **Step 4:** Написать Playwright E2E полного сценария из Spec и отдельный plugin setup сценарий; сначала убедиться в FAIL при отсутствующем действии, затем подключить UI до PASS.
- [ ] **Step 5:** Проверить 375/768/1024/1440, keyboard, reduced motion, loading/empty/error, console и axe; ожидается PASS без горизонтального overflow.

### Task 10: Docker, backup/restore, документация и budgets

**Files:**
- Modify: `Dockerfile`, `compose.yaml`, `docker-entrypoint.sh`, `quick-start.sh`, `update-and-start.sh`, `.dockerignore`, `README.md`, `DESIGN.md`, `To-Do-List.md`
- Create: `apps/api/src/maintenance/backup.ts`, `apps/api/tests/backup.test.ts`, `e2e/performance.spec.ts`

**Interfaces:**
- Produces: `backupDatabase(db: Database, destination: string): Promise<void>`; documented commands `docker compose exec taska node /app/apps/api/dist/maintenance/backup.js` и restore procedure.

- [ ] **Step 1:** Написать failing backup test: создать БД, backup, изменить source, restore во временный путь и проверить исходные rows; malformed destination → ошибка без удаления source.
- [ ] **Step 2:** Реализовать SQLite online backup, non-root multi-stage Docker image, Node healthcheck, односервисный Compose, secret generation и update scripts.
- [ ] **Step 3:** Обновить README quick start, plugins, backup/restore, update и dev; привести DESIGN.md и To-Do-List.md к новой архитектуре без утверждений о Python.
- [ ] **Step 4:** Запустить `npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e`; ожидается PASS.
- [ ] **Step 5:** Запустить production Compose, health/restart/persistence, GitHub plugin installation, backup→change→restore и browser/Lighthouse на seed 10 000 Issue; ожидается health OK, сохранённые данные, initial JS ≤ 200 KiB gzip и Lighthouse ≥ 90.
- [ ] **Step 6:** Проверить `git status`, удалить только созданные проверками временные artefacts и перечислить любые невыполненные внешние проверки без заявления об их успехе.
