#!/bin/sh
set -eu

runtime_env="${TASKA_ENV_FILE:-/data/taska.env}"
if [ ! -f "$runtime_env" ]; then
  if [ -f /bootstrap/.env.quick-start ]; then
    cp /bootstrap/.env.quick-start "$runtime_env"
  else
    touch "$runtime_env"
  fi
fi

exec python -m taska.main
