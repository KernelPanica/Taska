# Optional email

Taska starts with `TASKA_EMAIL_ENABLED=false`. It installs no mail service and
makes no SMTP connection. Invitations can be copied and notifications remain in
Taska. Email is queued only while enabled; enabling it does not email old events.

## Use any SMTP service

Set these environment values, then restart Taska:

```dotenv
TASKA_EMAIL_ENABLED=true
TASKA_PUBLIC_URL=https://tasks.example.com
TASKA_SMTP_HOST=mail.example.com
TASKA_SMTP_PORT=587
TASKA_SMTP_TLS=true
TASKA_SMTP_USER=taska@example.com
TASKA_SMTP_PASSWORD=your-password
TASKA_FROM_EMAIL=taska@example.com
```

Run `python manage.py send_notifications` every minute using cron/systemd. With
Docker, run `docker compose exec -T taska python manage.py send_notifications`
from the repository directory. Normal web requests never wait for SMTP.

Outbox entries are visible in Django admin: pending, sending, sent, failed, or
cancelled. Failures retry with exponential delay, stopping after five attempts.
Use `send_notifications --retry-failed` after fixing SMTP configuration. The
command processes 50 messages per invocation by default (`--limit` changes it).

Access and invitation validity are checked again before sending. Recipients whose
access was revoked receive no task content. Error records contain exception types,
not credentials or message bodies. A worker killed after SMTP accepted a message
can cause duplicate delivery; this is an at-least-once outbox. Pending invitation
mail temporarily stores its bearer token; sending/cancelling clears it. Protect
and back up the database accordingly.

## Optional independent SMTP installation

`setup-mail.sh` provisions a **separate** Docker Mailserver stack pinned to 16.0.1.
Neither `quick-start.sh`, `dev.sh` nor Taska's normal Compose file starts it.
It sends directly to destination mail servers; no upstream provider is required.
The implementation follows the upstream [installation guide](https://docker-mailserver.github.io/docker-mailserver/latest/examples/tutorials/basic-installation/)
and [DNS authentication guide](https://docker-mailserver.github.io/docker-mailserver/latest/config/best-practices/dkim_dmarc_spf/).

Requirements: Docker Compose, a public host/IP, an owned domain, permission to
set reverse DNS, reachable outbound port 25, and a valid TLS certificate for the
mail hostname. Put `fullchain.pem` and `privkey.pem` in a dedicated directory;
renew them through your existing certificate service. Mounting symlinks whose
actual targets are outside that directory will not work.

```sh
export TASKA_MAIL_HOSTNAME=mail.example.com
export TASKA_MAIL_ADDRESS=taska@example.com
export TASKA_MAIL_CERT_DIR=/absolute/path/to/mail-certificate
bash setup-mail.sh --check
bash setup-mail.sh
```

The installer prompts for the account password through the upstream helper. It
does not print it, put it on the command line, or modify Taska's `.env`. Existing
accounts are retained on reruns. Non-secret installation settings are stored in
`.mail.env`; mail/configuration data is in ignored `mail-data/`.

Configure at your DNS/hosting provider:

- A record for `mail.example.com` pointing to the server; only add AAAA when IPv6
  delivery and reverse DNS are configured.
- MX for your sending domain pointing to the mail hostname.
- PTR for the server IP matching its mail hostname.
- SPF for the sending domain, authorizing the server (for a mail-only domain,
  `v=spf1 mx -all`; merge carefully with any existing senders).
- DKIM TXT from `mail-data/config/opendkim/keys/<domain>/mail.txt`.
- DMARC at `_dmarc.<domain>`, starting with a monitoring policy and tightening it
  after checking legitimate mail delivery.

The stack exposes 25 for SMTP and 587 for authenticated TLS submission. Configure
host/network firewalls and provider port restrictions. Docker-network clients do
not receive relay trust automatically. IMAP/POP/webmail are not published.

After publishing DNS, configure Taska's SMTP values above. Send a controlled test
invitation and check the recipient's SPF/DKIM/DMARC results. Local configuration
checks cannot verify DNS ownership, provider restrictions, or inbox delivery.
No live mail server is started during application tests.

```sh
# Status/logs, restart after certificate renewal, or stop the optional stack:
docker compose --env-file .mail.env -f compose.mail.yaml ps
docker compose --env-file .mail.env -f compose.mail.yaml logs mail
docker compose --env-file .mail.env -f compose.mail.yaml restart mail
docker compose --env-file .mail.env -f compose.mail.yaml down
```

Back up `mail-data/` separately from Taska. Updating this pinned mail image is an
operator action; review its release notes before changing the version.
