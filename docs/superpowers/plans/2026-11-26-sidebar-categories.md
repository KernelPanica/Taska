# Sidebar categories

Reorganize navigation into Organization (Spaces, Boards, People, Feature teams, Guilds, Dimensions, Trash), My boards (existing dynamic boards), Me (Notifications, Sessions, Profile) and Ticket setup (existing configuration links plus API docs). Search remains a global utility above these groups.

Profile uses the signed-in user's existing `/people/:id` page. Only Profile is active on the self-profile route; People retains ancestor highlighting on other people's pages. Ticket setup heading and all its links are absent from member navigation and retained for superadmins. This is navigation visibility; existing backend permissions and catalog/type read access remain unchanged.

Localized RU/EN group labels; accessible named groups; preserve grid spacing, footer, mobile drawer and scrolling. Runtime scope: AppShell, i18n RU/EN and one sidebar group CSS rule. Add focused membership/order, role visibility and active-profile regression tests.

Implementation delegated to eo_routine_developer (configured gpt-6-luna, medium), integrated and verified by the orchestrator. Tests were observed failing before implementation and passing afterward.

Verification: formatting, ESLint, TypeScript and 79 frontend tests passed; all 8 skeleton/structure e2e scenarios passed. Real-browser local checks for member and superadmin verified exact group order/content, setup visibility, self-profile navigation and a single active link. At 320x600px neither profile nor footer overlaps; document width stays 320px. Screenshots: output/playwright/sidebar-{anna,admin}-{desktop,mobile}.png.

Deployed as yourtask:2026.11.26-sidebar-e860aa69ec2e on wiki-new. Container healthy; 15 users, 3 tickets and 5 spaces retained. Existing production OIDC config and sessions preserved. Rollback backup: /opt/INFRA/YourTask/backups/2026.11.26-sidebar-e860aa69ec2e. Runtime CSS index-DNT5U6Za.css; AppShell-DA6EKF4o.js. README navigation guidance updated separately after packaging.
