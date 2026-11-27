# YourSpace-only sign-in Implementation Plan

**Goal:** One YourSpace sign-in action in YourTask; a verified first sign-in creates the local YourTask projection automatically and repeat sign-ins reuse it.

**Architecture:** Retain the existing OIDC authorization-code + PKCE adapter and subject-based provisioning. Replace the two method-specific frontend choices with one YourSpace entry. Connect wiki-new to the actual YourSpace issuer in production mode, removing the public development identity provider and revoking its existing sessions.

**Constraints:** No separate Task password or registration form; preserve tickets/attachments/users/history. Only authenticated YourSpace identities can provision users. Do not match identities by email or grant space rights on registration. Central superadmins still require MFA. Secrets remain on the server.

## Tasks

- [x] Update login tests first: exactly one YourSpace sign-in link in RU/EN, no local password or Google choice, returnTo preserved.
- [x] Add OIDC regression coverage: initially absent subject is created once and repeat login reuses the same id; failed token validation creates no account; development auth endpoints absent in production.
- [x] Implement the single action and registration explanation using existing i18n and login layout. Preserve the established backend provisioning.
- [x] Update README, user instructions and ADR with the first-login behavior and real provider setup.
- [x] Run formatting, lint, typecheck, unit tests and production build; visually inspect the login page and real redirect via Playwright.
- [x] Register a dedicated OIDC client on YourSpace if needed, retaining its credentials only server-side. Verify discovery, token and directory connectivity from the Task container.
- [x] Back up the existing Task database/configuration, activate the built image with production OIDC config, revoke old development sessions and preserve rollback assets.
- [ ] Verify the public YourSpace redirect, missing dev provider, unauthenticated API protection and data preservation. Complete a real login/registration if an authorized account session is available; otherwise request the user's sign-in only for that final check.

## Validation before activation

UI assertions failed for both former method links before the UI change, then passed. OIDC test proves one local id across first/repeat login with directory unavailable, rejects foreign signing keys without provisioning and checks production has no embedded identity endpoints. Formatting, ESLint, TypeScript and production build passed; 274 API + 77 frontend tests passed outside the socket-restricted sandbox. All 28 Playwright e2e scenarios passed. Local login layout checked at 320/390/1440px. Server connectivity check passed for production config, real OIDC discovery and all 8 YourSpace directory profiles.

## Deployment outcome

Activated on wiki-new: `yourtask:2026.11.23-sso-a72f73112dea`. Production OIDC uses `https://space.ageofsilence.net` and the dedicated `yourtask` client. Container healthy; old demo session revoked; 13 users, 2 tickets, 5 spaces retained. The real catalog event watermark is10, whereas the former dev cursor was12. A bulk resync was rejected by automatic review due to potential profile/deactivation changes; the approved safer alternative changed only the event cursor to10. No profiles were changed by that operation.

Public HTTPS checks confirmed exact YourSpace authorization redirect, PKCE S256, Secure/HttpOnly flow cookie, missing dev identity API routes and protected anonymous me. The browser showed the new single login action and reached the actual YourSpace login page. Full live callback verification awaits the user signing in there; automated first/repeat registration tests passed. Backup and rollback configuration: `/opt/INFRA/YourTask/backups/2026.11.23-sso-a72f73112dea`.
