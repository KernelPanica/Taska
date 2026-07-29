#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установите Docker Desktop или Docker Engine." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Команда 'docker compose' недоступна. Установите Docker Compose v2." >&2
  exit 1
fi

ENV_FILE=.env.quick-start
PORT=${TASKA_PORT:-8000}

if [ ! -f "$ENV_FILE" ]; then
  echo "Генерация секретов..."
  SECRETS=$(docker run --rm python:3.12-alpine python -c \
    "import secrets; print(secrets.token_hex(32)); print(secrets.token_hex(32))")
  SECRET_KEY=$(printf '%s\n' "$SECRETS" | sed -n '1p')
  SETUP_KEY=$(printf '%s\n' "$SECRETS" | sed -n '2p')

  if [ -z "$SECRET_KEY" ] || [ -z "$SETUP_KEY" ]; then
    echo "Не удалось безопасно сгенерировать ключи." >&2
    exit 1
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
TASKA_APP_NAME=Taska
TASKA_DEBUG=false
TASKA_SECRET_KEY=$SECRET_KEY
TASKA_SETUP_KEY=$SETUP_KEY
TASKA_BASE_URL=http://localhost:$PORT
TASKA_WEBAUTHN_RP_ID=localhost
TASKA_WEBAUTHN_RP_NAME=Taska
TASKA_WEBAUTHN_ORIGIN=http://localhost:$PORT
EOF
  echo "Создан $ENV_FILE с уникальными секретами."
fi

docker compose --env-file "$ENV_FILE" up --build -d

SETUP_KEY=$(sed -n 's/^TASKA_SETUP_KEY=//p' "$ENV_FILE")

echo
echo "Taska запускается: http://localhost:$PORT"
echo "Страница первичной настройки: http://localhost:$PORT/setup"
echo "Ключ создания администратора: $SETUP_KEY"
echo
echo "Логи:      docker compose logs -f taska"
echo "Остановка: docker compose down"
echo "Удалить приложение вместе с данными: docker compose down -v"
