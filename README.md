# Taska

Django workspace built against [Taska-Roadmap.md](Taska-Roadmap.md) and
[DESIGN.md](DESIGN.md): dark surfaces, blue actions, English/Russian UI.

**Current scope: Checkpoint 4, ready for review.** Private project task tracking
with PM-controlled assignments and completion, progress reports/files, comments,
watcher notifications, invitation-based access and configurable Kanban columns.
My tasks lists assigned project issues. Email is optional and disabled by default.
Kanban supports dragging, persisted ordering, keyboard/touch controls, metadata
filters and conflict detection; PMs can move tasks directly without confirmation. Task descriptions are Markdown
pages with inline editing and separate metadata. Tasks support relations, blocking,
parent/child hierarchies and completion progress.

## One-command local demo

Requires Python 3.11+ with venv/pip and an internet connection for installation.

```sh
sh dev.sh
```

Open http://127.0.0.1:8000/login/ and use `demo-manager`, `demo-member`, `demo-observer` or
`demo-admin`. Their generated passwords are in the local `.demo-credentials.json`
file (owner-readable only, ignored by Git and Docker). Never deploy demo mode.

The script installs runtime dependencies, migrates `demo.sqlite3`, seeds the empty
TASKA project and starts a loopback server. Rerunning does not reset accounts or
project records. Demo data is separate from the regular `db.sqlite3` database.

See [the checkpoint demonstration](docs/CHECKPOINT-4.md) for the full scenario and
optional sample issues. [Architecture](docs/ARCHITECTURE.md) records domain, API,
access rules and deferred features. The review guide tracks checkpoint acceptance.

## Local setup

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

This uses `db.sqlite3` (or exported `TASKA_DATABASE_PATH`). No demo users are created.
Use `/admin/` to create projects and appoint project managers. New projects get
a board, Task/Bug/Request/Story/Epic types and To do / In progress / In review / Done columns. PMs use
Team to invite members/observers and Statuses to configure the board.
Members work on assigned tasks and submit evidence; PMs approve completion.
Observers can read and comment. Accounts require an invitation or admin creation.

## Docker

```sh
sh quick-start.sh
docker compose exec taska python manage.py createsuperuser
```

The script creates `.env` with a random secret if absent. For manual setup, copy
`.env.example` and replace the placeholder secret. Open http://localhost:8000.
`TASKA_PORT` changes the published port. Logs: `docker compose logs -f taska`.
Stop with `docker compose down`. SQLite persists at `/data/django.sqlite3` in the
`taska-data` volume; private uploads persist at `/data/uploads`. Migrations run before Gunicorn starts; WhiteNoise serves assets.

For public deployment set `TASKA_DEBUG=false`, a unique `TASKA_SECRET_KEY`, explicit
`TASKA_ALLOWED_HOSTS` (retain localhost for health checks) and the appropriate
`TASKA_CSRF_TRUSTED_ORIGINS`. Terminate TLS at a trusted proxy; configure Django's
`SECURE_PROXY_SSL_HEADER` only when that proxy strips untrusted forwarded headers,
then enable `TASKA_HTTPS=true`. Run Django's `check --deploy` and back up data first.
Never set `TASKA_DEMO_MODE=true` on a deployed installation.

## API

Session-authenticated read endpoints:

- `/api/projects/`
- `/api/projects/TASKA/`
- `/api/projects/TASKA/issues/`

The clean TASKA demo returns `{"issues": []}`. Errors use
`{"error": {"code": "…", "message": "…"}}` with meaningful HTTP status codes.
Hidden projects return 404. `/health` checks database connectivity.
The read API is intended for checkpoint-sized datasets, not production migration.

## Verification

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/python manage.py test taska.todos taska.projects --settings=taska.test_settings
PYTHONPATH=src .venv/bin/python tests/check_persistence.py
.venv/bin/python manage.py makemigrations --check --dry-run --settings=taska.test_settings
.venv/bin/python manage.py collectstatic --noinput
.venv/bin/python -m playwright install chromium
RUN_BROWSER=1 .venv/bin/python manage.py test tests.browser --settings=taska.test_settings
```

Tests use an isolated database. Browser tests cover all three checkpoint flows at four
viewport sizes, Russian, keyboard focus, reduced motion and core color contrast.
CI runs format, migration, integration and browser checks automatically.

## Languages

Use EN/RU in the header. Browser language supplies the initial preference; the
selection persists in a cookie. Native Django form messages and dates are localized;
user-entered titles are preserved. System fonts include Cyrillic support without
external font requests. Catalogs are bundled in Docker and Python packages.
After editing translations (GNU gettext required):

```sh
python manage.py makemessages -l ru --ignore=.venv --ignore=staticfiles --no-wrap
python manage.py compilemessages -l ru --ignore=.venv
```

## Optional email

Taska runs without any email service. Use your SMTP provider or the separate,
opt-in `bash setup-mail.sh` installer. See [email setup and delivery](docs/EMAIL.md).
Nothing installs or starts SMTP during normal Taska startup.

## Data

Migrations preserve existing records, including retired private to-do rows. Back up
the database and private upload directory together before updates. Existing members
are not automatically promoted to PMs.
Taiga import is planned for Checkpoint 7 in [Taska-Roadmap.md](Taska-Roadmap.md).
