# Taska architecture — Checkpoint 4

Sources: [Taska-Roadmap.md](../Taska-Roadmap.md), [DESIGN.md](../DESIGN.md), and the
agreed Checkpoint 2 additions in [CHECKPOINT-2.md](CHECKPOINT-2.md).

Django sessions, templates, admin, SQLite, WhiteNoise and the existing safe Markdown
parser remain the stack. No SPA, frontend build, broker, or required mail service.

## Projects, spaces and boards

The roadmap calls for independent projects/spaces, not a compulsory extra company
or workspace hierarchy. A project is the boundary for membership, task IDs, types,
and statuses. “Your workspace” is the user's navigation across accessible projects;
it is not a separate shared project named “Team space”.

An issue belongs to a project. A board presents those issues and never owns a
second copy of them. Current Checkpoint 3 provides the project's default Kanban
view. Board is a distinct model; multiple configurable boards, cross-project
sources, saved filters and swimlanes belong to Checkpoint 6. That stage must keep
board ownership/configuration separate from its source projects and intersect
all results with the viewer's project memberships. A shared board must never grant
access to a source project.

Navigation goes through projects to their Kanban view; the duplicate global Boards
shortcut has been removed. No new workspace hierarchy or cross-project board
implementation is implied by this UI correction.

The issue UI is a rendered, sanitized Markdown page with metadata alongside it.
An explicit Edit button opens title/Markdown/properties on the same issue URL.
Structured metadata remains in the database for filters, ordering and later Gantt;
the description remains Markdown, not an independent document/wiki entity.

## Access

All application routes are private by default, including unresolved routes. Only
login, invitation acceptance, language switching, generic health, and UI assets
are public. Anonymous HTML redirects to login; anonymous API requests return 401.
Public authentication/error templates have no application navigation. Responses
containing application content use private/no-store caching.

A superuser can access every project. Otherwise, membership scopes every project,
issue, notification, participant choice and download. Outsiders receive 404.
PMs administer their own project's tasks, statuses, invitations, assignments and
member/observer roles. Only superusers appoint PMs. Members edit assigned tasks;
observers read/comment. All participants edit their own comments; PMs/admins may
delete comments. Staff status alone does not confer project access.

## State and concurrency

Issues retain permanent project IDs, validated metadata, tags and optimistic
versions. Shared workflow functions enforce permissions inside atomic writes.
A project version serializes task/configuration changes; stale task and project
forms return 409. Task edits retain entered text on conflict; action errors retain
submitted comment/report text. Files must be selected again after a failed upload.

Members move queue work into active statuses, then submit evidence into the one
explicit active review status. Task details freeze during review. PMs approve into
done or return work to an active status. PMs can move cards directly between any configured columns without a second
confirmation. Leaving review records the decision on any pending submission;
manual PM moves do not fabricate progress reports. Members retain the evidence
submission workflow.
Populated status category changes are blocked; deletion atomically moves tasks to
a same-category replacement. Review replacement preserves the pending submission.

Participants use separate assignee/customer/watcher relations. Assignment requests
have one pending record per member/task. Membership revocation removes live task
roles without deleting users or historical comments/submissions. Old personal Todo
records and migrations remain; no product route or admin UI exposes that feature.

## Collaboration storage

Comments have author, safe Markdown body and edit version. Submissions preserve
an author's progress body, task version and private attachments, plus the PM's
review decision. Attachments use generated names beneath private MEDIA_ROOT and
are streamed only after project authorization. Files are never served through
WhiteNoise or a public media route. Task deletion cleans their storage after commit.
Full immutable activity history and generalized attachments remain Checkpoint 5.

Invitation tokens are random and stored hashed. The email outbox temporarily holds
a raw token only when queued delivery is enabled; it clears it on send/cancel.
Acceptance atomically consumes a valid invitation and creates/preserves membership.
Existing accounts must sign in with the matching email. Email profiles are unique
through application validation; Django's historical username identity remains.

Notifications are durable per-recipient events, filtered by current access.
Optional outbox delivery uses Django SMTP, bounded retries and a management command;
no worker framework. See [EMAIL.md](EMAIL.md) for operational limitations.

## Interfaces

- `/` lists project issues assigned to the current user, active or completed.
- `/profile/` edits the current user's name/email; `/notifications/` lists events.
- `/projects/<key>/team/` and `/statuses/` provide PM administration.
- Task `.../action/` accepts CSRF-protected POST forms with task version and action.
- `/attachments/<id>/` authorizes and streams a download.
- `/invitations/<token>/` accepts a valid invitation; GET never consumes it.
- `/roadmap/` and `/todos/<id>/...` are retired.
- Read-only `/api/projects/`, `/api/projects/<key>/`, and
  `/api/projects/<key>/issues/` retain their existing envelope and now expose task
  participants and edit/manage capabilities. Errors use `{error: {code, message}}`.

## Deployment and verification

Migrations preserve current data and add a review status where missing. They do
not promote existing members. Admins appoint PMs explicitly. New projects created
in Django admin get a board, all five basic issue types and four workflow statuses.
Project keys become read-only after creation, preserving issue references and URLs.

Demo mode adds a separate PM account without resetting existing users. Docker
persists SQLite and uploads together under `/data`; back up both consistently.
The standalone mail Compose stack is optional and has its own storage.

Tests cover authorization, workflow, files, invitations, notifications, failures,
Russian UI and browser flows, including 100-card Kanban boards, native dragging,
column ordering and stale-board conflicts. Board writes share the project version
and transaction lock with task actions. Position is independent of the permanent
issue number; all workflow transitions append to the destination column.
Complete audit history, migration tooling and Gantt remain deferred.


## Editor, tags and profiles

The title becomes an input in the page header when editing is opened; the permanent
project ID stays visible. Description formatting inserts Markdown markers into the
existing textarea (bold, italic, strike, code, heading, list, quote, link), and the
server's safe renderer supplies preview and read mode. No rich-text storage is used.
Project tags remain in the local database when a task is deleted and are suggested
on create/edit. Suggestions never cross project boundaries.

Watching is one subscribe/unsubscribe control. Participant avatars link to scoped
profiles. Users edit their own name, email, biography and avatar; only the user,
superusers and people sharing a project (including project task watchers) can read
the profile/image. Uploaded PNG/JPEG/WebP images are limited to 4 MiB and 16 MP,
normalized to a metadata-free PNG up to 256×256 and stored in Profile in SQLite.
The same database backup therefore includes avatars. Without an upload, the private
avatar endpoint returns an initial. No public media URL or external avatar service.

Columns are created at the end, reordered by left/right controls, edited in place
and deleted separately. A populated deletion asks where to move existing tasks.
The review checkbox explains the assignee submission → PM acceptance/return flow;
it requires the active category and remains unique per project.


## Relations and hierarchy

Relation stores source, target, kind and optimistic version. Ordinary links are
symmetric; blocking and parent/child links show the inverse label on the opposite
endpoint. One relation per pair and one parent per child keep type changes explicit.
The source/target task versions change with a relation write so stale task/relation
forms cannot silently overwrite changes. Deleting a relation never deletes tasks.

Both endpoints must be visible and both projects managed by the writer. Reads hide
relations to inaccessible projects, and parent totals disappear if any child is
hidden. Progress uses completed direct children; Bug/Request stay binary.
SQLite's serialized write precedes graph validation, which uses an iterative graph
walk. File-backed concurrency checks cover opposing simultaneous hierarchy links.
See [Checkpoint 4](CHECKPOINT-4.md) for acceptance and current limits.
