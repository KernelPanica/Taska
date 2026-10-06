#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -r requirements.txt
export TASKA_DEBUG=true TASKA_DEMO_MODE=true
export TASKA_DATABASE_PATH="$PWD/demo.sqlite3"
.venv/bin/python manage.py migrate --noinput
.venv/bin/python manage.py seed_demo
exec .venv/bin/python manage.py runserver 127.0.0.1:8000
