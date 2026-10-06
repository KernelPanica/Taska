# Checkpoint 2 — Team collaboration and review

Status: implemented; awaiting user acceptance. Includes the explicitly requested
status management, private progress attachments, and invitation workflow brought
forward from later stages. Dragging and advanced Kanban remain Checkpoint 3.

## Demonstration

1. Run `sh dev.sh`. Use the generated credentials for `demo-manager`,
   `demo-member`, `demo-observer`, and `demo-admin`.
2. In a private browser window, open `/`, `/projects/`, `/roadmap/`, a task URL,
   or an attachment URL. Only the standalone sign-in screen is available.
3. As PM, open Projects → Taska → Team. Invite a participant. Copy the link;
   email is off by default. Accept it in another private browser window.
4. Create a task. Assign two members, a customer, and a watcher. Search people
   after selecting one: the selection remains. The same person may occupy all
   three roles. Only project participants appear.
5. As an unassigned member, request assignment. As PM, approve the request.
   The task appears under that member's My tasks.
6. As an assignee, start work and submit Markdown, Git links and/or files.
   The task enters the configured review column. Submitted evidence is retained;
   editing task details is blocked while it awaits review.
7. As an observer, add a comment. Edit your own comment; another member cannot
   edit or delete it. PMs may delete comments but cannot rewrite someone else's.
8. As PM, return work to an active status. Submit an updated report as the member,
   then approve it as PM. Only PMs/admins can mark reviewed tasks complete.
9. Open Notifications as the watcher. Mark an event read. Enable a test email
   backend or configure SMTP to verify optional delivery separately.
10. In Statuses, create/rename/reorder a column and observe it on the board.
    Delete a populated column with a same-category replacement. Replacing the
    review column requires an empty active replacement and preserves submissions.
11. Remove a member through Team. Their task/file access disappears immediately;
    their account, comments, and submitted evidence remain.
12. Repeat in Russian and at mobile width. Open two copies of a task; after one
    changes it, the other receives a conflict rather than overwriting newer work.

## Rules and limits

- Admins appoint PMs; PMs invite members/observers to their projects.
- PMs/admins create/delete tasks and manage assignments. Members edit assigned
  tasks, start work, and submit review evidence. Observers can read and comment.
- Default columns: To do, In progress, In review, Done. Review is active, not done.
- Empty non-review statuses can be deleted without replacement. Populated columns
  require a same-category replacement. Category changes on populated columns are
  blocked, preventing bulk completion without review.
- Files are served only through an authenticated permission check, as downloads.
  Any extension is allowed. Defaults: 50 MiB/file, 100 MiB/submission; environment
  overrides are available. No executable previews, remote fetching or virus scan.
- Invitations expire after seven days and can be revoked. Existing accounts must
  sign in with the matching email. Consuming an invitation never downgrades an
  existing project membership.
- Old personal to-do rows remain stored, but their routes and UI are retired.
- The submission record is immutable through the product, except the recorded PM
  decision. This is not yet the complete audit history planned for Checkpoint 5.
- SQLite serializes writes. Project/task version checks protect stale forms;
  email sending also holds the project write lock during its bounded SMTP call.
- Notifications show the newest 100 accessible events. Outbox status/errors are
  visible in Django admin. See [EMAIL.md](EMAIL.md) for optional email and retries.

## Verification

```sh
.venv/bin/python manage.py test taska.todos taska.projects --settings=taska.test_settings
RUN_BROWSER=1 .venv/bin/python manage.py test tests.browser --settings=taska.test_settings
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/python manage.py makemigrations --check --dry-run --settings=taska.test_settings
```

Browser evidence is written to `artifacts/checkpoint2-review.png`.

## Follow-up verification

Task saves recheck status/type configuration inside the write transaction, so a
status reclassified after form validation cannot bypass review. The email worker
also skips tasks deleted between claiming and loading a queued notification,
without stopping delivery of unrelated events. Both cases have regression checks.

## Готовность этапа 2

Отмечены реализованные пункты, подтверждённые автоматическими проверками.
Это техническая готовность, а не отметка о приёмке командой.

- [x] Один или несколько исполнителей, заказчиков и наблюдателей.
- [x] Совмещение нескольких ролей одним пользователем.
- [x] Поиск участников с сохранением выбранных пользователей.
- [x] Запрос назначения себе с одобрением PM — согласованная замена прямого самоназначения.
- [x] Профиль с именем и электронной почтой.
- [x] Комментарии, редактирование собственного текста и удаление по правам.
- [x] События для наблюдателей при комментариях и изменениях задачи.
- [x] Уведомления внутри приложения; отключаемая почта, очередь и тестовый адаптер.
- [x] Удаление доступа сохраняет профиль, комментарии и результаты работы.
- [x] Серверная проверка прав, включая прямые запросы и устаревшие формы.
- [x] Дополнения по согласованному плану: проверка PM, приватные файлы, приглашения и настройка статусов.
- [x] Браузерный сценарий назначения → отчёт → комментарий → одобрение → уведомление.
- [x] Русский интерфейс и адаптивная карточка задачи.

Основание: [проверки приложения](../src/taska/projects/test_collaboration.py) и
[браузерный сценарий](../tests/browser/test_checkpoint2.py). Последняя проверка:
25 тестов приложения прошли; все три браузерных сценария прошли, сценарий этапа 2
повторно проверен после уточнения русских названий статусов.

Подробная повторная проверка: [этапы 1 и 2](REVIEW-STAGES-1-2.md).

## Acceptance

- [ ] Team demonstration reviewed.
- [ ] Feedback resolved or recorded.
- [ ] Checkpoint 2 accepted before remaining Checkpoint 3 work begins.
