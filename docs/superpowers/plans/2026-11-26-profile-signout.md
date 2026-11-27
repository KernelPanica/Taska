# Profile-only sign out

Remove the sidebar's entire duplicate account/avatar/role/logout footer; keep Me → Profile navigation. Place the existing localized Sign out action on the current user's own PersonPage only. Other people's profile pages must not show it. Preserve pending state and server session revocation.

The frontend logout hook previously cleared local authentication on API failure. Clear authentication only after a successful logout; keep the signed-in profile and show an error on failure. No backend or OIDC changes.

Implementation ownership: eo_routine_developer (configured gpt-6-luna, medium), AppShell, PersonPage, hooks.ts and focused tests. Orchestrator owns integration e2e assertions/docs/deployment. Update the old admin e2e footer-badge assertion to assert actual role/MFA and setup visibility; add a real own/other-profile/logout scenario.

Verification: formatting, ESLint, TypeScript, production build and all 82 frontend tests passed. All 7 authentication/profile e2e scenarios passed, including real session invalidation after own-profile sign out and absent sign out on another profile. Role functionality is checked via actual API role/MFA and setup visibility, not the removed footer badge.

Continuation checkpoint: implementation and checks complete; preparing wiki-new image `yourtask:2026.11.26-profile-dd6a3604fb26`. Uploaded `/tmp/yourtask-profile-{prepare,activate}.sh`; prepare is running with log `/tmp/yourtask-profile-prepare.log`. Once verified, activate using the existing full-backup/rollback script, then run public asset/health checks and update `/opt/INFRA/YourTask/DEPLOYMENT.md`. Preserve current production OIDC env, sessions and ticket data. No unfinished agents; routine developer complete. Do not rebuild or repeat passed suites unless source changes.

## Deployment checkpoint

Prepared image `yourtask:2026.11.26-profile-dd6a3604fb26` verified. Last confirmed live image remains `yourtask:2026.11.26-sidebar-e860aa69ec2e` healthy. Activation connection timed out before remote execution; inspect actual state before retrying. See 2026-11-26-shared-context.md for exact continuation.

## Confirmed production result

2026-11-26: activated yourtask:2026.11.26-panel-33f9ae6f761c, healthy. Public /health ok and 4 compiled asset SHA256 checks passed. Backup /opt/INFRA/YourTask/backups/2026.11.26-panel-33f9ae6f761c. SQLite integrity/FKs passed; counts preserved15 users/3 tickets/5 spaces/0 comments/0 attachments. Deployment recorded remotely. Current user request complete; do not deploy old profile image. No active agents.
