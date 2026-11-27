# Taska Team Workspaces and Plugin UI Design

## Назначение

Taska становится таск-трекером, организованным вокруг команд, а не множества проектов. Пользователь видит команды, подкоманды, задачи и доски команд. Механика создания и выбора проектов убирается из интерфейса; в системе остаётся один служебный проект, имя и описание которого редактируются на странице настроек сайта.

Эта версия также доводит Issue до полноценного рабочего пространства: Markdown-описание, несколько исполнителей, список наблюдателей, настройки сайта и аккаунта, а плагины получают возможность добавлять не только auth/API, но и страницы, React-компоненты и интеграции.

## Решённые подходы

### Команды вместо проектов

Выбран пользователем: командная агрегированная доска и **один** внутренний проект без пользовательской механики множества проектов. Полный перенос workflow/спринтов в команды и удаление project-схемы отклонены как опасная миграция без продуктовой выгоды.

Внутренний singleton project сохраняет существующие workflow, шаблоны, спринты, отчёты и внешние ключи. В API и БД он остаётся обязательной ссылкой; в UI не отображается как отдельная сущность. При setup он создаётся автоматически. Site Settings позволяет менять только его display name и description. Создание/удаление/выбор проектов из UI и пользовательских API удаляется.

Каждая Issue получает обязательный `teamId`. Миграция заполняет его из прежнего `project.teamId`; затем проекты консолидируются в singleton. Доска команды показывает Issue этой команды и по умолчанию всех потомков, с фильтром «только эта команда». Для каждой карточки действует workflow самой Issue. Права наследуются от родительской команды вниз; обратного доступа нет.

Старые project routes могут временно проксироваться на singleton для совместимости API/E2E, но новая навигация и представления используют `/teams/:teamId/board|list|backlog|epics|reports`.

### Workflow и board templates

На странице Templates добавляется второй тип шаблона — **Board template**. Он редактирует набор статусов, порядок, категории `todo/in_progress/done`, WIP-лимиты и допустимые переходы. Issue templates продолжают управлять типом, стандартными полями, defaults, Markdown-описанием, чек-листами и layout.

Board template выбирается для singleton workflow. Изменения должны быть транзакционными, сохранять identity существующих статусов и отклонять удаление статуса, который используется Issue. Страница Templates показывает секции Issue templates и Board template, не создавая второй механизм workflow.

### Markdown-описание

`Issue.description` остаётся текстом Markdown в БД, но UI получает редактор с Write/Preview, безопасный renderer и кнопку Export `.md`. HTML в Markdown санитизируется на клиенте перед отображением; вложения не превращаются в обязательный файл. Template description также поддерживает Markdown preview.

### Несколько исполнителей и наблюдатели

Добавляется `issue_assignees(issueId, userId, position)` с уникальной парой и транзакционным порядком. Существующий `issues.assigneeId` сохраняется как primary/contact для обратной совместимости и заполняется первым исполнителем; основной интерфейс использует `assigneeIds[]`. Общий `IssueService.assign` заменяется на `setAssignees`, сохраняя optimistic version, Activity, уведомления и серверную проверку доступа каждого пользователя.

Страница Issue показывает список исполнителей с добавлением/удалением через людей-пикер. Список наблюдателей отображается отдельным блоком с именами/email, добавлением участников для member и self watch/unwatch для viewer. Уведомления отправляются исполнителям и наблюдателям без дубликатов.

### Настройки сайта и аккаунта

`/settings/site` доступен admin/lead и содержит название организации, display name/description singleton project, публичное имя приложения и базовые настройки приглашений. Секреты и setup key там не показываются.

`/settings/account` доступен каждому пользователю и содержит display name, смену пароля, активные сессии, привязанные внешние identities и выход из других сессий. Email меняется только с подтверждением текущего пароля и уникальностью.

### Плагины с UI

Выбран пользователем формат **папки плагина**: `server.js`, `client.js` и необязательный `manifest.json`. Простой GitHub auth остаётся одним server-side `github-auth.js`.

Plugin API v2 расширяет server SDK integrations/routes/events/settings/auth и добавляет client SDK:

- `pages`: полные маршруты `/plugins/:pluginId/:path`;
- `widgets`: slots на dashboard, team board и issue sidebar;
- `navigation`: декларативные пункты с Phosphor icon name;
- `api`: scoped fetch wrapper с текущей сессией/CSRF и без доступа к env/secrets;
- `components`: общие TypeUI primitives;
- `events`: подписка на доменные события через server SDK.

`client.js` выполняется в браузере как доверенный ESM, загружаемый только после manifest/permission check. Он не получает `process.env`, файловую систему, секреты или прямой доступ к server context. Server code не отправляется в браузер. Ошибка server или client части не роняет ядро и отображается на странице Plugins. Для этой версии плагины по-прежнему доверенные и устанавливаются администратором файлами в `/data/plugins`, без marketplace/sandbox.

