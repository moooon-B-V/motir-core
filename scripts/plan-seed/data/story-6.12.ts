import type { PlanStory } from '../types';

/**
 * Story 6.12 (Epic 6) — Public projects (open project management). A project can
 * be made **public**: open for read-only VIEW to ANY signed-in Motir account
 * (across orgs/workspaces), where a viewer can change NOTHING except **add bugs
 * / feature requests** (through the 6.11 Triage), **upvote** existing requests,
 * and **comment** on them. This is the marketing-grade "open source project
 * management" / public-feedback-portal concept (Yue), built as a pure motir-core
 * per-project capability with zero AI boundary and zero forward dependency.
 *
 * **The locked model (Yue, 2026-06-12): `public` is a 4th `ProjectAccessLevel`,
 * and it is the ONLY access level that crosses the org boundary for READ.**
 * Story 6.4 (DONE) shipped `ProjectAccessLevel` open/limited/private + the
 * `projectAccessService` `canBrowse`/`canEdit` policy; 6.12 adds a fourth level
 * `public` and EXTENDS that exact policy — it does not fork a parallel one. The
 * openness ladder is **public > open > limited > private**:
 *   - **private** → only project members (6.4).
 *   - **limited** → any WORKSPACE member, view + comment, no edit (6.4).
 *   - **open** → any WORKSPACE member, view + edit (6.4).
 *   - **public** → any AUTHENTICATED Motir account, ACROSS orgs/workspaces,
 *     read-only VIEW; the only writes are triage-submit + upvote + comment.
 * Every level except `public` is org/workspace-bounded; `public` is the single
 * deliberate exception where 6.4's `canBrowse` returns true for a user with NO
 * org/workspace membership at all (bypassing the 6.10 org gate for READ on public
 * projects ONLY). Every WRITE stays gated: a public viewer is NOT a member, so
 * 6.4 `canEdit` is false for everything; the three permitted writes
 * (triage-submit, upvote, comment) are NEW narrow grants checked explicitly, not
 * a relaxation of `canEdit`. The existing 404-not-403 posture is untouched for
 * NON-public projects (a non-public project a cross-org user hits is still
 * not-found, never forbidden).
 *
 * **Account-required, NOT anonymous (locked).** A viewer must be a signed-in
 * Motir account (any org). Anonymous/logged-out public access is explicitly
 * FUTURE (named out of scope, not silently dropped) — it would need abuse
 * controls + an anonymous-identity model this story does not build. This is the
 * deliberate narrowing: GitHub-public-repo "anyone can read" semantics, gated to
 * "any authenticated user" so every submit/upvote/comment carries a real account
 * for attribution + rate-limiting.
 *
 * **What is VISIBLE vs HIDDEN on the public view (locked).** A public viewer
 * sees the read-only board / issue list and the public ROADMAP (status-grouped
 * public-facing items). They do NOT see internal-only fields — **assignees,
 * estimates, and internal comments are HIDDEN** (the decision 6.12.2 fixes the
 * exact set; the durable shape is a public PROJECTION that strips internal
 * fields at the read layer, not a UI that merely hides them). There are NO edit
 * affordances anywhere on the public surface (no create/move/assign/status
 * controls) — the only interactive elements are Submit-a-request, Upvote, and
 * Comment.
 *
 * **The proven feature set beyond bare view+submit (mirror-driven — adopt, not
 * gold-plate).** The established public-project / public-feedback-portal pattern
 * pairs (a) public roadmap visibility with (b) a feedback portal, and every
 * rung-1 portal ships the SAME four behaviours, so they are in scope:
 *   1. **Upvoting** — the demand signal. Canny "processes millions of upvotes
 *      annually"; users "vote on what to build next"; the triage queue (6.11)
 *      sorts by this signal. A vote model + the cross-account vote (one vote per
 *      account per item).
 *   2. **Automatic duplicate detection on submit** — Canny's core behaviour:
 *      "Canny automatically detects if a requested feature already exists … the
 *      customer can add their upvote and leave comments on the existing request"
 *      (teams report a "35% reduction in duplicate feature requests"). 6.12.5
 *      surfaces existing matching requests BEFORE creating a new triage item so
 *      the submitter upvotes the existing one instead of creating a dupe.
 *   3. **Comments** on public requests — discussion on the request (Canny:
 *      "leave comments on the existing request").
 *   4. **A public roadmap with status tracking** — submitted → planned →
 *      in_progress → done, the column-by-status shape Canny / Productboard /
 *      Featurebase / Linear public roadmaps all use (Canny: "items organized by
 *      status columns … with vote counts visible").
 *
 * **The verified mirror (rung 1, cited not asserted — checked 2026-06-12).**
 *   - **Public project / roadmap visibility.** OpenProject ships an explicit
 *     PUBLIC project visibility + a public roadmap as its "Open Source Project
 *     Management" posture; Plane (open-source Jira/Linear alternative) ships a
 *     transparent public roadmap + Intake; GitHub public repos are the
 *     "anyone-can-read, only-collaborators-write" baseline; Linear exposes
 *     public-link / public-roadmap sharing (and customer-request portals via
 *     Productlane/Featurebase that sync status back). (github.com/makeplane/plane,
 *     plane.so/open-source, openproject.org/roadmap,
 *     blog.feedvote.app/how-to-build-a-public-roadmap-in-linear-2026-guide)
 *   - **Public feedback portals.** Canny / Productboard / Featurebase are the
 *     verified portal mirror for the submit + upvote + comment + status-roadmap
 *     set, incl. Canny's automatic duplicate detection and vote-on-the-existing
 *     behaviour, and Productboard's "Share > Publish > copy link" public portal +
 *     status roadmap. (canny.io/use-cases/feature-request-management,
 *     support.productboard.com — Use the Portal to share your plans and collect
 *     feedback at scale, linear.app/integrations/featurebase)
 *
 * **This EXTENDS 6.11 (the Triage) and 6.4 (access levels), never re-implements
 * them.** A public submission lands in the SAME triage queue 6.11 built — born a
 * `work_item` in the `triage` state, excluded from every normal read, attributed
 * to the submitting (cross-org) account, promoted/declined/merged by the project
 * admin through the same 6.11 actions. 6.12 reuses 6.11.4's intake creation path
 * (adding cross-org-account submit + the dedupe pre-check) and 6.11.3's queue
 * (adding the vote-count sort key); it adds NO second submissions table and NO
 * second access policy.
 *
 * **Scale (finding #57).** A public project is an unbounded, internet-facing
 * read surface: the public board/issue list, the roadmap columns, and the
 * request list are ALL paginated / cursor'd (never load-all), the submit path is
 * rate-limited + abuse-guarded per the 6.11 precedent, and one-vote-per-account
 * is enforced server-side (not a client toggle).
 *
 * **Design gate.** New user-facing surfaces ship here — the public read-only
 * project view (board/issues), the public roadmap, the public submission +
 * upvote + comment surfaces, and the "make public" toggle + share-link in
 * project settings. So the FIRST subtask (6.12.1) is a `design` card producing
 * the multi-panel mock + design-notes under `design/public-projects/`, composing
 * only shipped `components/ui/*` primitives + `--el-*` / `[data-display-style]`
 * tokens. Every UI code subtask (6.12.4/6.12.6/6.12.7/6.12.8) depends on it and
 * is `blocked`.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * `dependsOn` id's story number is ≤ 6.12: same-story 6.12.x, or backward to
 * 6.11.x (Triage — its intake 6.11.4 + its queue 6.11.3) and 6.4.x (access
 * levels — DONE/shipped). 6.4 is DONE so its deps are satisfied; 6.11 is being
 * planned (not done) so anything chained behind a 6.11.x id is `blocked`.
 * 6.12.1 (design) and 6.12.2 (decision) have `dependsOn: []` → `planned`;
 * everything chained behind them or behind 6.11.x → `blocked`.
 */
