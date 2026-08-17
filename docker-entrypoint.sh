#!/bin/sh
set -eu

runtime_env="${TASKA_ENV_FILE:-/data/taska.env}"
if [ ! -s "$runtime_env" ]; then
  env | grep '^TASKA_' | grep -v '^TASKA_ENV_FILE=' > "$runtime_env"
fi

# Runtime configuration is read from the persistent file so GUI edits are not
# shadowed by the bootstrap environment on subsequent restarts.
unset TASKA_APP_NAME TASKA_DEBUG TASKA_SECRET_KEY TASKA_DATABASE_URL TASKA_BASE_URL
unset TASKA_SETUP_KEY TASKA_WEBAUTHN_RP_ID TASKA_WEBAUTHN_RP_NAME TASKA_WEBAUTHN_ORIGIN
unset TASKA_GITHUB_CLIENT_ID TASKA_GITHUB_CLIENT_SECRET
unset TASKA_TELEGRAM_BOT_TOKEN TASKA_TELEGRAM_BOT_USERNAME
unset TASKA_DISCORD_CLIENT_ID TASKA_DISCORD_CLIENT_SECRET

exec python -m taska.main
