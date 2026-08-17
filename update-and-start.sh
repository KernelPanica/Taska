#!/bin/sh
set -eu

cd "$(dirname "$0")"

env_file="${TASKA_ENV_FILE_SOURCE:-.env}"
git pull --ff-only
TASKA_ENV_FILE_SOURCE="$env_file" docker compose --env-file "$env_file" up --build -d

echo "Taska обновлена и запущена."
