# YourTask layout repairs — 2026-11-23

Scope: fix shared geometry, overlapping layers and control borders while retaining the YourWiki palette and typography.

## Reproduced defects and repairs

- Notification panel at 390px started at x=-138px. Anchor it to the topbar rather than the bell button and constrain its height to the viewport. Close it on outside pointer/focus so header panels do not overlap.
- First-use role selection replaced its trigger and widened the mobile header. Keep the trigger in place and show a separate bounded panel. Preserve keyboard focus, Escape, second-click toggle and blur within the control.
- The tree selection toolbar stuck at y=56px underneath a header ending at y=116px. Group the topbar and role banner into one sticky header, measure its real height with ResizeObserver and offset the toolbar below it.
- The ticket description grid used a 260px minimum inside a 238px content area at 320px viewport width. Bound the grid minimum by its available width.
- Board-zone inputs became cramped. Give the table an internal horizontal scroll area and enough column width. Its absolutely positioned hidden heading escaped the static scroll container and expanded the root to 745px at a 390px viewport. Position the container relatively; verify root width 390px, root scrollX 0, internal scrollLeft 436px.
- Shared raw selects had different borders/heights from styled fields. Apply the common input dimensions and focus border to them, keep mobile input text at 16px, and align board controls at 44px.
- Wrap section/card headings, preserve gaps between converter fields/actions, align board settings fields at the top, add padding inside filter fieldsets, and give picker hints their own grid row.

## Verification

Use the existing local review database rather than production data to create long-title tickets and exercise forms. Save Playwright screenshots and geometry results in ignored `output/playwright/`.

Check the main routes at 320, 390, 768, 1024 and 1440px; account for clipping by scroll ancestors when checking control intersections. Separately exercise notification/role popovers, ticket description editing, expanded board settings and a selected/scrolled tree toolbar, including a 600px-high viewport.

Regression tests cover role chooser toggle/Escape/focus and notification closure when another header control receives focus. Run formatting, lint, TypeScript, all unit tests and a production build before deploying. Preserve the existing demo identity integration, database, attachments and rollback image on wiki-new.

## Results

The 105-case route/viewport pass found one remaining issue at `/spaces/test` on 320px: the sort selector imposed a 314.9px intrinsic minimum on a 288px grid, expanding the root to 331px. Bound the grid track and allow the sort label to wrap. Rechecked all five widths: root width equals viewport width. Four-or-more-column data tables retain a 640px readable minimum inside their scroll container; the three-column converter still fits narrow screens. Separate table checks at 320/390/1440px confirmed no root overflow. Add space between field links and starter badges, and between scale descriptions and forms.

Formatting, ESLint and TypeScript passed. Full unit tests passed: 273 API and 77 frontend. Four socket-dependent API tests initially failed under sandbox `listen EPERM`; the authorized rerun outside that network restriction passed. The final production build passed. A source reviewer found the role chooser second-click regression during the repair; it was reproduced, fixed and covered by the regression test. The follow-up review found no further concrete defects.

Published to `wiki-new` as `yourtask:2026.11.23-layout-94215803936d`. Container healthy; counts preserved (13 users, 2 tickets, 5 spaces, no comments/attachments). HTTPS asset loading, password/MFA login, superadmin role, spaces/OpenAPI and logout passed. Public Playwright checks on fields, people, estimates, notification settings and boards at 320/390/1440px confirmed matching document/viewport widths and bounded notification panels. Rollback backup: `/opt/INFRA/YourTask/backups/2026.11.23-layout-94215803936d`.