Эталонный пример: plugin directory `plugins/examples/team-insights` добавляет API route интеграции, страницу с графиком и issue-sidebar widget. GitHub OAuth остаётся доказательством однофайлового server plugin.

## Ограничения и non-goals

- Не создавать несколько организаций, JQL, custom-field builder, marketplace или sandbox.
- Не загружать полную доску/команду в браузер: progressive pagination и virtualization сохраняются.
- Не дублировать Issue mutations между Board/List/IssuePage/TeamPage.
- Не показывать singleton project как создаваемую сущность и не оставлять старые project filters в навигации.
- Не менять TypeUI Enterprise: dark theme, tokens, IBM Plex Sans, glass panels, Phosphor, WCAG AA.
- Не хранить секреты плагинов в client.js или передавать env в browser.

## Миграция и совместимость

1. Добавить `issues.team_id`, `issue_assignees` и site settings.
2. Создать singleton project при setup/миграции, перенести прежние workflow/templates/sprints и `project.teamId → issue.teamId`.
3. Сохранить `assigneeId` как primary legacy field и заполнить join table.
4. Заменить пользовательские project routes на team routes; старые API routes пометить compatibility-only и удалить после E2E перехода.
5. Обновить navigation, E2E, seed и production deploy.

## Уточнённые правила после builder check

Это проектные решения в рамках выбранного пользователем подхода:

- **Права:** project memberships не переносятся как отдельная модель. Каждый пользователь получает членство в команде своего прежнего проекта с той же ролью; при дубликате выбирается более широкая роль. Проектные приглашения становятся приглашениями в эту команду. Это осознанное расширение доступа в пределах одной команды; доступ вверх по иерархии не появляется.
- **Спринты:** спринт принадлежит команде через `teamId`, один active на команду. При миграции нескольких active спринтов одной команды самый ранний остаётся active, остальные становятся planned с записью migration warning. Backlog/reports команды фильтруют её и потомков; snapshots пересчитываются для командного спринта.
- **Workflow:** остаётся один global workflow singleton. Board template редактирует именно его. При миграции статусы объединяются по стабильному `key`, Issue переводится на соответствующий global status, дубликаты workflow удаляются. WIP считается глобально по status, а на командной доске дополнительно показывается счётчик загруженной команды.
- **Site/templates permissions:** Site Settings, global Issue templates и Board template доступны только organization admin. Team lead управляет составом команды и задачами команды, но не глобальными настройками.
- **Singleton и связи:** singleton project не имеет `teamId`; удаление команды с Issue запрещено до переноса этих Issue. Перенос Issue между командами требует member-доступа к обеим. Parent/link между командами разрешён при доступе к обеим сторонам; пользователь без доступа к связанной стороне видит masked card без title.
- **Plugin client contract:** `client.js` экспортирует `register(context)` и может вернуть `dispose()`. Context содержит React, TypeUI components, router/navigation, scoped `api.fetch`, текущую session, plugin config, `team`/`issue` для widgets и версию SDK. Плагин объявляет capabilities и `minimumRole`; UI скрывает недоступное, но серверные routes обязаны повторно проверять права через общий policy. Все данные проходят серверную авторизацию, client permission check только косметический.
- **Compatibility:** старый `projectId` означает singleton и не восстанавливает прежнюю область данных. Старый create без `teamId` получает 422 с migration error; legacy `assigneeId` заменяет весь список одним исполнителем, `null` очищает список. Новый API использует `assigneeIds`.
- **Plugin versions:** server-only API v1 продолжает загружаться через adapter для auth/routes/events/navigation/settings. UI capabilities требуют API v2 и формат папки.

## Проверка

- Unit/API: migration singleton, team hierarchy permissions, team board aggregation, assignee set, watcher list, board template transitions/WIP, site/account settings, plugin v2 failure isolation.
- Component: Markdown preview/sanitization/export, multiple assignees, watcher list, Board template editor, team filters, plugin page/widget host.
- E2E: setup → team/subteam → team board → custom Issue template → Markdown issue → multiple assignees/watchers → backlog/sprint/reports → site/account settings → plugin directory page/widget → GitHub auth link.
- Performance/security: 10k Issue progressive pagination, bundle ≤200 KiB initial gzip, no full team in initial response, no client-side secret exposure, Playwright console/axe/responsive checks.

## Что остаётся на builder

- Точные имена таблиц/endpoint внутри уже принятой схемы.
- Формат plugin manifest details, если он не меняет публичный контракт.
- Постепенное удаление compatibility project API после перехода всех клиентов.
- Выбор конкретной Markdown-библиотеки из уже используемых совместимых React-пакетов; renderer должен быть sanitized.
