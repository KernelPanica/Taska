# Ticket layout repairs

Scope: AOS-3 and shared Epic/Task ticket layout, following the user's live page review. Production ticket contents remain unchanged.

## Reproduced defects

- Link relation fields differed by26px in y due to a hint below the key field; the URL action was44px below its input.
- Wrapped title/edit/delete controls occupied separate rows and squeezed long titles.
- At1024px the sidebar left a narrow main column despite having more fields than the description. Switch to a single column below1280px.
- Quick child/parent creation inherited competing flex widths and bottom alignment with uneven hint heights.

## Repairs

Use explicit ticket form classes and shared subgrid label/control/hint tracks, with column-width container queries to stack controls on narrow cards. Let title controls participate in the header's flex layout. Use an explicit grid for quick creation, keep its title full-width, and label its submit action. Keep all API, rights, ticket data, status rules and production YourSpace configuration unchanged.

## Verification

Previously reproduced against authenticated AOS-3 and local Task data. Retest final source with77 frontend tests, formatting/lint/TypeScript, existing ticket/history/hierarchy/link e2e scenarios, and responsive geometry at1734/1440/1280/1024/768/390/320px. Include long title/description/checklist, description/title editing and quick child creation. The pre-existing e2e counter assertion was ambiguous because both rollup and checklist show1 of3; scope it to the checklist section header.

Deploy through the verified database-copy, full-backup and rollback flow on wiki-new. Keep existing sessions, OIDC settings and all user data.

Final verification on 2026-11-25: formatting, ESLint, TypeScript and 77 frontend tests passed. All 6 ticket/history/hierarchy/link e2e scenarios passed after scoping the ambiguous counter. Responsive assertions passed at all 7 widths in viewing, description/child creation and title editing states, using long synthetic local content. Compared against the deployed release: only global.css, TicketPage.tsx and TicketRelations.tsx runtime sources changed.

Activated on 2026-11-26 as `yourtask:2026.11.25-ticket-ec0586523596`. Container healthy; 15 users, 3 tickets, 5 spaces and existing sessions/config preserved. Backup: `/opt/INFRA/YourTask/backups/2026.11.25-ticket-ec0586523596`. CSS: `index-B7Rn2TBC.css`, SHA256 `70e1817abd157fe16a7eb3a4c2ebe7e8df3239207f5c526887f847cb7f878cbd`. A request made during startup returned 502; rerun the public checks after health completion. The browser session from the earlier live AOS-3 review had expired after the pause; final responsive rendering was verified locally against the exact release, while public HTML/assets and OIDC are checked without requesting the user's credentials again.

Post-health public HTTPS checks from wiki-new passed: AOS-3 HTML references the new CSS, CSS SHA256 matches the verified build, health is ok, and the authentication redirect still targets the real YourSpace authorization endpoint.
