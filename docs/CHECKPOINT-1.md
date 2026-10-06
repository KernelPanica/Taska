# Checkpoint 1 — Issue detail and editing

Status: historical Checkpoint 1 demonstration. The current role and status rules
are documented in [Checkpoint 2](CHECKPOINT-2.md); use a PM for task creation/editing.

## Demonstration

1. Run `sh dev.sh`; sign in as `demo-member` using `.demo-credentials.json`.
2. Open Projects → Taska → Create issue. Select Bug, add a title and Markdown
   description, an integer estimate, priority, comma-separated tags and dates.
3. Choose Preview description. Confirm formatting is shown and nothing is saved.
4. Create the issue; note its readable ID, type and status in the header.
5. Return to the board and click any free part of its card to open the issue.
6. Use Edit issue. Change the title, description, type, status, estimate, priority,
   tags and dates. Save, reload, and verify every value.
7. Use Issue types on the board to create a custom type with a name, color and
   icon; return to the issue editor and select it. The editor link opens types in a
   new tab so unfinished form values are retained.
8. Try an end date before the start date: the form explains the error and keeps
   the entered values. Try a long Russian title and a long Markdown description.
9. Open the editor in two tabs; save one, then the other. The second returns a
   conflict and keeps its form text rather than silently overwriting the first.
10. Choose Delete issue. Cancel once, then confirm. The issue disappears from its
    board. Create another and verify the deleted number is not reused.
11. Repeat as `demo-observer`: reading works, creation/editing/deletion/types are
    blocked by the server. Repeat the normal flow with RU selected.

## Behavior and limits

- IDs come from a persistent per-project counter, incremented atomically. An
  upgrade initializes counters above existing IDs. Explicit/seeded numbers below
  the counter are rejected, and demo reseeding does not resurrect deleted issues.
- Status/type choices are scoped to the project. A missing status defaults to its
  first queue status; a missing type uses its first configured type. The local
  demo includes Task, Bug, Request, Story and Epic.
- Tags are created by name, added and removed through the comma-separated field;
  removing a tag from an issue does not delete that tag from other issues.
- Markdown uses the parser's [web-safe preset](https://markdown-it-py.readthedocs.io/en/latest/security.html):
  raw HTML and unsafe links cannot execute. Remote image loading is disabled;
  attachment support is a later checkpoint. Description limit: 50,000 characters.
- Estimates are nonnegative integers. Status changes use the explicit edit form;
  board dragging, comments, assignments and audit are later checkpoints.
- Issue mutation is through session-authenticated, CSRF-protected HTML forms. The
  JSON API remains read-only and now includes issue metadata and version numbers.
- Deletion is permanent and requires a confirmation POST matching the current
  issue version. This stage does not claim to provide the later audit trail.

## Verification

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python manage.py migrate
.venv/bin/python manage.py test taska.todos taska.projects --settings=taska.test_settings
RUN_BROWSER=1 .venv/bin/python manage.py test tests.browser --settings=taska.test_settings
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/python manage.py makemigrations --check --dry-run --settings=taska.test_settings
```

The browser test covers create → preview → edit → reload → board card click →
confirmed deletion → next ID, Russian forms and four viewport sizes. The isolated
application tests also cover permissions, CSRF, invalid metadata, custom types,
unsafe Markdown, stale edits and stale deletion. Screenshot: `artifacts/checkpoint1-issue.png`.

## Acceptance

- [ ] Demonstrated and reviewed.
- [ ] Feedback resolved or recorded as tasks.
- [ ] Checkpoint 1 accepted; Checkpoint 2 authorized.

Повторная проверка текущей реализации: [этапы 1 и 2](REVIEW-STAGES-1-2.md).
