# Screenshot layout repairs — 2026-11-23

User evidence: trash filter and retention form baseline mismatch, unequal ticket-type cards, crowded sidebar account/role/logout block in dark theme.

## Causes and changes

- The grid stretched the `li`, while its card link retained its intrinsic height. At 1734px viewport width five cards measured149.8px and the wrapped Task card170.8px. Stretch the links inside flex list items and use equal grid rows. Keep badges at the bottom with auto margin.
- Nested `.inline-form` containers inherited wrapping and a220px field basis. The retention form became129px high and put Save on its second row. Introduce independent trash filter/retention containers: bottom-aligned flex, a352px retention area and a wrapping filter. At760px and below, the retention form fills the next row; its input and Save button stay aligned.
- Role badges had no icon/text gap. Add4px gap. Lay out the sidebar footer on the avatar/identity grid, align the role under the identity and align the logout icon with navigation icons. Preserve logout behavior and name/email truncation.

## Validation

Reproduced and captured before/after in dark Chromium using the local review database. Measured all card heights, control y coordinates and document widths at1734/1440/768/390/320px. All cards have the same height per viewport; desktop trash input/select/button share one y coordinate and44px height; mobile input/button share one y coordinate. No document overflow. Save screenshot artifacts under ignored `output/playwright/polish-*`.

Formatting, ESLint, TypeScript and production build;77 frontend tests. Run the skeleton and trash Playwright scenarios before publishing. Keep the live production YourSpace OIDC configuration, existing sessions and data; use the standard verified-copy/backup/rollback release flow.

Final checks:77 frontend tests and8 skeleton/trash e2e scenarios passed. The first e2e attempt lost a dynamic module because a separate build replaced dist during the run; the stable final-build rerun passed all8. Also checked shared grids on teams, dimensions and spaces.

Published `yourtask:2026.11.23-polish-7bca7c5c1071` to wiki-new. Container healthy;14 users,2 tickets,5 spaces preserved. Public YourSpace redirect/PKCE and disabled dev identity endpoints rechecked after activation. CSS `index-D6wDak5Q.css`, SHA256 `d44301bc9762158043e86ed2dc48a4077f775b1ef5de344e06f984fc10ad4380`. Rollback backup: `/opt/INFRA/YourTask/backups/2026.11.23-polish-7bca7c5c1071`.
