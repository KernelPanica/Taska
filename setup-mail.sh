#!/usr/bin/env bash
# Optional standalone SMTP installation; never sourced by normal startup.
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ "${1:-}" == "--help" ]]; then
  echo 'Usage: bash setup-mail.sh [--check]'
  echo 'Set TASKA_MAIL_HOSTNAME, TASKA_MAIL_ADDRESS, TASKA_MAIL_CERT_DIR.'
  echo 'Requires Docker Compose, public DNS/PTR, a TLS certificate and outbound port 25.'
  exit 0
fi
: "${TASKA_MAIL_HOSTNAME:?Set the public mail hostname (mail.example.com)}"
: "${TASKA_MAIL_ADDRESS:?Set the sender account (taska@example.com)}"
: "${TASKA_MAIL_CERT_DIR:?Set an absolute directory containing fullchain.pem and privkey.pem}"
[[ "$TASKA_MAIL_HOSTNAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo 'Invalid hostname.' >&2; exit 1; }
[[ "$TASKA_MAIL_ADDRESS" =~ ^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo 'Invalid sender address.' >&2; exit 1; }
[[ "$TASKA_MAIL_CERT_DIR" == /* && -r "$TASKA_MAIL_CERT_DIR/fullchain.pem" && -r "$TASKA_MAIL_CERT_DIR/privkey.pem" ]] || { echo 'Certificate files are missing or unreadable.' >&2; exit 1; }
export TASKA_MAIL_HOSTNAME TASKA_MAIL_ADDRESS TASKA_MAIL_CERT_DIR
docker compose version >/dev/null
docker compose -f compose.mail.yaml config --quiet
if [[ "${1:-}" == "--check" ]]; then
  echo 'Local configuration valid. DNS, PTR, certificate validity and port 25 must be checked on your host.'
  exit 0
fi
[[ -z "${1:-}" ]] || { echo 'Unknown argument.' >&2; exit 1; }
umask 077
mkdir -p mail-data/config mail-data/mail mail-data/state mail-data/logs
# Persist only non-secret settings; do not overwrite the existing sender password.
printf 'TASKA_MAIL_HOSTNAME=%s\nTASKA_MAIL_ADDRESS=%s\nTASKA_MAIL_CERT_DIR=%s\n' "$TASKA_MAIL_HOSTNAME" "$TASKA_MAIL_ADDRESS" "$TASKA_MAIL_CERT_DIR" > .mail.env
docker compose --env-file .mail.env -f compose.mail.yaml pull
if ! [[ -f mail-data/config/postfix-accounts.cf ]] || ! grep -Fq -- "$TASKA_MAIL_ADDRESS|" mail-data/config/postfix-accounts.cf; then
  # The upstream helper prompts for a password; it never appears in this command line.
  docker compose --env-file .mail.env -f compose.mail.yaml run --rm --no-deps mail setup email add "$TASKA_MAIL_ADDRESS"
fi
docker compose --env-file .mail.env -f compose.mail.yaml run --rm --no-deps mail setup config dkim
docker compose --env-file .mail.env -f compose.mail.yaml up -d
cat <<'TEXT'
SMTP service installed. Taska email remains OFF until explicitly configured.
Publish the DKIM TXT record under mail-data/config/opendkim/keys/.
Configure A/MX/SPF/DMARC and ask your host to set PTR to your mail hostname.
Allow inbound 25/587 and outbound 25. Restrict submission access where possible.
Set TASKA_EMAIL_ENABLED=true, TASKA_SMTP_HOST=<mail hostname>, TASKA_SMTP_PORT=587,
TASKA_SMTP_TLS=true, TASKA_SMTP_USER=<sender>, TASKA_SMTP_PASSWORD=<chosen password>,
TASKA_FROM_EMAIL=<sender>, and TASKA_PUBLIC_URL=<Taska HTTPS URL> in Taska's environment.
Schedule manage.py send_notifications every minute. See docs/EMAIL.md.
TEXT
