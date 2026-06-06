import type { PlanStory } from '../types';

/**
 * Story 1.2 — Workspaces (multi-tenant).
 * Faithful transcription of prodect_plan/story-1.2-workspaces.html (frozen archive).
 */
export const story_1_2: PlanStory = {
  id: '1.2',
  title: 'Workspaces (multi-tenant)',
  status: 'done',
  gitBranch: 'story/PROD-1.2-workspaces',
  descriptionMd:
    'Each user belongs to one or more workspaces. All Prodect data — projects, work items, ' +
    'revisions — is scoped to a workspace via foreign key. Multi-tenancy is enforced at the ' +
    'schema layer (Postgres Row-Level Security) *and* in the application layer (request-scoped ' +
    'middleware), so a leak requires bypassing both gates. Users invite teammates by email through ' +
    "a token-based acceptance flow that reuses Story 1.1's auth surface. Workspace settings " +
    'include a workspace-level `subtask_pr_merge_mode` column consumed by Story 1.4 ' +
    '(work-item-model) and Epic 4 (planner agent).\n\n' +
    '**Prerequisites:** Story 1.1 (Auth) must be complete — workspaces FK against `User`, the ' +
    'workspace-context middleware reads the Better-Auth session, the invite flow reuses ' +
    "Better-Auth's `Verification` token table from 1.1.3 and the `lib/email.ts` abstraction " +
    "from 1.1.6, and the invite-acceptance UI reuses Better-Auth's sign-in / sign-up flows from " +
    '1.1.5. Story 1.0.5 (Design system) must be complete before Subtask 1.2.1 (mockup) and ' +
    'Subtask 1.2.6 (switcher + settings + invite UI) — those surfaces compose canonical `Button`, ' +
    '`Input`, `Card`, `Dialog` primitives.',
  verificationRecipeMd:
    '- Open a terminal and run:\n' +
    '\n' +
    '     git checkout story/PROD-1.2-workspaces\n' +
    '     ./scripts/db-up.sh\n' +
    '     pnpm dev\n' +
    '\n' +
    '- Open http://localhost:3000 in your browser. You should be redirected to /sign-in (no ' +
    'session). Sign up with a NEW email.\n' +
    '- AUTO-WORKSPACE-ON-SIGNUP CHECK: After sign-up, you should land on /dashboard. Look at ' +
    'the top-nav: there should be a workspace switcher showing a name like "Alice\'s Workspace" ' +
    '(matching your sign-up name). Click the switcher; the dropdown should show one workspace ' +
    '(your auto-created one) with a check mark.\n' +
    '- RENAME WORKSPACE: Click "Settings" or visit /settings/workspace. In the Name card, ' +
    'change the workspace name and save. The top-nav switcher should update without a hard reload.\n' +
    '- INVITE FLOW: In the Members card, click "Invite teammates" — enter a second throwaway ' +
    'email and Send. You should see a success toast. In your terminal where `pnpm dev` is running, ' +
    'look for an [EMAIL] line containing the invite link. Open it in a private/incognito browser ' +
    "window. The invite link should land you on /sign-up (you're not signed in in the incognito " +
    'session). Sign up with that second email; you should be redirected to /invite/accept showing ' +
    '"{Inviter} invited you to join {Workspace}". Click Accept; you should land on /dashboard with ' +
    'the invited workspace active in the switcher.\n' +
    '- SWITCHER + ISOLATION SPOT-CHECK: Back in the second browser session, the switcher should ' +
    "show only ONE workspace (the one you accepted). You should NOT see the inviter's auto-created " +
    'workspace. In the first browser session, the switcher should show TWO workspaces (your renamed ' +
    'original + nothing else — the second user is a member of YOUR original, not the other way around).\n' +
    '- LEAVE WORKSPACE: In the second browser session, go to /settings/workspace, click Leave in ' +
    'the Danger zone. You should be redirected to a "create your first workspace" empty state (the ' +
    'auto-created workspace from sign-up was the one you just left? — no, the auto-created one was ' +
    "distinct; you should land in your auto-created one). The first browser session's Members card " +
    'should now show only yourself.\n' +
    '- DELETE WORKSPACE WITH DOUBLE-CONFIRMATION: Create a third throwaway workspace via the ' +
    'switcher\'s "Create workspace" entry (name: "Test Delete"). In Settings → Danger zone, click ' +
    'Delete workspace. A dialog appears asking you to type "Test Delete" to confirm. Try typing it ' +
    'wrong first — the destructive button stays disabled. Type it correctly; the button enables; ' +
    'click it. You should be redirected to your remaining workspace; the deleted one is gone from ' +
    'the switcher.\n' +
    "- ISOLATION ATTACK SPOT-CHECK (manual): From the first browser session's URL bar, try " +
    'visiting /api/workspaces/{some-other-workspace-id-you-know}/invites (find a workspace ID ' +
    "you're not a member of — e.g. from a fresh incognito sign-up). You should get a 404, not a " +
    '403, not a 200.\n' +
    '- Confirm CI is green on the Story PR (all 4 gates plus the existing Vitest suite from 1.1 ' +
    'plus the new isolation tests from 1.2.7).\n' +
    '- If all flows work, approve and merge the PR. If anything breaks, add a comment describing ' +
    'what failed and Prodect will produce a follow-up Subtask under this Story to fix it.',
  items: [
    {
      id: '1.2.1',
      title: 'Mockups: workspace switcher, settings page, invite-acceptance screen, invite email',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['1.0.5.2'],
      descriptionMd:
        'Produce viewable mockups of the four user-facing surfaces this Story adds — workspace ' +
        'switcher (top-nav widget), workspace settings page, invite-acceptance landing screen, ' +
        'and the invite email body — *before* any production React or email copy is written. ' +
        'Subsequent Subtasks (1.2.5, 1.2.6) read these mockups as their source of truth.\n\n' +
        '**Why this exists:** Design-first ordering is a load-bearing product principle ' +
        '(vision.html §13 + notes.html mistake #4). The invite flow especially benefits from ' +
        'designing the email body up-front — invites are user-to-user communication (higher ' +
        "visibility than password reset's machine-to-user) and the copy carries the workspace's " +
        'tone. Designing it later, inline with the endpoint implementation, produces forgettable ' +
        'boilerplate.\n\n' +
        "**What you'll do:** Open Pencil (or another visual prototyping tool the coding agent " +
        'can drive) and lay out the four surfaces using *only* the primitive components produced ' +
        'in 1.0.5.2 (`Button`, `Input`, `Card`, `Dialog`). The switcher composes as a dropdown ' +
        '(`Button variant="ghost"` + current workspace name + chevron, opening a menu of ' +
        'memberships with an "Invite teammates" entry pinned at the bottom). The settings page ' +
        'composes as a vertical stack of cards (Name, Members, Danger zone). The ' +
        'invite-acceptance screen composes the auth-card frame from 1.1.10 with a single-button ' +
        '"Accept invite to {Workspace}" CTA. The invite email body composes as a plain-text + ' +
        'HTML pair using the same dev-console-readable shape Story 1.1.6 established for ' +
        'password-reset emails. Save outputs to ' +
        '`/design/workspaces/{switcher,settings,invite-accept,invite-email}.pen` and PNG exports ' +
        'under the same path.\n\n' +
        "**Top-nav decision recorded here:** the top-nav frame doesn't exist yet (Story 1.5 " +
        'ships it). 1.2 ships a minimal top-nav containing only the workspace switcher and the ' +
        'user menu — the dashboard smoke route from Story 1.1.2 already needs the user menu, so ' +
        'this is incremental. Story 1.5 later expands the top-nav with project nav, search, etc. ' +
        "Document this minimal-then-expand pattern in the switcher mockup's prompt-hint notes so " +
        "1.5's design Subtask knows to compose atop, not replace.\n\n" +
        '## Acceptance criteria\n\n' +
        '- Four mockups exist: `switcher.png` (top-nav widget, closed + open states), ' +
        '`settings.png` (settings page with the three cards: Name / Members / Danger zone), ' +
        '`invite-accept.png` (the post-auth landing screen), `invite-email.png` (email body ' +
        'rendering — both HTML and a plain-text fallback variant).\n' +
        '- Each surface uses primitives from `/docs/design-system.md` exclusively — does NOT ' +
        'introduce new component patterns. The switcher composes `Button variant="ghost"` + a ' +
        'menu structure from the existing Dialog/Popover primitives.\n' +
        '- Switcher mockup shows: closed state (current workspace name + chevron), open state ' +
        '(list of memberships with check-mark on active + "Invite teammates" pinned at the bottom).\n' +
        '- Settings mockup shows: Name card (text input + Save), Members card (list of current ' +
        'members + their roles + an "Invite" button + per-row "Remove" actions), Danger zone card ' +
        '(Leave workspace + Delete workspace — with the latter requiring double-confirmation via ' +
        'Dialog).\n' +
        '- Delete-workspace double-confirmation modal designed: shows the workspace name, a text ' +
        "input asking the user to retype it to confirm, and a destructive-variant Button that's " +
        'disabled until the input matches exactly.\n' +
        '- Invite-accept mockup shows: workspace name in the headline, "{inviter.name} invited ' +
        'you to join {workspace.name}" subhead, single Accept Button. Includes an error variant ' +
        'for "This invite has expired" matching the structure of 1.1.6\'s reset-link-expired screen.\n' +
        '- Invite email mockup shows: subject line, greeting, "{inviter.name} invited you to join ' +
        '{workspace.name} on Prodect", accept link, expiry note ("This link expires in 7 days"). ' +
        'HTML and plain-text bodies both designed; the link MUST be visible unredacted in the ' +
        "plain-text body so dev/test flows can grep it (mirroring the password-reset email's " +
        'dev-console contract from 1.1.6).\n' +
        '- Error states drawn: invite expired, invite already used, invite for wrong email ' +
        "(logged-in user's email doesn't match the invite's email address).\n" +
        '- Output saved to `/design/workspaces/*.pen` + PNG exports.\n' +
        '- Reviewer can view the mockups and react before any React or email-body string is written.\n\n' +
        '## Context refs\n\n' +
        '- `/docs/design-system.md` — canonical visual reference\n' +
        '- `components/ui/Button.tsx, Input.tsx, Card.tsx, Dialog.tsx` — the primitives to compose from\n' +
        '- `/design/auth/auth-screens.pen` from Subtask 1.1.1 — the visual grammar for ' +
        'auth-adjacent surfaces (invite-acceptance reuses this card frame)\n' +
        '- `/design/auth/email-templates.png` from Subtask 1.1.6 — password-reset email shape ' +
        '(the invite email follows the same dev-console-readable contract)\n' +
        '- PRODECT.md — brand-mark deferral principle (no placeholder wordmark; the minimal ' +
        'top-nav this Subtask designs reflects that)',
    },
    {
      id: '1.2.2',
      title: 'Schema: Workspace + WorkspaceMembership tables (+ subtask_pr_merge_mode column)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.1.3'],
      descriptionMd:
        'Add the two tables that make multi-tenancy real: `Workspace` (the tenant boundary) and ' +
        '`WorkspaceMembership` (the join table that lets users belong to one or more workspaces). ' +
        'Generate the Prisma migration; verify the FKs cascade correctly. No application logic in ' +
        'this Subtask — schema only. RLS policies land in 1.2.3, the middleware that sets the ' +
        'session GUC lands in 1.2.3 too.\n\n' +
        '**Why a join table, not `User.workspaceId` single-FK:** the Story-level AC says "each ' +
        'user belongs to one or more workspaces." A single-FK shortcut would contradict the AC ' +
        'and force a migration in a later Story when the switcher needs real data to switch ' +
        'between. Per notes.html mistake #28: pick the durable industry-standard shape, never the ' +
        'shortcut. `WorkspaceMembership` is the standard B2B SaaS shape (Linear, Notion, GitHub ' +
        'all use it).\n\n' +
        '**Why an explicit `role` column despite single-role-in-v1:** same principle. Adding the ' +
        "column now with a `'member'` default costs zero runtime; omitting it would force every " +
        'existing row to gain it in a later migration when RBAC arrives, plus a sweep of every ' +
        'authorization check to learn about roles. The column exists durably; the enforcement ' +
        'gate (a role-based policy engine) is a later Story. Story-level AC bullet 5 explicitly: ' +
        '"v1 supports one role (member)" — that names the enforcement state, not the schema state.\n\n' +
        '**Why `subtask_pr_merge_mode` lives on Workspace, not User or Project:** the planner ' +
        'decision applies per-workspace (a single user might belong to a developer team workspace ' +
        'with `manual` and a non-technical team workspace with `auto`). Story 1.4 § Merge modes ' +
        "documents the consumer model. Adding the column now means Story 1.4 doesn't have to " +
        'schema-migrate when it lands.\n\n' +
        "**What you'll do:** Extend `prisma/schema.prisma` with the two models (verbatim shapes " +
        'below). Run `pnpm prisma migrate dev --name add_workspaces`. Verify the cascade behavior ' +
        'with a smoke test: create a user, create a workspace, create a membership, delete the ' +
        'workspace → membership row must be gone; delete the user → membership row must be gone. ' +
        'Add a `lib/workspaces/repo.ts` with the minimal CRUD primitives (`createWorkspace`, ' +
        '`addMember`, `removeMember`, `findUserWorkspaces`, `findMembership`) — direct-DB helpers ' +
        'for the application layers landing in 1.2.4 / 1.2.5 / 1.2.6.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Two new Prisma models exist: `Workspace` (id cuid, name string, slug string @unique, ' +
        "subtask_pr_merge_mode enum default 'manual', createdAt, updatedAt) and " +
        "`WorkspaceMembership` (id cuid, userId, workspaceId, role string default 'member', " +
        'createdAt, updatedAt; unique [userId, workspaceId]; FKs both `onDelete: Cascade`).\n' +
        '- Migration `add_workspaces` generated and applies cleanly against a fresh DB. The ' +
        'migration is reversible (Prisma generates the down-migration automatically; verify it ' +
        'executes without error against a populated DB during local smoke).\n' +
        '- `subtask_pr_merge_mode` is a Postgres enum: `SubtaskPrMergeMode { auto, manual, ' +
        "review_on_fail }`. The `review_on_fail` value exists in the enum but isn't exposed in " +
        'the settings UI yet (Story 1.4 documents it as deferred); shipping the enum value now ' +
        "avoids a schema migration when it's exposed later.\n" +
        '- `lib/workspaces/repo.ts` exports: `createWorkspace({ name, ownerUserId })` (creates ' +
        'Workspace + initial Membership in a transaction), `addMember`, `removeMember`, ' +
        '`findUserWorkspaces(userId)`, `findMembership(userId, workspaceId)`. All functions ' +
        'normalize the slug from the workspace name (lowercase, hyphenate, suffix with random ' +
        '4-char suffix on collision).\n' +
        '- Vitest integration tests in `tests/workspaces-repo.test.ts` cover: createWorkspace ' +
        'happy path, slug-collision suffix behavior, cascade-on-Workspace-delete, ' +
        'cascade-on-User-delete, unique-constraint on (userId, workspaceId) returns a typed error ' +
        'not a generic Prisma error.\n' +
        '- All 4 quality gates green: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, ' +
        '`pnpm build`. Test suite green (existing 39 tests from Story 1.1 + new tests from this ' +
        'Subtask).\n' +
        '- Schema docstring at the top of `schema.prisma` updated to mention workspaces (just ' +
        "like Story 1.1's auth-tables docstring documents that schema layer).\n\n" +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — current schema (User + Account + Session + Verification from ' +
        'Story 1.1)\n' +
        '- `lib/users/repo.ts` — the repo-layer pattern this Subtask mirrors\n' +
        '- Story 1.4 § Merge modes — documents the consumer of `subtask_pr_merge_mode`\n' +
        '- notes.html mistake #28 — durable-shapes-no-shortcuts rule (cited for ' +
        'join-table-not-single-FK, role-column-now-not-later)\n' +
        '- Prisma docs (fetched at prompt-gen time): cascade behaviors, enum types, unique ' +
        'constraints, transaction patterns',
    },
    {
      id: '1.2.3',
      title: 'Postgres RLS policies + workspace-context middleware',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['1.2.2'],
      descriptionMd:
        'The two structural gates that make multi-tenancy enforced rather than convention. ' +
        '(1) **Postgres Row-Level Security policies** on every workspace-scoped table — Workspace ' +
        'itself and WorkspaceMembership for now; future Stories add more. Each policy matches the ' +
        "row's `workspaceId` column (or, for Workspace itself, the `id` column) against the " +
        "session GUC `app.workspace_id`. Queries that don't set the GUC see no rows. " +
        '(2) **Workspace-context middleware** that runs on every authenticated request, looks up ' +
        'the active workspace, opens a Prisma `$transaction`, runs ' +
        "`SET LOCAL app.workspace_id = $1` inside it, and routes the request handler's queries " +
        'through that transaction so RLS sees the GUC.\n\n' +
        '**Why RLS at the schema layer AND middleware at the app layer:** defense-in-depth. The ' +
        'middleware sets the GUC for every legitimate request, but a bug in the middleware ' +
        '(forgotten `SET LOCAL`, dropped transaction) would silently let queries see all rows ' +
        'without RLS. RLS without middleware would force every query in the application to ' +
        'remember to set the GUC manually, which would rot within a Story. Together: the ' +
        'middleware does the right thing by default; RLS catches every bug in the middleware. The ' +
        'Story-level AC bullet phrases this as "leak is structurally impossible" — that requires ' +
        'both gates.\n\n' +
        '**Why session GUC, not Postgres role-per-workspace:** the session-GUC pattern is the ' +
        'documented Postgres-RLS-with-pooled-connections pattern. Per-workspace Postgres roles ' +
        "would explode role count and break connection pooling (PgBouncer doesn't multiplex " +
        'sessions across roles). The session GUC is set per-request, applies only to the current ' +
        'transaction (`SET LOCAL`, not `SET`), and leaves the connection clean for the next ' +
        'request. Standard pattern documented by Supabase, Neon, and the Postgres docs themselves.\n\n' +
        "**Why the middleware uses `$transaction`:** Prisma's `SET LOCAL` needs a transaction " +
        'scope to bind to. Without `$transaction`, `SET LOCAL` applies to a single statement and ' +
        'then is reset — the next query in the same request would run without the GUC. Wrapping ' +
        'the handler in `$transaction` gives every query in the request the same GUC.\n\n' +
        "**What you'll do:** Add a new Prisma migration (`add_workspace_rls`) that runs the raw " +
        'SQL: `ALTER TABLE workspace ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace_membership ' +
        'ENABLE ROW LEVEL SECURITY;` + create policies that match against ' +
        "`current_setting('app.workspace_id', true)::text` (the `true` second arg returns NULL if " +
        'the setting is missing, which the policy rejects). Also create a policy on Workspace that ' +
        'allows a user to see ALL workspaces they have a membership in (the switcher needs this — ' +
        "it queries the user's memberships to populate the menu), keyed off " +
        "`current_setting('app.user_id', true)`. Add a second session GUC `app.user_id` set " +
        'alongside `app.workspace_id`. Create `lib/workspaces/context.ts` exporting ' +
        '`withWorkspaceContext(userId, workspaceId, fn)` that opens the transaction, sets both ' +
        'GUCs, and runs `fn`. Create `lib/workspaces/middleware.ts` that resolves the active ' +
        "workspace from the cookie (or falls back to the user's first membership), and a " +
        'server-side `getWorkspaceContext()` helper for server components to read the active ' +
        'workspace.\n\n' +
        '## Acceptance criteria\n\n' +
        '- New Prisma migration `add_workspace_rls` enables RLS on `workspace` and ' +
        '`workspace_membership` tables; creates policies matching rows against ' +
        "`current_setting('app.workspace_id', true)` (and " +
        "`current_setting('app.user_id', true)` for the workspace-list-membership policy).\n" +
        '- The Workspace table has TWO policies: (a) "row.id = app.workspace_id" for queries ' +
        'within an active workspace, (b) "row.id IN (SELECT workspace_id FROM ' +
        'workspace_membership WHERE user_id = app.user_id)" for the switcher\'s listing query.\n' +
        '- WorkspaceMembership table policy: "row.workspace_id = app.workspace_id OR ' +
        'row.user_id = app.user_id" (the user can see their own memberships across workspaces — ' +
        'needed for the switcher).\n' +
        '- `lib/workspaces/context.ts` exports `withWorkspaceContext({ userId, workspaceId }, fn)` ' +
        'opening a Prisma `$transaction` that runs `SET LOCAL app.workspace_id = $1; SET LOCAL ' +
        'app.user_id = $2;` via `$executeRaw` before invoking `fn(tx)`. The function returns ' +
        'whatever `fn` returns.\n' +
        '- `lib/workspaces/middleware.ts` exports `resolveWorkspaceContext(request)` that reads ' +
        'the Better-Auth session, reads a `workspace_id` cookie (or falls back to ' +
        '`findUserWorkspaces(userId)[0]`), and returns `{ userId, workspaceId } | null`. Returns ' +
        '`null` if the user has no memberships.\n' +
        '- Server-side helper `getWorkspaceContext()` in `lib/workspaces/index.ts` reads the ' +
        "session + cookie at request time (similar shape to Story 1.1's `getSession()`).\n" +
        '- Vitest integration tests in `tests/workspace-rls.test.ts` cover: queries without the ' +
        "GUC see zero workspace rows; queries with the GUC see only the active workspace's rows; " +
        "queries against a workspace the user isn't a member of return zero rows even if the GUC " +
        'is set; cross-workspace UPDATE attempts are rejected.\n' +
        '- Vitest test for `withWorkspaceContext` verifies that `SET LOCAL` persists across ' +
        'multiple queries inside the same callback (the load-bearing reason for using ' +
        '`$transaction`).\n' +
        '- All 4 quality gates green; test suite green.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` + the latest migration from 1.2.2\n' +
        '- `lib/db.ts` — singleton Prisma client (the `$transaction` entry point)\n' +
        '- `lib/auth/index.ts` — Better-Auth instance, for the session-read pattern ' +
        '`getWorkspaceContext()` mirrors\n' +
        '- Postgres docs (fetched at prompt-gen time): row security policies, ' +
        '`current_setting()` with the missing-setting NULL fallback, `SET LOCAL` semantics within ' +
        'transactions\n' +
        '- Prisma docs (fetched at prompt-gen time): `$transaction`, `$executeRaw` + parameter ' +
        'binding, interactive transactions vs sequential\n' +
        '- Supabase RLS guide (fetched at prompt-gen time): the canonical session-GUC pattern for ' +
        'Postgres-RLS with pooled connections',
    },
    {
      id: '1.2.4',
      title: 'Auto-create default workspace on user signup (Better-Auth hook)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['1.2.2', '1.1.2'],
      descriptionMd:
        'Every authenticated user must have at least one workspace (Story-level AC bullet 1). ' +
        'Wire a Better-Auth `databaseHooks.user.create.after` hook that creates a default ' +
        'workspace named `"{user.name}\'s Workspace"` with the user as its first member, AND a ' +
        'lazy self-heal backfill so a user who somehow ends up with zero workspaces is repaired ' +
        'on next context resolution. The hook covers the user-creating sign-up paths from Story ' +
        '1.1: email/password sign-up and Google OAuth first sign-in (new user). The Google ' +
        '*linking* path — an existing email-first user signing in with Google — does NOT create a ' +
        "new `User` row (Better-Auth's native `account.accountLinking` with " +
        "`trustedProviders: ['google']` links to the existing user), so the hook correctly never " +
        'fires there and the pre-existing workspace is preserved.\n\n' +
        '**Why a hook PLUS a backfill, not a hook alone:** the obvious design is "the hook is ' +
        'atomic with user creation, so the workspace always exists." That is *not true* for ' +
        '`better-auth@1.6.11` with the Prisma adapter — verified in ' +
        '`dist/db/with-hooks.mjs`: the `create.after` hook runs sequentially *after* the user ' +
        'insert commits, with no shared transaction (the adapter exposes no `tx` to the hook). ' +
        'So a throw inside the hook leaves a committed user with no workspace — exactly the orphan ' +
        'we want to avoid. Rather than pretend the hook is transactional, design for the real ' +
        'behavior: the hook is the best-effort fast path (covers ~all signups synchronously), and ' +
        'a lazy `ensureDefaultWorkspace` backfill is the correctness backstop. This also ' +
        'future-proofs against any later sign-up path that bypasses the hook. (Logged as ' +
        'PRODECT_FINDINGS #6 — this card previously asserted false atomicity.)\n\n' +
        '**Why "{user.name}\'s Workspace" as the default name:** mirrors Linear / Notion / Slack ' +
        "defaults. The user can rename in 1.2.6's settings page anytime. The slug derives from " +
        "the workspace name via `workspacesService.createWorkspace`'s existing `slugify` + " +
        '4-char-random-suffix-on-collision logic (from 1.2.2), so cross-user name collisions ' +
        'resolve automatically.\n\n' +
        "**What you'll do:** Extend `lib/auth/index.ts`'s `betterAuth({ ... })` config with a " +
        '`databaseHooks.user.create.after` block that calls ' +
        "`workspacesService.createWorkspace({ name: \`${user.name}'s Workspace\`, ownerUserId: " +
        'user.id })` and swallows-and-logs any error (the user row is already committed; throwing ' +
        'here would 500 an otherwise-successful signup — the backfill recovers the miss). Add ' +
        '`workspacesService.ensureDefaultWorkspace({ userId, userName })` (idempotent: no-op if ' +
        'the user already has a membership; otherwise creates the default) and wire the resolver ' +
        'behind `getWorkspaceContext()` to call it when it finds no membership instead of ' +
        'returning null. Add `GET /api/workspaces/current` ' +
        '(`app/api/workspaces/current/route.ts`) — a thin route reading the session + active ' +
        'context, returning `{ workspace, membership }` via a service method + DTO (no `db.*` in ' +
        "the route, per CLAUDE.md's 4-layer rule). Add a Vitest integration test signing up fresh " +
        'users and asserting workspace + membership exist; extend ' +
        '`tests/e2e/auth-credentials.spec.ts` to assert `/api/workspaces/current` returns the ' +
        'auto-created workspace after sign-up.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/auth/index.ts` extended with `databaseHooks.user.create.after` calling ' +
        "`workspacesService.createWorkspace` with the new user's name + id. The hook is " +
        'best-effort post-commit (NOT atomic with the user insert — verified against ' +
        'better-auth@1.6.11); it swallows-and-logs errors rather than failing the signup response.\n' +
        '- `workspacesService.ensureDefaultWorkspace({ userId, userName })` exists and is ' +
        'idempotent (no-op when the user already has a membership; creates the default otherwise). ' +
        'The resolver behind `getWorkspaceContext()` calls it when it finds no membership, so a ' +
        'signed-in user is never stranded with zero workspaces — this is the correctness backstop ' +
        'for the non-atomic hook.\n' +
        '- All Story-1.1 sign-up paths behave correctly: email/password sign-up and Google OAuth ' +
        'new-user sign-up each produce exactly one workspace; the email-first-then-Google linking ' +
        "path produces NO second workspace (the pre-existing one is preserved; the hook doesn't " +
        'fire because no User is created).\n' +
        '- A `/api/workspaces/current` route handler ' +
        '(`app/api/workspaces/current/route.ts`) returns `{ workspace, membership }` for the ' +
        'active workspace context, or 401 if no session. Thin transport only — no `db.*` / ' +
        '`$transaction` in the route (4-layer rule).\n' +
        '- Default workspace name: `"{user.name}\'s Workspace"` (e.g. `"Alice\'s Workspace"`). ' +
        "Slug from `createWorkspace`'s existing slugify + 4-char-random-suffix-on-collision logic " +
        '(1.2.2).\n' +
        '- Vitest integration test in `tests/auto-workspace-on-signup.test.ts` covers: ' +
        'email/password sign-up creates a workspace; Google OAuth new-user creates a workspace; ' +
        'email-first user linking Google does NOT create a second workspace; ' +
        '`ensureDefaultWorkspace` backfills a zero-workspace user and is idempotent (calling ' +
        'twice yields one workspace).\n' +
        '- Playwright E2E spec (`tests/e2e/auth-credentials.spec.ts`) extended to assert ' +
        '`/api/workspaces/current` returns the auto-created workspace after sign-up. Existing ' +
        'assertions stay green.\n' +
        '- All 4 quality gates green; Vitest + Playwright suites green.\n\n' +
        '## Context refs\n\n' +
        '- `lib/auth/index.ts` — current Better-Auth config (email/password + ' +
        '`socialProviders.google` + native `account.accountLinking` with ' +
        "`trustedProviders: ['google']`); no `databaseHooks` yet — this Subtask adds the block\n" +
        '- `lib/services/workspacesService.ts` — `createWorkspace({ name, ownerUserId })` is the ' +
        'entry point (atomic Workspace + owner Membership, slug-collision retry). This Subtask ' +
        'adds `ensureDefaultWorkspace` here. (NOTE: the old `lib/workspaces/repo.ts` / ' +
        "`lib/users/repo.ts` referenced in pre-1.2.5 cards were deleted by 1.2.5's 4-layer " +
        'refactor.)\n' +
        '- `lib/workspaces/index.ts` + `lib/workspaces/middleware.ts` — `getWorkspaceContext()` ' +
        'and the resolver this Subtask hooks the backfill into\n' +
        '- `prodect-core/CLAUDE.md` — the 4-layer Route→Service→Repository→Prisma contract the ' +
        'new endpoint + service method must follow\n' +
        '- `tests/e2e/auth-credentials.spec.ts` + ' +
        '`tests/e2e/_helpers/{db-reset,email-capture}.ts` — the spec this Subtask extends and its ' +
        'helpers\n' +
        "- Better-Auth source (verify, don't assume): " +
        '`node_modules/better-auth/dist/db/with-hooks.mjs` — confirms `create.after` runs ' +
        'post-commit, not in a shared transaction (the reason the backfill exists)',
    },
    {
      id: '1.2.5',
      title: 'Invite endpoints: send / validate / accept (Verification table reuse)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.2.2', '1.1.6'],
      descriptionMd:
        'The server-side half of invites: an endpoint to send an invite email, an endpoint to ' +
        'validate an invite token (used by the acceptance UI on landing), and an endpoint to ' +
        'accept the invite (creates the WorkspaceMembership row, consumes the token). Token ' +
        'storage reuses the `Verification` table from Story 1.1.3 — no new `Invite` table. Email ' +
        'delivery reuses `lib/email.ts` from 1.1.6.\n\n' +
        '**Why reuse Verification, not a new Invite table:** the `Verification` table is ' +
        "Better-Auth's catch-all token primitive (`identifier` + `value` + `expiresAt`). The " +
        'password-reset flow in 1.1.6 stores reset tokens there with identifier ' +
        '`"reset-password:{token}"`. Adding workspace-invite tokens with identifier ' +
        '`"workspace-invite:{token}"` reuses the same single-use, expiry-tracking primitive — no ' +
        'new schema, no new cleanup job, no new index. The `value` column carries JSON: ' +
        '`{ workspaceId, email, role }`. This is the durable shape: Verification IS the ' +
        "project's token primitive, and Story 1.2's invites fit it.\n\n" +
        '**Why account-needed acceptance (not magic-link):** magic-link invites would require a ' +
        'new Better-Auth surface (magic-link is its own primitive, not currently wired). Adding ' +
        'it would be shortcut shape — the project would carry two auth primitives (password / ' +
        'OAuth from 1.1, plus magic-link only used for invites). Account-needed acceptance reuses ' +
        "Story 1.1's complete auth surface: the invitee signs in (or signs up) through the " +
        'existing flows, then lands on a one-click "Accept invite" screen. Decision recorded in ' +
        'PRODECT.md "Story 1.2 decisions baked in" (added in this Subtask\'s deepening pass).\n\n' +
        '**Why 7-day expiry:** matches the Linear / Slack / GitHub norm (longer than ' +
        'password-reset\'s 1-hour because invites have legitimate "I\'ll get to it later" delay; ' +
        'shorter than indefinite because expired tokens still need to be garbage-collected by the ' +
        'same cleanup the Verification table needs anyway).\n\n' +
        "**Why 3/hour rate limit per workspace per email:** mirrors Story 1.1.6's " +
        'password-reset limit pattern, keyed by (workspaceId, recipientEmail) instead of by IP. ' +
        'Prevents accidental spam from a settings-page button mashing without blocking legitimate ' +
        're-invites after an email goes to spam.\n\n' +
        "**What you'll do:** Create " +
        '`app/api/workspaces/[workspaceId]/invites/route.ts` (POST: send invite; requires active ' +
        'membership in the workspace) and `app/api/invites/[token]/route.ts` (GET: validate ' +
        'token, returns `{ workspaceName, inviterName, email }` for the acceptance UI; POST: ' +
        "accept invite, requires session whose email matches the invite's email, creates " +
        'membership, deletes the verification row). Add `lib/workspaces/invites.ts` with the ' +
        'token-shape helpers (`encodeInviteToken`, `decodeInviteToken`, `sendInviteEmail`). The ' +
        "email body renders the design from 1.2.1's invite-email mockup — both plain-text (link " +
        'unredacted) and HTML, sent via `sendEmail` from `lib/email.ts`. Rate limit implemented ' +
        'in-app (the Verification table is the source of truth; count rows with the same ' +
        'workspace+email identifier within the last hour). Comprehensive Vitest coverage: send ' +
        'invite happy path, send-to-already-member rejected, send-when-not-a-member rejected, ' +
        'accept with matching email succeeds, accept with non-matching email rejected, expired ' +
        'token rejected, single-use enforcement, rate limit triggers on 4th send.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three new route handlers exist: `POST /api/workspaces/[workspaceId]/invites` (send), ' +
        '`GET /api/invites/[token]` (validate — used by the acceptance UI on page load to render ' +
        'the workspace name and inviter), `POST /api/invites/[token]/accept` (accept).\n' +
        '- Send endpoint requires an active membership in `workspaceId`; returns 403 if the ' +
        "requesting user isn't a member. Returns 422 if the target email is already a member of " +
        'the workspace (return the duplicate-detection error inline rather than silently no-op).\n' +
        '- Invite tokens stored in `Verification` table: identifier ' +
        '`workspace-invite:{base62-token}`, value ' +
        "`JSON.stringify({ workspaceId, email: lowercased, role: 'member' })`, expiresAt now + " +
        '7 days.\n' +
        "- Email sent via `lib/email.ts`'s `sendEmail()` — subject " +
        '"You\'re invited to join {Workspace} on Prodect", plain-text body containing the accept ' +
        "link unredacted (mirroring the password-reset email's dev-console-readable contract from " +
        "1.1.6), HTML body matching 1.2.1's mockup.\n" +
        '- Accept endpoint requires an authenticated session whose `user.email` matches the ' +
        "invite's email (case-insensitive — both stored and compared lowercase). Returns 403 with " +
        'a clear "this invite is for a different email" error if mismatched (does NOT auto-link to ' +
        'a different account — the user must sign in with the invited email, or contact the ' +
        'inviter for a new invite).\n' +
        "- Accept creates a `WorkspaceMembership` row (role: 'member') and deletes the " +
        'Verification row in a transaction. Idempotent: if the user is already a member, the ' +
        'second accept returns success without creating a duplicate (the unique constraint catches ' +
        'it).\n' +
        '- Rate limit: 3 invites per hour per (workspaceId, recipientEmail). 4th attempt within ' +
        'the hour returns 429 with a clear "Already sent 3 invites recently; please wait" error.\n' +
        '- Vitest integration tests in `tests/workspace-invites.test.ts` cover all 8 cases ' +
        'listed in the description (happy path send, already-member rejection, not-a-member ' +
        'rejection, accept happy path, email-mismatch rejection, expired token, single-use, rate ' +
        'limit).\n' +
        '- All 4 quality gates green; test suite green.\n\n' +
        '## Context refs\n\n' +
        '- `lib/email.ts` + `lib/auth/index.ts` from Story 1.1 — the email abstraction and how ' +
        'Better-Auth uses Verification for reset tokens (the exact pattern to mirror)\n' +
        '- `lib/workspaces/repo.ts` + `lib/workspaces/context.ts` from 1.2.2/1.2.3\n' +
        '- `tests/password-reset.test.ts` from 1.1.6 — the rate-limit + token-lifecycle test ' +
        'pattern to mirror\n' +
        '- `/design/workspaces/invite-email.png` from 1.2.1 — the email body to render\n' +
        '- Better-Auth source for the password-reset flow ' +
        '(`node_modules/better-auth/dist/api/routes/password.mjs`) — the reference implementation ' +
        'of the Verification-based token pattern this Subtask mirrors for invites',
    },
    {
      id: '1.2.6',
      title: 'Switcher in top-nav + settings page + invite-acceptance UI',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['1.2.1', '1.2.3', '1.2.5'],
      descriptionMd:
        'The user-facing React for everything 1.2 ships: workspace switcher in the top-nav, ' +
        'settings page at `/settings/workspace` (rename + leave + delete-with-double-confirmation), ' +
        'and the invite-acceptance landing page at `/invite/accept`. All three compose from the ' +
        'design-system primitives (`Button`, `Input`, `Card`, `Dialog`) and follow the mockups ' +
        'from 1.2.1.\n\n' +
        '**Why one Subtask for all three UI surfaces:** they share a common API client (the ' +
        'invite + workspace endpoints from 1.2.5) and a common visual grammar (the workspace ' +
        'context). Splitting them would mean three Subtasks each calling out a slightly different ' +
        'slice of `useWorkspace()` / the switcher Popover / the destructive-dialog pattern. They ' +
        'cluster naturally; the Subtask is sized to one focused PR review.\n\n' +
        '**Top-nav minimal-then-expand pattern:** this Subtask introduces a tiny ' +
        '`app/(authed)/_components/TopNav.tsx` with two slots — the workspace switcher on the ' +
        'left, the user menu on the right. Story 1.5 (app shell) later expands this nav with ' +
        'project nav, search, etc. — but composes atop the existing structure rather than ' +
        'replacing it. The TopNav lives in a layout file `app/(authed)/layout.tsx` so it appears ' +
        'on every authed route (the smoke `/dashboard` from Story 1.1.2, plus everything 1.3+ ' +
        'adds). The dashboard\'s current ad-hoc "Sign out" form becomes a user-menu item.\n\n' +
        "**Switcher implementation:** client component reading the user's memberships via a " +
        'server-action wrapped `useSWR` (or equivalent cache-friendly fetch); active workspace ' +
        'persists via a `workspace_id` cookie set on switch. Switching workspaces triggers ' +
        '`router.refresh()` to revalidate server components against the new context, and clears ' +
        'any workspace-scoped `useSWR` caches.\n\n' +
        '**Settings page:** server component reading the active workspace via ' +
        '`getWorkspaceContext()` from 1.2.3. Renders three Card sections: **Name** ' +
        '(Input + Save server action), **Members** (list from ' +
        '`findWorkspaceMemberships(workspaceId)` + per-row Remove + an Invite button opening a ' +
        'Dialog with email Input + Send), **Danger zone** (Leave workspace server action with ' +
        "last-member guard; Delete workspace opens a Dialog matching 1.2.1's " +
        'double-confirmation mockup — the user must type the workspace name to enable the ' +
        'destructive Button). Last-member-cannot-leave is enforced server-side AND surfaced in ' +
        'the UI as a disabled-with-tooltip Leave button.\n\n' +
        '**Invite-acceptance page:** server component at ' +
        "`app/(authed)/invite/accept/page.tsx` (NOT under `(auth)` — requires auth, so it's " +
        'gated by the proxy.ts from Story 1.1.11). Reads `?token=` from search params, calls ' +
        '`GET /api/invites/[token]` to render the workspace name + inviter; renders the "Accept ' +
        'invite to {Workspace}" Button. Click fires `POST /api/invites/[token]/accept` and ' +
        'redirects to `/dashboard`. Error states (expired, already-used, wrong-email) render ' +
        "full-screen with the appropriate copy from 1.2.1's mockups.\n\n" +
        "**What you'll do:** Create `app/(authed)/layout.tsx` (with the TopNav), update " +
        '`app/(authed)/dashboard/page.tsx` to drop its inline sign-out form (now in the user ' +
        'menu), create ' +
        '`app/(authed)/_components/{TopNav,WorkspaceSwitcher,UserMenu}.tsx`, ' +
        '`app/(authed)/settings/workspace/page.tsx` + `actions.ts` (Server Actions for ' +
        'rename/leave/delete + send-invite), `app/(authed)/invite/accept/page.tsx`. Playwright ' +
        'E2E spec `tests/e2e/workspace-flows.spec.ts` covers: switcher list + switch persists ' +
        'across reload; rename workspace; invite + accept end-to-end (uses the file outbox from ' +
        '1.1.6); leave workspace blocked when last member; delete workspace cascades.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `app/(authed)/layout.tsx` renders `TopNav` on every authed route. TopNav contains ' +
        'the workspace switcher (left) and the user menu (right; includes Sign out, replacing the ' +
        "dashboard's inline form).\n" +
        '- Workspace switcher: closed state shows the active workspace name + chevron; open state ' +
        'lists all memberships with a check on active + "Invite teammates" pinned at the bottom + ' +
        'a "Create workspace" entry above the invite. Selecting a workspace sets the ' +
        '`workspace_id` cookie, calls `router.refresh()`, and re-renders server components with ' +
        'the new context.\n' +
        '- Settings page at `/settings/workspace` renders three Cards (Name, Members, Danger ' +
        "zone) matching 1.2.1's mockup. All three operate via Server Actions (not client-side " +
        'fetches) for the form posts.\n' +
        '- Rename: any member can rename; Save persists via `updateWorkspace` server action; ' +
        'success surfaces a transient toast (use the existing Radix toast primitive from 1.0.5.2).\n' +
        "- Members card: lists each member's name, email, role, and a Remove button (disabled for " +
        'the current user — use "Leave" instead). Includes an Invite Button opening a Dialog with ' +
        'email Input; Send calls the 1.2.5 invite endpoint and surfaces success/error inline.\n' +
        "- Leave workspace: server action removes the current user's membership. If the user is " +
        'the LAST member, the server action errors with a clear "you can\'t leave the last member ' +
        '— delete the workspace instead" message; the UI also disables the Leave Button with a ' +
        'tooltip explaining the same.\n' +
        '- Delete workspace: opens the double-confirmation Dialog from 1.2.1. The destructive ' +
        'Button is disabled until the typed-name input matches the workspace name exactly. ' +
        'Confirming calls `deleteWorkspace` (server action), which deletes via Prisma with ' +
        'cascade. On success, redirects to whichever workspace the user has left (or to a ' +
        '"create your first workspace" empty state if they have none).\n' +
        '- Invite-acceptance page at `/invite/accept` renders the workspace name + inviter, plus ' +
        'a single Accept Button. Click calls `POST /api/invites/[token]/accept`, switches the ' +
        'active workspace cookie to the newly-joined workspace, redirects to `/dashboard`.\n' +
        "- Invite-acceptance error states render full-screen with copy matching 1.2.1's mockup: " +
        '"This invite has expired", "This invite has already been used", "This invite is for a ' +
        'different email — please sign in with {email} or ask the inviter for a new link".\n' +
        '- Playwright E2E spec `tests/e2e/workspace-flows.spec.ts` covers: sign-up → switcher ' +
        'shows the auto-created workspace → rename → invite a second user (read link from file ' +
        'outbox, sign up as second user, accept) → second user appears in members list → switcher ' +
        'now shows both workspaces → switch between them → second user leaves → first user ' +
        'deletes workspace → cascade verified by DB query.\n' +
        '- All 4 quality gates green; test suite green; Playwright suite passes locally and in CI.\n\n' +
        '## Context refs\n\n' +
        '- `/design/workspaces/*.png` from 1.2.1 — all four mockups\n' +
        '- `components/ui/{Button,Input,Card,Dialog,Toast}.tsx` + `app/globals.css` tokens\n' +
        '- `app/(authed)/dashboard/page.tsx` — current smoke route to refactor\n' +
        '- `lib/workspaces/{repo,context,middleware,invites}.ts` from 1.2.2 / 1.2.3 / 1.2.5\n' +
        '- `app/api/workspaces/*` + `app/api/invites/*` endpoints from 1.2.4 / 1.2.5\n' +
        '- `tests/e2e/_helpers/{db-reset,email-capture}.ts` from 1.1.7 — the E2E helper pattern ' +
        'this Subtask reuses\n' +
        '- Next.js docs (fetched at prompt-gen time): Server Actions form patterns, ' +
        '`router.refresh()` + Server Components cache invalidation',
    },
    {
      id: '1.2.7',
      title: 'Multi-tenant isolation E2E + direct-DB RLS test',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 13,
      dependsOn: ['1.2.3', '1.2.6'],
      descriptionMd:
        'The load-bearing test that validates the Story-level AC\'s "structurally impossible" ' +
        'claim. Two layers, mirroring the two defense layers from 1.2.3: (1) **E2E test** via ' +
        'Playwright that signs in as user A in workspace A, tries to access workspace B (via URL ' +
        'manipulation, cookie tampering, forged headers), and asserts every path returns 404; ' +
        '(2) **Direct-DB integration test** via Vitest that opens a Prisma transaction WITHOUT ' +
        'setting the `app.workspace_id` GUC and tries to SELECT / UPDATE rows from ' +
        'workspace-scoped tables, asserting RLS denies everything.\n\n' +
        '**Why both layers, not just one:** E2E proves the middleware handles every ' +
        'legitimate-looking attack vector; direct-DB proves RLS catches a middleware bug. If only ' +
        'the E2E existed, a future Subtask could disable the middleware (or forget to wrap a new ' +
        "endpoint in `withWorkspaceContext`) and the test wouldn't catch it — the test would just " +
        'stop firing in the right code path. The direct-DB test guarantees that even if 100% of ' +
        'the application code were wrong, the database would still refuse to leak.\n\n' +
        "**Why 404 (not 403) for cross-workspace access:** 403 leaks the workspace's existence " +
        'to the attacker ("this workspace exists, you\'re just not in it"). 404 makes a ' +
        'non-member workspace indistinguishable from a non-existent one. Standard B2B SaaS ' +
        'practice (GitHub, Linear, Notion all return 404 for cross-tenant access).\n\n' +
        "**What you'll do:** Create `tests/e2e/multi-tenant-isolation.spec.ts` (tagged `@smoke`) " +
        'that: (a) creates two workspaces (A via sign-up, B via invite to a second user); (b) as ' +
        'user A, attempts to GET `/api/workspaces/{B.id}/invites`, PATCH workspace B, leave ' +
        "workspace B, delete workspace B — assert 404 on all; (c) attempts to read workspace B's " +
        'data by forging the `workspace_id` cookie value — assert the middleware re-validates ' +
        'membership and returns 404. Create `tests/multi-tenant-rls.test.ts` (Vitest) that opens ' +
        '`db.$transaction` without `withWorkspaceContext` and asserts SELECT returns zero rows ' +
        'from `workspace` and `workspace_membership` tables; that an INSERT into ' +
        "`workspace_membership` for a workspace the GUC doesn't grant access to fails with a " +
        'Postgres RLS error; that an UPDATE to a workspace not matching the GUC affects zero ' +
        'rows. Run the cascade-delete portion of the test by creating a workspace with a ' +
        'membership, deleting the workspace, asserting the membership row is also gone.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Playwright spec `tests/e2e/multi-tenant-isolation.spec.ts` exists and is tagged ' +
        '`@smoke`; passes locally and in CI.\n' +
        '- E2E covers: cross-workspace GET returns 404 (not 403, not 200); cross-workspace ' +
        'mutation (PATCH, DELETE) returns 404; forged workspace_id cookie pointing at a workspace ' +
        "the user isn't a member of returns 404 (middleware re-validates).\n" +
        '- Vitest spec `tests/multi-tenant-rls.test.ts` exists; passes locally and in CI.\n' +
        '- RLS test covers: SELECT without GUC returns zero rows from workspace + ' +
        "workspace_membership; SELECT with GUC matching workspace A returns workspace A's rows " +
        'only (no workspace B); INSERT into workspace_membership for a workspace not matching the ' +
        'GUC fails with RLS denial; UPDATE on a workspace not matching the GUC affects zero rows.\n' +
        '- Cascade-delete test verifies: deleting a workspace deletes all its memberships in the ' +
        "same transaction; deleting a user deletes all their memberships (memberships' user FK is " +
        'also CASCADE).\n' +
        '- All quality gates green; total test count grows by ~15-20 (E2E + Vitest combined).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/auth-credentials.spec.ts` + `auth-google.spec.ts` from 1.1.7 — the E2E ' +
        'patterns for sign-up + sign-in + DB assertion\n' +
        '- `tests/password-reset.test.ts` from 1.1.6 — the Vitest pattern for testing ' +
        'Better-Auth handler routes directly (this Subtask uses the same approach for the ' +
        'workspace API routes)\n' +
        '- `lib/workspaces/{context,middleware}.ts` from 1.2.3 — the gates being tested\n' +
        '- Postgres docs (fetched at prompt-gen time): RLS error codes (specifically: ' +
        '`42501 insufficient_privilege` for denied mutations, `0 rows affected` for denied reads ' +
        '— both are valid RLS-denial signals depending on the query)\n' +
        '- OWASP IDOR (Insecure Direct Object Reference) reference (fetched at prompt-gen time) ' +
        '— the threat model this test validates against',
    },
  ],
};