export const story_6_12: PlanStory = {
  id: '6.12',
  title: 'Public projects (open project management)',
  status: 'planned',
  gitBranch: 'feat/PROD-6.12-public-projects',
  descriptionMd:
    'Make a project **public** — open for read-only VIEW to ANY signed-in ' +
    'Motir account, ACROSS orgs and workspaces — where a viewer can change ' +
    'NOTHING except **submit a bug / feature request** (into the 6.11 ' +
    'Triage), **upvote** an existing request, and **comment** on it. This is ' +
    'the "open source project management" / public-feedback-portal posture: a ' +
    'public roadmap + a public intake, gated to authenticated accounts. A pure ' +
    'motir-core, per-project capability — no AI boundary, no forward ' +
    'dependency.\n\n' +
    '**The model (locked — see the module header for the full rationale + the ' +
    'verified mirror):**\n\n' +
    '- **`public` is a 4th `ProjectAccessLevel`, extending 6.4.** Today ' +
    'open / limited / private (6.4, DONE); 6.12 adds **public**. The openness ' +
    'ladder is **public > open > limited > private**. `public` is the ONLY ' +
    'level that crosses the org boundary for READ — 6.4’s `canBrowse` returns ' +
    'true for ANY authenticated account on a public project (bypassing the ' +
    'org/workspace gate for READ on public projects only); every other level ' +
    'stays org/workspace-bounded and the 404-not-403 posture for non-public ' +
    'projects is untouched.\n' +
    '- **Account-required, not anonymous.** A viewer must be a signed-in ' +
    'Motir account (any org). Anonymous/logged-out access is explicitly FUTURE ' +
    '(out of scope) so every submit/upvote/comment carries a real account for ' +
    'attribution + rate-limiting.\n' +
    '- **The only writes a public viewer can do** are triage-submit + upvote ' +
    '+ comment — three NEW narrow grants checked explicitly, NOT a relaxation ' +
    'of 6.4 `canEdit` (a public viewer is not a member, so `canEdit` is false ' +
    'for every normal write). No create/move/assign/status affordance appears ' +
    'on the public surface.\n' +
    '- **Visible vs hidden.** The public view shows the read-only board / ' +
    'issue list + the public ROADMAP (status-grouped). Internal-only fields — ' +
    '**assignees, estimates, internal comments** — are HIDDEN via a public ' +
    'PROJECTION that strips them at the read layer (not merely a hidden UI).\n' +
    '- **The proven portal set (adopted from the mirror).** Beyond view + ' +
    'submit: **upvoting** (the demand signal the triage queue sorts by), ' +
    '**automatic duplicate detection** on submit (surface an existing matching ' +
    'request so the user upvotes it instead of creating a dupe — Canny’s core ' +
    'behaviour), **comments** on public requests, and a **public roadmap** ' +
    'with status tracking (submitted → planned → in progress → done).\n\n' +
    '**This EXTENDS 6.11 (Triage) + 6.4 (access levels), never re-implements ' +
    'them.** A public submission lands in the SAME triage queue (born a ' +
    '`work_item` in the `triage` state, excluded from every normal read), ' +
    'reusing 6.11.4’s intake path (adding cross-org-account submit + the dedupe ' +
    'pre-check) and 6.11.3’s queue (adding the vote-count sort); it adds no ' +
    'second submissions table and no second access policy.\n\n' +
    '**Scope:** the public-surface design (6.12.1); the `public`-access-level ' +
    'semantics decision (6.12.2); the schema + access-check extension + ' +
    'migration (6.12.3); the public read-only project view, internal fields ' +
    'hidden (6.12.4); cross-account submit-to-triage + duplicate detection ' +
    '(6.12.5); upvoting + comments on public requests (6.12.6); the public ' +
    'roadmap view with status tracking (6.12.7); the "make public" toggle + ' +
    'the shareable public link in project settings (6.12.8); the access + ' +
    'dedupe + voting tests (6.12.9); the cross-org e2e (6.12.10).\n\n' +
    '**Out of scope (named so they land in their own story, not here):** ' +
    'ANONYMOUS / logged-out public access (a future story — needs ' +
    'anonymous-identity + heavier abuse controls); a fully custom-branded / ' +
    'white-label public portal domain (this ships the in-app authenticated ' +
    'public surface, not a separate marketing site); AI-assisted dedupe ' +
    'suggestion beyond the deterministic match (an Epic-7 planner enhancement); ' +
    'public analytics / vote-trend dashboards; and email digests of public ' +
    'activity.',
  verificationRecipeMd:
    '- Pull the Story branch; run the migration + `pnpm db:seed` against the ' +
    'local Postgres (`localhost:5433`); `pnpm dev`.\n' +
    '- **Make-public + the share link.** As the `motir` project admin, open ' +
    'project settings → set the project **public** → a shareable public link ' +
    'appears (and can be disabled/rotated). Confirm the access level now reads ' +
    '`public` and the four-level control shows public > open > limited > ' +
    'private.\n' +
    '- **Cross-org read (the load-bearing check).** Sign in as a SECOND Motir ' +
    'account in a DIFFERENT org with NO membership in the public project’s org/' +
    'workspace. Open the public link → the read-only board / issue list + the ' +
    'public roadmap render; there are NO edit affordances (no create / move / ' +
    'assign / status controls); **assignees, estimates, and internal comments ' +
    'are absent** from every issue. Confirm the SAME second account hitting a ' +
    'NON-public project of that org gets 404-not-403 (not forbidden), proving ' +
    'public is the only cross-org read exception.\n' +
    '- **Submit + duplicate detection.** As the second account, submit a ' +
    'feature request whose title matches an existing public request → the ' +
    'dedupe surfaces the existing matching request(s) and offers to **upvote** ' +
    'it instead of creating a dupe; upvoting it increments the count (and the ' +
    'item is NOT duplicated). Then submit a genuinely-new request → it lands in ' +
    'the project’s triage queue (6.11) with cross-org-account attribution, ' +
    'invisible to the normal tree until an admin promotes it.\n' +
    '- **Upvote + comment.** As the second account, upvote a public request ' +
    '(a second upvote from the same account is a no-op / toggle, never a double ' +
    'count) and add a comment; confirm the comment shows on the public request ' +
    'and the vote raises the request’s position in the project admin’s triage ' +
    'queue (the demand signal).\n' +
    '- **The public roadmap.** Confirm the roadmap groups public-facing items ' +
    'by status (submitted → planned → in progress → done) with vote counts, ' +
    'paginated (no load-all), and reflects an item’s status as the admin ' +
    'advances it.\n' +
    '- `pnpm test` (6.12.9) covers: the access matrix (a cross-org account ' +
    'READS a public project but every normal write is blocked; the three ' +
    'permitted writes — submit / upvote / comment — succeed; a non-public ' +
    'project is 404 cross-org), the duplicate-detection match, and ' +
    'one-vote-per-account, all on a real Postgres respecting the per-file ' +
    'coverage gate.\n' +
    '- **4-layer + token review.** No raw Prisma in any route; the public read ' +
    'goes through the public projection in the service/repository layer; every ' +
    'write (submit/upvote/comment) routes through a service → ' +
    '`workItemsService` where it mutates a work_item; the public surfaces ' +
    'reference only `--el-*` / `[data-display-style]` tokens + shipped ' +
    '`components/ui/*`.\n' +
    '- **Dep audit.** Confirm no 6.12 subtask references any id > 6.12 (deps ' +
    'are 6.12.x / 6.11.x / 6.4.x only).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '6.12.1',
      title:
        'Design — the public project view + public roadmap + submit/upvote/comment surfaces + the make-public toggle',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** design (THE design gate — produced FIRST; every UI code ' +
        'subtask here — 6.12.4, 6.12.6, 6.12.7, 6.12.8 — depends on this card ' +
        'and is `blocked` until it lands). Produce the surface design assets ' +
        'under `motir-core/design/public-projects/`, composing ONLY shipped ' +
        '`components/ui/*` primitives + `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (NO Tier-0 `--color-*`, no ' +
        'hand-rolled spacing/radius), mirroring 7.0.1’s multi-panel design-card ' +
        'shape.\n\n' +
        'The surfaces to draw (every panel — the multi-panel rule, mistake ' +
        '#31):\n\n' +
        '- **Panel 1 — the public read-only project view (board / issues).** ' +
        'The board columns + issue list as a NON-member sees them: read-only, ' +
        'with NO edit affordances (no create / move / assign / status control, ' +
        'no drag handles). INTERNAL fields are absent — draw an issue card / ' +
        'row WITHOUT assignee, WITHOUT estimate, and note that internal ' +
        'comments are not shown. Make the "you are viewing a public project" ' +
        'framing explicit (a banner / chip), and show the signed-in ' +
        'cross-org viewer’s identity (they ARE authenticated).\n' +
        '- **Panel 2 — the public roadmap.** Status-grouped columns ' +
        '(submitted → planned → in progress → done) of public-facing items, ' +
        'each with its **vote count** + a link to the request; paginated / ' +
        'lazy (the at-scale rule — NOT load-all). Mirror the Canny / ' +
        'Productboard status-column roadmap.\n' +
        '- **Panel 3 — submit a request + DUPLICATE DETECTION.** The submit ' +
        'form (type toggle bug | feature, title, description) AND the ' +
        'duplicate-detection state: as the title is entered, surface matching ' +
        'existing request(s) with an **"Upvote this instead"** affordance (the ' +
        'Canny behaviour) so the user joins the existing request rather than ' +
        'creating a dupe; plus the "submit as new" path + the "thanks, we got ' +
        'it" confirmation.\n' +
        '- **Panel 4 — a public request detail with upvote + comments.** The ' +
        'request body, its **upvote control + count** (showing the ' +
        'already-voted state), and the **comment thread + a comment composer** ' +
        '— the only interactive elements on the public surface besides submit.\n' +
        '- **Panel 5 — project settings: the make-public toggle + share ' +
        'link.** The four-level Access control extended to ' +
        '**public > open > limited > private** (with one-line copy for each, ' +
        'and a clear "public = any signed-in Motir account, across orgs, can ' +
        'view + submit/upvote/comment" explanation), plus the **shareable ' +
        'public link** (copy, disable, rotate) and the ' +
        'account-required-not-anonymous note.\n' +
        '- **Panel 6 — empty / loading / error / permission states.** The ' +
        'empty roadmap + empty request list, the paginated loading skeleton, ' +
        'the fetch-error state, and the rate-limited submit state (graceful, ' +
        'not a raw 500).\n\n' +
        'Write **`design/public-projects/design-notes.md`** naming every ' +
        'primitive composed (e.g. `IssueTypeIcon` for the kind hue, `Pill` for ' +
        'status/vote tone, `Combobox`/picker reuse, the EmptyState/ErrorState ' +
        'family, the skeleton/loader), the EXACT copy for each Access-level ' +
        'line + each action + each empty/confirmation/error state, the ' +
        'per-`--el-*` colour role for every element (use the palette, not ' +
        'grey-only — finding #54; e.g. the public-banner tint, the upvote ' +
        'accent, the roadmap status tones), and a "primitives composed (no ' +
        'hand-rolling)" checklist. It MUST state, in writing, that internal ' +
        'fields (assignees / estimates / internal comments) are ABSENT from the ' +
        'public view, that the public surface has NO edit affordances, and that ' +
        'access is account-required (anonymous is future).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/public-projects/*.mock.html` renders the six panels above, ' +
        'referencing ONLY `--el-*` + `[data-display-style]` tokens (no Tier-0 ' +
        '`--color-*`, no hand-rolled spacing/radius) + shipped ' +
        '`components/ui/*`.\n' +
        '- The public board/issue panel shows NO edit affordances and NO ' +
        'internal fields (assignee / estimate / internal comments absent); the ' +
        'public-project framing (banner/chip) is drawn.\n' +
        '- The roadmap is drawn status-grouped (submitted → planned → in ' +
        'progress → done) with vote counts, paginated/lazy; the submit panel ' +
        'draws the duplicate-detection "upvote this instead" state; the request ' +
        'detail draws upvote + comments.\n' +
        '- The Access control is drawn with all FOUR levels ' +
        '(public > open > limited > private) + copy, the shareable link ' +
        '(copy/disable/rotate), and the account-required note.\n' +
        '- `design-notes.md` names every primitive + copy + per-element ' +
        '`--el-*` role, and states the hidden-internal-fields + ' +
        'no-edit-affordances + account-required invariants; AA contrast holds ' +
        'for the public banner + the upvote/roadmap tints.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 — the multi-panel ' +
        'design-card shape to mirror.\n' +
        '- `scripts/plan-seed/data/story-6.11.ts` § 6.11.1 — the triage ' +
        'submission-surface design this composes with (the submit form reuses ' +
        'its shape).\n' +
        '- Canny (https://canny.io/use-cases/feature-request-management) — the ' +
        'status-column roadmap + vote count + "upvote the existing request" ' +
        'surface being mirrored.\n' +
        '- Productboard portal ' +
        '(https://support.productboard.com/hc/en-us/articles/360056315454) — ' +
        'the public portal + share-link + status roadmap shape.\n' +
        '- `motir-core/components/ui/*`, `app/globals.css` (the `--el-*` + ' +
        '`[data-display-style]` token layers), `motir-core/CLAUDE.md` § colour ' +
        '+ shape tokens; `IssueTypeIcon` / `Pill` (the kind-hue + tone ' +
        'primitives).',
      dependsOn: [],
    },
    {
      id: '6.12.2',
      title:
        'Decision — the `public` access-level semantics: cross-org read, write-grants, visible-vs-hidden, the openness ladder',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR the schema + access cards ' +
        '[6.12.3+] build against; no app behavior ships, but the shapes it ' +
        'fixes are load-bearing). Write ' +
        '`motir-core/docs/decisions/public-projects.md`, EXTENDING (not ' +
        'forking) 6.4’s access-level ADR. It MUST fix:\n\n' +
        '1. **`public` extends `ProjectAccessLevel` (open / limited / private ' +
        '/ public).** Add `public` to the existing 6.4 enum; the openness ' +
        'ladder is **public > open > limited > private**. State that this is a ' +
        'one-value extension of the 6.4 model + the SAME ' +
        '`projectAccessService` policy — NOT a parallel access system.\n' +
        '2. **`public` = any AUTHENTICATED Motir account reads CROSS-ORG ' +
        '(the single exception).** Decide precisely: 6.4’s `canBrowse` returns ' +
        'true for ANY signed-in user when the project is `public`, BYPASSING ' +
        'the 6.10 org/workspace membership gate FOR READ ON PUBLIC PROJECTS ' +
        'ONLY. Every other level stays org/workspace-bounded; the 404-not-403 ' +
        'cross-tenant posture is preserved for non-public projects (a cross-org ' +
        'user hitting a non-public project is still not-found, never ' +
        'forbidden). Fix WHERE this exception lives so it is a single, auditable ' +
        'branch in the access policy (not scattered).\n' +
        '3. **Writes limited to triage-submit + upvote + comment — explicit ' +
        'grants, NOT a `canEdit` relaxation.** A public viewer is not a ' +
        'member, so 6.4 `canEdit` is FALSE for every normal write ' +
        '(create/move/assign/status/field-edit). The three permitted writes ' +
        'are NEW narrow capabilities checked explicitly: `canSubmitToTriage`, ' +
        '`canUpvotePublicRequest`, `canCommentPublicRequest` — each true for ' +
        'any authenticated account on a public project, each independent of ' +
        '`canEdit`. State that no other write path may ever key off "is on a ' +
        'public project".\n' +
        '4. **Visible vs HIDDEN — the public projection.** Decide the EXACT ' +
        'set of internal-only fields stripped from the public read: ' +
        '**assignees, estimates, and internal comments are HIDDEN** ' +
        '(decide explicitly which comments are "internal" vs ' +
        'public-request comments — the public-request comment thread from ' +
        '6.12.6 IS public; the issue’s internal discussion is not). Fix that ' +
        'the stripping is a PUBLIC PROJECTION at the read layer (a dedicated ' +
        'read shape / DTO that never includes the hidden fields), NOT a UI that ' +
        'fetches everything and hides it (which would leak over the wire). ' +
        'Enumerate what IS visible: issue key/title/kind/status/description, ' +
        'board columns, the public roadmap, vote counts, public-request ' +
        'comments.\n' +
        '5. **Account-required, not anonymous.** Fix that a viewer MUST be a ' +
        'signed-in Motir account (any org); anonymous access is out of scope ' +
        '(future). Every submit/upvote/comment is attributed to that account ' +
        'and rate-limited by it. State the share-link is an entry pointer to ' +
        'the public project (it still requires sign-in), NOT an ' +
        'unauthenticated bypass.\n' +
        '6. **Submission + dedupe + vote model semantics.** A public ' +
        'submission reuses 6.11’s intake (born a triage `work_item`), ' +
        'attributed to the cross-org account. Fix the duplicate-detection ' +
        'contract (a deterministic title/text match over existing PUBLIC ' +
        'requests, surfaced BEFORE create so the user upvotes the existing one ' +
        '— Canny’s behaviour) and the vote model (one vote per account per ' +
        'item, server-enforced; the count is a sort key the 6.11 triage queue ' +
        'reads). Decide the vote storage (a `PublicRequestVote` join, unique on ' +
        '`(workItemId, userId)`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The ADR fixes all six sections, naming the FOUR-level ladder ' +
        '(public > open > limited > private) as a one-value extension of 6.4’s ' +
        'enum + the SAME `projectAccessService`.\n' +
        '- It states the cross-org READ exception is public-only and lives in a ' +
        'single auditable branch, and that 404-not-403 holds for non-public ' +
        'projects.\n' +
        '- It enumerates the three explicit write grants (submit / upvote / ' +
        'comment) as independent of `canEdit`, and the EXACT hidden-field set ' +
        '(assignees, estimates, internal comments) stripped by a public ' +
        'PROJECTION at the read layer.\n' +
        '- It fixes the account-required (not anonymous) rule, the ' +
        'duplicate-detection-before-create contract, and the one-vote-per-' +
        'account model with its storage.\n' +
        '- It cites the verified mirror (OpenProject/Plane/GitHub public ' +
        'visibility + Canny/Productboard/Featurebase portal set) for the ' +
        'public-project + submit/upvote/comment/status-roadmap shape.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` — the shipped ' +
        '`ProjectAccessLevel` (open/limited/private) + the ' +
        '`projectAccessService` `canBrowse`/`canEdit` policy this extends.\n' +
        '- `scripts/plan-seed/data/story-6.11.ts` — the triage intake (6.11.4) ' +
        '+ queue (6.11.3) the public submit reuses + the vote-count sort feeds.\n' +
        '- `scripts/plan-seed/data/story-6.10.ts` — the org gate the public ' +
        'cross-org READ exception bypasses (for public projects only).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the write authority ' +
        'submit/upvote/comment route through.\n' +
        '- Canny (https://canny.io/use-cases/feature-request-management) — ' +
        'duplicate detection + upvote-the-existing + status roadmap; ' +
        'OpenProject (https://www.openproject.org/roadmap/) + Plane ' +
        '(https://plane.so/open-source) — public project / public roadmap ' +
        'visibility.',
      dependsOn: [],
    },
    {
      id: '6.12.3',
      title:
        'Schema + access — add `public` to `ProjectAccessLevel`; extend the access-check cross-org for READ; migration',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Implement the `public` access level + the access-check extension per ' +
        '6.12.2. This is the load-bearing correctness work the whole story ' +
        'rides — it must EXTEND 6.4’s shipped `projectAccessService`, not fork ' +
        'a parallel policy.\n\n' +
        '- **Schema:** add `public` to the existing 6.4 `ProjectAccessLevel` ' +
        'enum (`open | limited | private | public`) with a migration; no ' +
        'default change (existing projects stay their current level — adding an ' +
        'enum value locks nothing out). Add the `PublicRequestVote` join ' +
        '(`{ id, workItemId, userId, createdAt }`, unique on ' +
        '`(workItemId, userId)`) modelled as Prisma `@relation` on BOTH sides ' +
        '(to `work_item` + `User`) per the CLAUDE.md FK-as-`@relation` rule — ' +
        'NO raw-SQL-only FK (6.12.6 uses it, but the model lands with the ' +
        'access foundation so the schema is coherent in one migration).\n' +
        '- **Access-check extension (the single auditable branch):** extend ' +
        '`canBrowse` so that when a project is `public`, it returns true for ' +
        'ANY authenticated user — bypassing the 6.10 org/workspace membership ' +
        'gate FOR READ ON PUBLIC PROJECTS ONLY. Every other level keeps its ' +
        '6.4 semantics; the 404-not-403 posture is UNTOUCHED for non-public ' +
        'projects (a cross-org user on a non-public project still gets ' +
        'not-found). `canEdit` is UNCHANGED — a public viewer (non-member) ' +
        'gets false for every normal write. Add the three explicit grants ' +
        '`canSubmitToTriage` / `canUpvotePublicRequest` / ' +
        '`canCommentPublicRequest` (true for any authed account on a public ' +
        'project), independent of `canEdit`, so later cards check THEM, never a ' +
        'relaxed edit gate.\n\n' +
        'Stay 4-layer: the enum + vote model in `prisma/schema.prisma` + the ' +
        'repository, the access policy in the service layer (extend the ' +
        'existing `projectAccessService`), no raw Prisma in routes.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The migration adds `public` to `ProjectAccessLevel` and the ' +
        '`PublicRequestVote` join (every FK an `@relation` on both sides); ' +
        '`prisma migrate dev` reports no drift; no existing project’s level ' +
        'changes.\n' +
        '- `canBrowse` returns true for ANY authenticated user on a `public` ' +
        'project (cross-org), in a single auditable branch; non-public ' +
        'projects keep 6.4 semantics + the 404-not-403 cross-tenant posture ' +
        'unchanged.\n' +
        '- `canEdit` is unchanged (a public non-member viewer → false for ' +
        'every normal write); the three explicit grants ' +
        '(`canSubmitToTriage` / `canUpvotePublicRequest` / ' +
        '`canCommentPublicRequest`) exist and are true only for an ' +
        'authenticated account on a public project, independent of `canEdit`.\n' +
        '- 4-layer respected (policy in the extended service, vote model in a ' +
        'single-op repository, no raw Prisma in routes).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.2 — the semantics this implements (the ladder + the cross-org ' +
        'read exception + the explicit grants + the projection contract).\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` (6.4.2 schema + 6.4.3 ' +
        '`projectAccessService`) — the enum + `canBrowse`/`canEdit` policy this ' +
        'EXTENDS (mirror its shape; do not fork).\n' +
        '- `motir-core/lib/repositories/` + `lib/services/` — the project ' +
        'access service + repositories the extension threads into.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migration FK-as-`@relation` ' +
        'rule.',
      dependsOn: ['6.12.2'],
    },
    {
      id: '6.12.4',
      title:
        'Public read-only project view (board / issues) — internal fields hidden, no edit affordances',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the public read-only project view per the 6.12.1 design, over ' +
        'the 6.12.3 access extension. A cross-org authenticated viewer opens a ' +
        'public project and sees the board columns + issue list READ-ONLY, with ' +
        'INTERNAL fields hidden and NO edit affordances.\n\n' +
        '- **The public PROJECTION (the load-bearing correctness):** the read ' +
        'goes through a dedicated public read shape / DTO (per 6.12.2) that ' +
        'NEVER includes the hidden internal fields — **assignees, estimates, ' +
        'internal comments are stripped at the read/service layer**, not ' +
        'fetched-then-hidden (so nothing internal crosses the wire). What IS ' +
        'returned: issue key / title / kind / status / description, board ' +
        'columns, ordering — the public-safe fields only.\n' +
        '- **The view UI:** render the read-only board + issue list with the ' +
        '"public project" framing (banner/chip) and the signed-in cross-org ' +
        'viewer’s identity; NO create / move / assign / status / drag ' +
        'affordances anywhere (the public surface is view-only besides the ' +
        '6.12.6 upvote/comment + 6.12.5 submit entry points). Paginated / lazy ' +
        '(the at-scale rule — a public board is an unbounded read surface).\n' +
        '- **Gating:** the route is session-gated (a signed-in account is ' +
        'required — account-required, not anonymous) and access is granted via ' +
        '6.12.3’s `canBrowse` (true cross-org for public); a non-public project ' +
        'a cross-org user hits stays 404-not-403.\n\n' +
        'Stay 4-layer: the route parses + calls one service method returning ' +
        'the public projection; the projection lives in the service/repository ' +
        'read layer so no future read can leak internal fields.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A cross-org authenticated viewer opens a public project and sees the ' +
        'read-only board + issue list rendering the 6.12.1 design; a non-public ' +
        'project stays 404 cross-org.\n' +
        '- The public projection strips assignees, estimates, and internal ' +
        'comments at the read layer (verified: the hidden fields are absent ' +
        'from the response payload, not merely hidden in the DOM).\n' +
        '- NO edit affordances render on the public surface (no create / move ' +
        '/ assign / status / drag); the view is paginated / lazy.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; matches the 6.12.1 design; 4-layer respected (the ' +
        'projection in the service/repository, no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.1 (design asset — required), 6.12.3 (the access extension + ' +
        '`canBrowse` cross-org + the projection contract).\n' +
        '- `motir-core/lib/services/workItemsService.ts` + the board / issue ' +
        'read paths — the reads the public projection derives from.\n' +
        '- `motir-core/components/ui/*` + `app/globals.css` token layers; ' +
        '`motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens.',
      dependsOn: ['6.12.1', '6.12.3'],
    },
    {
      id: '6.12.5',
      title:
        'Public submit-to-triage for any account + DUPLICATE DETECTION (surface the existing request to upvote)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The cross-account public submission path, REUSING 6.11.4’s intake ' +
        '(no second submissions table), plus the duplicate-detection pre-check ' +
        '(Canny’s core behaviour). Per 6.12.2:\n\n' +
        '- **Cross-org-account submit:** a service + route taking ' +
        '`{ kind (bug|feature), title, descriptionMd }` that creates a triage ' +
        '`work_item` through `workItemsService` (the SAME 6.11.4 creation ' +
        'path), attributed to the SUBMITTING cross-org account (a real ' +
        'authenticated `submittedByUserId`, not an external/anonymous ' +
        'submitter), scoped to the public project. Gated by 6.12.3’s ' +
        '`canSubmitToTriage` (true for any authed account on a public project) ' +
        '— NOT `canEdit`. Rate-limited + abuse-guarded per the 6.11.4 ' +
        'precedent (per-account throttle, size cap), since this is an ' +
        'internet-facing write.\n' +
        '- **Duplicate detection (BEFORE create):** a service method that, ' +
        'given a draft title/text, finds matching EXISTING public requests for ' +
        'the project (a deterministic title/text match — e.g. normalized ' +
        'token / trigram similarity, reusing the 6.1.1 search where it fits; ' +
        'NOT an AI call — AI dedupe is an Epic-7 enhancement) and returns the ' +
        'candidates so the UI can offer **"upvote this instead"**. If the user ' +
        'chooses an existing request, NO new item is created — the flow hands ' +
        'off to the 6.12.6 upvote. If they choose "submit as new", the create ' +
        'path runs. The match read must respect the public projection (it only ' +
        'searches public-facing requests) and the triage queue (a duplicate of ' +
        'a still-in-triage request is still surfaceable).\n\n' +
        'Stay 4-layer: routes parse + call one service method; the service owns ' +
        'the transaction + the throttle; creation goes through ' +
        '`workItemsService`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A cross-org authenticated account submits a request on a public ' +
        'project → a triage `work_item` is created via `workItemsService`, ' +
        'attributed to that account, invisible to the normal tree (it shows in ' +
        'the project’s triage queue); gated by `canSubmitToTriage`, NOT ' +
        '`canEdit`; rate-limited (rapid repeats throttle with a typed error, ' +
        'not a 500).\n' +
        '- The duplicate-detection method returns matching existing public ' +
        'requests for a draft title BEFORE creation; choosing an existing one ' +
        'creates NO new item and routes to upvote (6.12.6); choosing "submit ' +
        'as new" creates the item.\n' +
        '- The match is deterministic (no AI call) and searches only ' +
        'public-facing requests; no raw Prisma in the route; creation reuses ' +
        '6.11.4’s path (no second submissions table).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.3 — `canSubmitToTriage` (the grant this checks) + the public ' +
        'projection the match respects.\n' +
        '- `scripts/plan-seed/data/story-6.11.ts` § 6.11.4 (the intake ' +
        'creation path REUSED) + § 6.11.3 (the triage queue the item lands ' +
        'in).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the create ' +
        'authority; the 6.1.1 FilterAST search (shipped) — the match read ' +
        'reuses it where it fits.\n' +
        '- Canny duplicate detection ' +
        '(https://canny.io/use-cases/feature-request-management) — the ' +
        '"upvote the existing request instead of creating a dupe" behaviour.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer; the 6.11.4 rate-limit precedent.',
      dependsOn: ['6.12.3', '6.11.4'],
    },
    {
      id: '6.12.6',
      title:
        'Upvoting + comments on public requests — the vote model (the demand signal the triage queue sorts by)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The two remaining public-viewer writes — UPVOTE and COMMENT — over ' +
        'the 6.12.3 `PublicRequestVote` model + the 6.11.3 queue. Per ' +
        '6.12.2:\n\n' +
        '- **Upvote (one per account per item, server-enforced):** a service + ' +
        'route that records a `PublicRequestVote(workItemId, userId)` for the ' +
        'signed-in account, gated by 6.12.3’s `canUpvotePublicRequest` (any ' +
        'authed account on a public project) — NOT `canEdit`. The unique ' +
        '`(workItemId, userId)` makes a second upvote a no-op / toggle (never a ' +
        'double count); the vote COUNT becomes a sort key the 6.11.3 triage ' +
        'queue reads (so the project admin sees the highest-demand requests ' +
        'first — the demand signal). Lock-before-read-derived-update where a ' +
        'concurrent vote could race the count.\n' +
        '- **Comment on a public request:** a service + route that adds a ' +
        'comment to the public request, attributed to the signed-in cross-org ' +
        'account, gated by `canCommentPublicRequest` — NOT `canEdit`. These ' +
        'PUBLIC-REQUEST comments are visible on the public surface (distinct ' +
        'from the issue’s INTERNAL comments, which the 6.12.4 projection hides ' +
        '— 6.12.2 fixes that line). Reuse the existing comment ' +
        'model/service where the request is a `work_item` with a comment ' +
        'thread; mark the public-request comments as public-visible.\n\n' +
        'Stay 4-layer: routes parse + call one service method; the vote/comment ' +
        'writes own their transaction; the count sort threads into the 6.11.3 ' +
        'queue read.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A signed-in cross-org account upvotes a public request → one vote ' +
        'recorded; a second upvote from the same account is a no-op / toggle ' +
        '(the unique `(workItemId, userId)` holds, no double count); gated by ' +
        '`canUpvotePublicRequest`, NOT `canEdit`.\n' +
        '- The vote count is a sort key the 6.11.3 triage queue reads ' +
        '(highest-demand-first); a concurrent vote serializes via the row lock ' +
        '(no lost update).\n' +
        '- A signed-in cross-org account comments on a public request → the ' +
        'comment is attributed + public-visible; gated by ' +
        '`canCommentPublicRequest`, NOT `canEdit`; the issue’s internal ' +
        'comments remain hidden by the 6.12.4 projection.\n' +
        '- 4-layer respected (vote/comment writes through a service → ' +
        'repository / `workItemsService`; no raw Prisma in routes).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.3 — the `PublicRequestVote` model + ' +
        '`canUpvotePublicRequest` / `canCommentPublicRequest` grants.\n' +
        '- `scripts/plan-seed/data/story-6.11.ts` § 6.11.3 — the triage queue ' +
        'the vote-count sort feeds.\n' +
        '- `motir-core/lib/services/workItemsService.ts` + the existing ' +
        'comment model/service — the comment thread reused.\n' +
        '- Canny feature voting ' +
        '(https://canny.io/blog/feature-voting-best-practices/) — the upvote ' +
        '+ comment-on-the-request behaviour.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the ' +
        'lock-before-read-derived-update rule.',
      dependsOn: ['6.12.3', '6.11.3'],
    },
    {
      id: '6.12.7',
      title: 'The public roadmap view — status tracking (submitted → planned → in_progress → done)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Build the public ROADMAP per the 6.12.1 design, over the 6.12.4 ' +
        'public projection. The status-grouped, vote-counted public view of a ' +
        'project’s public-facing items — the Canny / Productboard / Featurebase ' +
        'public-roadmap shape.\n\n' +
        '- **Status grouping:** columns by a public-facing status mapping — ' +
        '**submitted → planned → in progress → done** — derived from the ' +
        'project’s workflow statuses (decide the mapping from the real status ' +
        'set to these four public buckets; a status not meant to be public — ' +
        'e.g. canceled / triage — is NOT shown). Each card shows the request ' +
        'title + kind + **vote count** + a link to the public request detail ' +
        '(6.12.6 upvote/comment).\n' +
        '- **The read** goes through the public projection (6.12.4) so no ' +
        'internal field leaks; it is paginated / lazy per column (the at-scale ' +
        'rule — a busy public roadmap is unbounded). As the project admin ' +
        'advances an item’s status (via the normal internal flow), the public ' +
        'roadmap reflects the new bucket.\n' +
        '- **The view UI** uses ONLY shipped `components/ui/*` + `--el-*` / ' +
        '`[data-display-style]` tokens, renders the empty-roadmap + loading + ' +
        'error states, and uses the palette for the per-status tones (not ' +
        'grey-only).\n\n' +
        'Stay 4-layer: the route parses + calls one service method returning ' +
        'the public roadmap projection (grouped + counted); no raw Prisma in ' +
        'the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The public roadmap renders status-grouped columns (submitted → ' +
        'planned → in progress → done) of public-facing items, each with its ' +
        'vote count + a link to the request, per the 6.12.1 design; ' +
        'non-public statuses (canceled / triage) are not shown.\n' +
        '- The read uses the 6.12.4 public projection (no internal field leaks) ' +
        'and is paginated / lazy; advancing an item’s status moves it to the ' +
        'right bucket.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; empty / loading / error states render; per-status ' +
        'tones use the palette (AA-safe).\n' +
        '- 4-layer respected (the roadmap projection in the service/repository, ' +
        'no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.4 — the public projection the roadmap read derives from + the ' +
        'design (6.12.1) it renders.\n' +
        '- `motir-core/lib/workflows/defaultWorkflow.ts` + the project status ' +
        'set — the source statuses mapped to the four public buckets.\n' +
        '- Canny roadmap (https://canny.io/use-cases/feature-request-' +
        'management) + Productboard portal ' +
        '(https://support.productboard.com/hc/en-us/articles/360056315454) — ' +
        'the status-column + vote-count public roadmap mirrored.\n' +
        '- `motir-core/components/ui/*` + `app/globals.css`; ' +
        '`motir-core/CLAUDE.md` § colour + shape tokens.',
      dependsOn: ['6.12.4'],
    },
    {
      id: '6.12.8',
      title: 'Project settings — the "make public" toggle + the shareable public link',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Extend project settings with the FOUR-level Access control + the ' +
        'shareable public link, per the 6.12.1 design, over the 6.12.3 access ' +
        'extension. This is how a project admin turns a project public.\n\n' +
        '- **The make-public toggle:** extend the existing 6.4 Access control ' +
        '(open / limited / private) to the FOUR levels ' +
        '**public > open > limited > private**, with the explanatory copy ' +
        '(public = any signed-in Motir account, across orgs, can view + ' +
        'submit/upvote/comment). Setting `public` calls the 6.4 ' +
        '`setAccessLevel` service (now accepting the new enum value); ' +
        'project-admin-gated (reuse the 6.4 project-admin check — non-admins ' +
        'see it read-only).\n' +
        '- **The shareable public link:** a per-project public link (a stable ' +
        'public slug / route to the public view) shown when the project is ' +
        'public, with copy + disable + rotate. The link is an ENTRY POINTER — ' +
        'it still requires sign-in (account-required, not an unauthenticated ' +
        'bypass); decide the slug model so a project can rotate/disable its ' +
        'public link without changing the project key.\n' +
        '- **Design-system compliance:** ONLY `--el-*` + `[data-display-' +
        'style]` tokens + shipped `components/ui/*`; the access-level copy + ' +
        'the account-required note per the 6.12.1 design; inline edits follow ' +
        'the no-whole-tree-refresh rule (a success response is the ' +
        'confirmation).\n\n' +
        'Stay 4-layer: the route parses + calls one service method ' +
        '(`setAccessLevel` / the link rotate/disable); project-admin-gated; no ' +
        'raw Prisma in the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Access control renders all FOUR levels ' +
        '(public > open > limited > private) with copy; setting `public` ' +
        'persists via the 6.4 `setAccessLevel` service; project-admin-gated ' +
        '(read-only for non-admins).\n' +
        '- A shareable public link appears when the project is public, with ' +
        'copy / disable / rotate; the link requires sign-in (account-required, ' +
        'no unauthenticated bypass); rotating/disabling does not change the ' +
        'project key.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        'primitives; matches the 6.12.1 design; inline edits use the ' +
        'success-response-is-confirmation pattern.\n' +
        '- 4-layer respected (route → service; no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- 6.12.1 (design asset — required), 6.12.3 (the `public` enum value + ' +
        'access extension).\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` § 6.4.4 (`setAccessLevel` ' +
        'service) + § 6.4.5 (the project-settings Access UI this extends) — ' +
        'mirror + extend, do not fork.\n' +
        '- `motir-core/components/ui/*` + `app/globals.css`; ' +
        '`motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens + the ' +
        'inline-edit no-whole-tree-refresh rule.',
      dependsOn: ['6.12.1', '6.12.3'],
    },
    {
      id: '6.12.9',
      title:
        'Tests (vitest) — access enforcement (cross-org read, writes blocked except triage/vote/comment) + dedupe + voting',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the load-bearing guarantees: (1) `public` access enforces ' +
        'cross-org READ but blocks every write except the three grants, (2) ' +
        'duplicate detection matches, and (3) voting is one-per-account. On a ' +
        'real Postgres (the standing rule), covering:\n\n' +
        '- **Access matrix.** A cross-org account (no membership in the ' +
        'project’s org/workspace) can READ a `public` project ' +
        '(`canBrowse` true cross-org) but `canEdit` is FALSE — assert every ' +
        'normal write (create / move / assign / status / field-edit) is ' +
        'rejected. The three grants succeed: `canSubmitToTriage`, ' +
        '`canUpvotePublicRequest`, `canCommentPublicRequest` each allow their ' +
        'write for a cross-org authed account on a public project. A NON-public ' +
        'project the same account hits is 404-not-403 (the cross-org read ' +
        'exception is public-only). An UNauthenticated request is rejected ' +
        '(account-required).\n' +
        '- **The public projection.** Assert the public read shape EXCLUDES ' +
        'assignees, estimates, and internal comments from the payload (not just ' +
        'the DOM) while including the public-safe fields + public-request ' +
        'comments.\n' +
        '- **Duplicate detection.** A draft title matching an existing public ' +
        'request returns the candidate(s) before creation; choosing it creates ' +
        'NO new item; "submit as new" creates one. The match is deterministic ' +
        '(no AI).\n' +
        '- **Voting.** One vote per account per item (the unique ' +
        '`(workItemId, userId)` holds; a second upvote is a no-op / toggle, no ' +
        'double count); the vote count is the 6.11.3 queue sort key (assert the ' +
        'queue orders by demand); a concurrent vote serializes via the row ' +
        'lock.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The access matrix is asserted: cross-org READ allowed on public, ' +
        'every normal write blocked, the three grants allowed, non-public ' +
        '404-not-403 cross-org, unauthenticated rejected.\n' +
        '- The public projection’s hidden-field exclusion is asserted at the ' +
        'payload level; duplicate detection (match → upvote-existing vs ' +
        'submit-new) and one-vote-per-account + the queue sort are each ' +
        'asserted.\n' +
        '- New service/repository code respects the per-file coverage gate ' +
        '(CLAUDE.md § coverage); the empty-input / no-membership / ' +
        'already-voted guards each have a direct test; tests use the real ' +
        'Postgres helper.\n\n' +
        '## Context refs\n\n' +
        '- 6.12.3 (access extension + grants + vote model), 6.12.4 (the ' +
        'projection), 6.12.5 (dedupe), 6.12.6 (voting + comments).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the per-file ' +
        'coverage gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the per-test truncation harness.',
      dependsOn: ['6.12.5', '6.12.6'],
    },
    {
      id: '6.12.10',
      title:
        'E2E (playwright) — a second account (different org) reads a public project read-only, submits (dedupe → upvote), comments; a non-public project is not viewable cross-org',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** e2e (playwright) — the full cross-org public-project loop ' +
        'in a browser, proving the access exception + the portal set end to ' +
        'end with a SECOND Motir account in a DIFFERENT org.\n\n' +
        'The flow:\n\n' +
        '1. As the `motir` project admin, set the project **public** in ' +
        'project settings (6.12.8) and copy the shareable public link.\n' +
        '2. Sign in as a SECOND, seeded Motir account in a DIFFERENT org with ' +
        'NO membership in the public project’s org/workspace. Open the public ' +
        'link → the read-only board / issue list + the public roadmap render; ' +
        'assert there are NO edit affordances and that ' +
        '**assignees / estimates / internal comments are absent**.\n' +
        '3. Submit a feature request whose title matches an EXISTING public ' +
        'request → the duplicate-detection surfaces the existing one → choose ' +
        '**"upvote this instead"** → the vote count increments and NO duplicate ' +
        'is created. Then add a **comment** on that public request → it ' +
        'appears.\n' +
        '4. Submit a genuinely-NEW request → it lands in the project’s triage ' +
        'queue (verify as the admin it appears there, attributed to the ' +
        'second account, and is absent from the normal tree until promoted).\n' +
        '5. Confirm the cross-org EXCLUSION: the same second account navigating ' +
        'to a NON-public project of that org is NOT able to view it ' +
        '(404-not-403) — proving public is the only cross-org read exception.\n\n' +
        'Mind the prodect e2e selector + harness gotchas (combobox option = ' +
        'label + secondary; exact/level on heading selectors; the empty-state ' +
        'headings; run the dev server yourself + reuse it). Drive the real UI, ' +
        'not API shortcuts; use a second browser context for the second ' +
        'account.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The second (different-org) account opens the public project ' +
        'read-only: board / issues / roadmap render, no edit affordances, ' +
        'internal fields (assignee / estimate / internal comments) absent.\n' +
        '- Submitting a matching-title request surfaces the dedupe and the ' +
        '"upvote this instead" path (vote increments, no duplicate); a comment ' +
        'on the request appears; a genuinely-new request lands in the admin’s ' +
        'triage queue attributed to the second account, absent from the tree.\n' +
        '- The second account CANNOT view a non-public project of that org ' +
        '(404-not-403) — public is the only cross-org read exception.\n' +
        '- The test drives the real UI (no API-only shortcuts), uses a second ' +
        'browser context, and follows the prodect E2E selector + run-harness ' +
        'conventions.\n\n' +
        '## Context refs\n\n' +
        '- 6.12.4 (the public view) + 6.12.8 (the make-public toggle + share ' +
        'link) — the surfaces driven; 6.12.5/6.12.6/6.12.7 (submit/dedupe/' +
        'upvote/comment/roadmap) exercised through them.\n' +
        '- `scripts/plan-seed/data/story-6.11.ts` § 6.11.9 — the triage e2e ' +
        'whose harness + the promote-from-queue step this builds on.\n' +
        '- `motir-core/e2e/` — the existing Playwright specs + the run-harness ' +
        '+ selector conventions to mirror.',
      dependsOn: ['6.12.4', '6.12.8'],
    },
  ],
};
