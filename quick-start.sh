#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "Install Docker and Docker Compose first." >&2; exit 1; }
docker compose version >/dev/null
TASKA_QUICK_ENV="${TASKA_ENV_FILE_SOURCE:-.env}"
if [ ! -f "$TASKA_QUICK_ENV" ]; then
  taska_secret=$(docker run --rm python:3.12-slim python -c 'import secrets; print(secrets.token_urlsafe(50))')
  umask 077
  cat > "$TASKA_QUICK_ENV" <<ENV
TASKA_DEBUG=false
TASKA_SECRET_KEY=$taska_secret
TASKA_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
TASKA_HTTPS=false
ENV
fi
TASKA_ENV_FILE_SOURCE="$TASKA_QUICK_ENV" docker compose --env-file "$TASKA_QUICK_ENV" up --build -d
printf '\nTaska: http://localhost:%s\nCreate your first account: docker compose exec taska python manage.py createsuperuser\n' "${TASKA_PORT:-8000}"
