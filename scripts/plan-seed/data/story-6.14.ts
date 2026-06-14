import type { PlanStory } from '../types';

/**
 * Story 6.14 (Epic 6) — Epic-level privacy on public projects. On a project that
 * has been made **public** (Story 6.12), the project admin can mark an individual
 * **EPIC** as **private**: everyone — any signed-in account, any public/non-member
 * viewer — still sees the epic ROW (its title stays visible), but a private epic
 * **HIDES ALL of its children** (stories / tasks / subtasks) plus the epic's
 * aggregate TELLS (child count / progress / point totals) from public/non-member
 * viewers, replacing them with a "this epic is not public" placeholder. Project
 * MEMBERS see everything normally. This is a pure motir-core, per-project
 * capability layered on 6.12; it touches no AI boundary and carries zero forward
 * dependency (every dep is ≤ 6.14: 6.14.x / 6.12.x / 6.4.x[done] / Epic-2[done]).
 *
 * **The locked model (Yue, 2026-06-12): an epic-kind privacy flag, scoped to
 * public projects, enforced SERVER-SIDE on EVERY read path.** A private epic is
 * NOT a deletion and NOT a 404 — the epic row remains in the public tree as a
 * deliberate, visible placeholder ("this epic exists, but its contents are not
 * public"). The flag lives on `work_item` and is meaningful ONLY for epic-kind
 * items on a `public` project; on a non-public project it is a no-op (members are
 * the only viewers anyway, and 6.12's cross-org read exception is the only thing
 * that makes "public/non-member viewer" a real population). The load-bearing
 * requirement is that a private epic's children must NEVER be transmitted to a
 * public/non-member viewer by ANY read path — the tree projection, the work-item
 * detail child-panel, the 6.12 public board, the 7.0 ready set, and the 6.1
 * FilterAST search are ALL filtered server-side, so nothing leaks over the wire
 * (no client-only hiding, nothing visible in the network tab). The epic row also
 * must not leak its aggregate tells (child count / progress / point rollup) to
 * public viewers — those are stripped from the public projection and replaced by
 * a "private" marker. Project MEMBERS bypass the exclusion entirely (they see the
 * children and the real rollups), exactly as they do today.
 *
 * **This EXTENDS 6.12's public-read gating, it does not fork it.** 6.12 shipped
 * the `public` access level + the public PROJECTION (the read shape that strips
 * internal-only fields — assignees / estimates / internal comments — at the
 * service/repository read layer) + the `canBrowse`-cross-org branch. The whole
 * surface a public viewer reads (board / issues / roadmap) flows through that
 * 6.12.4 projection. 6.14 adds ONE more rule to that SAME projection: when the
 * viewer is a non-member AND a work item descends from a private epic, the item
 * is excluded (and the private epic row is reduced to title + a "private" marker
 * + the placeholder). Because 6.12 already centralised the public read in a
 * single projection, the epic-privacy filter is a single auditable predicate
 * threaded into that one projection — NOT N independent filters scattered across
 * the tree / detail / board / ready / search reads.
 *
 * **The verified mirror (rung 1, cited not asserted — checked 2026-06-12).**
 *   - **GitLab confidential issues** — an issue visible only to project members
 *     with sufficient role; non-members cannot view it AND it is "hidden in
 *     search results for users without the necessary permissions" — i.e. the
 *     hiding is server-side, applied to search too, not a client toggle. Motir's
 *     analogue raises this from a single issue to an epic SUBTREE (the children),
 *     with the parent row kept as a visible placeholder rather than a hard 404.
 *     (https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html)
 *   - **Jira issue-level security (security schemes / levels)** — "A secured work
 *     item is not visible ANYWHERE in Jira to a user who is not in the work
 *     item's security level": the enforcement is total and server-side, applied
 *     across every view and search, and a Jira ADMIN can always add themselves to
 *     a level — the exact "members bypass the exclusion" shape. Motir mirrors the
 *     server-enforced-hidden-with-no-leak posture (with a placeholder for the
 *     epic row rather than total invisibility, because the row staying visible is
 *     a deliberate public-transparency choice — GitLab-confidential + a "kept
 *     row" placeholder). (https://confluence.atlassian.com/adminjiraserver/configuring-issue-level-security-938847117.html)
 *   - **Canny / Productboard per-item public-roadmap visibility** — the
 *     public-feedback-portal mirror (the same rung-1 portal 6.12 mirrors) ships a
 *     "what shows on the public roadmap" visibility control: Canny scopes the
 *     public end-user roadmap by status/board toggles (an unchecked board "will
 *     not display" on the portal), and Productboard portals show non-members
 *     ONLY public-facing items with item visibility restricted by the portal's
 *     controls. That is the "show on public roadmap" toggle Motir productizes at
 *     epic granularity — the admin decides which epics' contents are public.
 *     (https://help.canny.io/en/articles/3828148-public-roadmap,
 *     https://support.productboard.com/hc/en-us/articles/360056315454)
 *
 * **Why the kept-row-with-placeholder shape is the durable one (no shortcut).**
 * The naive alternatives both fail: a hard 404 on the epic row would make the
 * project look incomplete to the public (a gap in the roadmap with no
 * explanation), and a client-side hide would leak the children over the wire (the
 * exact GitLab/Jira anti-pattern the server-side enforcement exists to prevent).
 * Keeping the row as a deliberate "not public" placeholder gives the public an
 * honest, complete-looking outline ("there are N epics; this one's details are
 * private") while the SERVER guarantees nothing under it — no child, no count, no
 * progress — ever reaches a non-member. The cost (every public read path must
 * honour the descended-from-private-epic predicate) is paid once, centrally, in
 * the 6.12.4 projection (6.14.4), and locked by tests asserting exclusion at
 * EVERY path (tree / detail child-panel / board / ready / search) so a future
 * read can't leak a private epic's children.
 *
 * **Scale (finding #57).** The public surfaces this filters are already the
 * unbounded, internet-facing reads 6.12 paginated/cursor'd; the epic-privacy
 * predicate is an indexable column on `work_item` joined through the existing
 * parent/ancestor walk, so it adds a cheap `where` clause to those paginated
 * reads — never a load-all post-filter in app memory.
 *
 * **Design gate.** New user-facing surfaces ship here — the "this epic is not
 * public" placeholder (in the tree on expand AND in the detail child-panel), the
 * private epic's public row appearance (title + a private badge, NO count /
 * progress / point leak), and the project-admin "set epic private" control on the
 * epic. So the FIRST subtask (6.14.1) is a `design` card producing the
 * multi-panel mock + design-notes under `design/epic-privacy/`, composing only
 * shipped `components/ui/*` primitives + `--el-*` / `[data-display-style]` tokens.
 * Every UI code subtask (6.14.5 / 6.14.6 / 6.14.7) depends on it and is `blocked`.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * `dependsOn` id's story number is ≤ 6.14: same-story 6.14.x, or backward to
 * 6.12.x (the public access level + the public projection — being planned, so
 * deps on it are `blocked`) and 6.4.x (project roles / admin — DONE/shipped) and
 * Epic-2 (the shipped `workItemsService` write authority). 6.14.1 (design) and
 * 6.14.2 (decision) have `dependsOn: []` → `planned`; everything chained behind
 * them or behind 6.12.x / 6.14.3 → `blocked`.
 */
export const story_6_14: PlanStory = {
  id: '6.14',
  title: 'Epic-level privacy on public projects',
  status: 'planned',
  gitBranch: 'feat/PROD-6.14-epic-privacy',
  descriptionMd:
    'On a **public** project (Story 6.12), let the project admin mark an ' +
    'individual **EPIC** as **private**. Everyone — any signed-in account, any ' +
    'public/non-member viewer — still sees the epic ROW (its title stays ' +
    'visible), but a private epic **HIDES ALL its children** (stories / tasks / ' +
    'subtasks) and its aggregate TELLS (child count / progress / point totals) ' +
    'from public/non-member viewers, replacing them with a **"this epic is not ' +
    'public"** statement. Project MEMBERS see everything normally. A pure ' +
    'motir-core, per-project capability layered on 6.12 — no AI boundary, no ' +
    'forward dependency.\n\n' +
    '**The model (locked — see the module header for the full rationale + the ' +
    'verified mirror):**\n\n' +
    '- **An epic-kind privacy flag on `work_item`, scoped to public projects.** ' +
    'The flag is meaningful only for an EPIC on a `public` project; on a ' +
    'non-public project it is a no-op (members are the only viewers, and 6.12’s ' +
    'cross-org read exception is what makes "public/non-member viewer" a real ' +
    'population at all). It is NOT a deletion and NOT a 404 — the epic row stays ' +
    'a deliberate, visible "not public" placeholder.\n' +
    '- **SERVER-SIDE enforcement on EVERY read path (the load-bearing rule).** A ' +
    'private epic’s children must NEVER be transmitted to a public/non-member ' +
    'viewer by ANY read — the tree projection, the work-item detail child-panel, ' +
    'the 6.12 public board, the 7.0 ready set, and the 6.1 FilterAST search are ' +
    'ALL filtered server-side, so nothing leaks over the wire (no client-only ' +
    'hide, nothing in the network tab). The epic row’s aggregate tells (child ' +
    'count / progress / point rollup) are stripped from the public projection ' +
    'too — just title + a "private" marker + the placeholder.\n' +
    '- **Members bypass.** A project member (6.4) reads the children and the ' +
    'real rollups exactly as today; the exclusion applies ONLY to a ' +
    'public/non-member viewer (the 6.12 cross-org population). The ' +
    'project ADMIN (6.4) is who sets/unsets an epic private.\n' +
    '- **Extends 6.12’s public PROJECTION, never forks it.** 6.12 centralised ' +
    'the public read in a single projection (6.12.4) that already strips ' +
    'internal fields; 6.14 threads ONE more predicate (descended-from-a-private-' +
    'epic → excluded for non-members) into that SAME projection, as a single ' +
    'auditable branch, not N scattered filters.\n\n' +
    '**The "this epic is not public" statement appears in TWO places:** (a) when ' +
    'a public viewer EXPANDS the private epic in the work-item TREE (the children ' +
    'rows are replaced by the placeholder), and (b) the CHILD PANEL on the epic’s ' +
    'work-item DETAIL page (the panel that would list children shows the ' +
    'statement instead).\n\n' +
    '**Scope:** the placeholder + admin-control + private-row design (6.14.1); ' +
    'the epic-privacy-model decision — flag, semantics, server-side-everywhere ' +
    'enforcement, public-project scope (6.14.2); the schema flag + migration ' +
    '(6.14.3); the SERVER-SIDE enforcement across every read path + the ' +
    '"children hidden" marker (6.14.4); the tree placeholder UI (6.14.5); the ' +
    'detail child-panel placeholder UI (6.14.6); the project-admin set/unset ' +
    'control (6.14.7); the enforcement + toggle tests (6.14.8); the public-' +
    'viewer-vs-member e2e (6.14.9).\n\n' +
    '**Out of scope (named so they land in their own story, not here):** ' +
    'story-level / task-level privacy (this story is EPIC-granularity — the ' +
    'mirror’s per-item security generalises, but Yue’s spec is epic-level and a ' +
    'finer grain is a later story); a per-VIEWER allow-list on a private epic ' +
    '(GitLab’s "assigned non-members can still see it" — Motir’s line is ' +
    'member-vs-non-member, no per-item grants); hiding the epic ROW itself ' +
    '(deliberately kept as a placeholder — full invisibility is a different, ' +
    'non-goal); and ANONYMOUS public access (6.12 already scoped that out — a ' +
    'viewer is always a signed-in account).',
  verificationRecipeMd:
    '- Pull the Story branch; run the migration + `pnpm db:seed` against the ' +
    'local Postgres (`localhost:5433`); `pnpm dev`. Use a project already made ' +
    '**public** (6.12) with at least one epic that has children.\n' +
    '- **Set an epic private (admin).** As the `motir` project admin, open an ' +
    'epic and use the "set epic private" control (6.14.7) to mark it private; ' +
    'confirm the control is project-admin-gated (a non-admin member does not see ' +
    'the toggle, or sees it read-only).\n' +
    '- **Public viewer — the tree (the load-bearing check).** Sign in as a ' +
    'SECOND Motir account in a DIFFERENT org with NO membership in the project ' +
    '(the 6.12 cross-org public viewer). Open the public project tree → the ' +
    'private epic ROW is still visible (title shown), but it carries a "private" ' +
    'badge and NO child count / progress / point total; EXPAND it → instead of ' +
    'children, the **"this epic is not public"** placeholder renders. Open the ' +
    'browser network tab and confirm the children are ABSENT from the response ' +
    'payload (not merely hidden in the DOM) — nothing under the private epic ' +
    'crosses the wire.\n' +
    '- **Public viewer — the detail child-panel.** Open the private epic’s ' +
    'work-item DETAIL page as the same public viewer → the CHILD PANEL shows the ' +
    '"this epic is not public" statement instead of a child list; again confirm ' +
    'the payload carries no children.\n' +
    '- **Public viewer — every OTHER read path.** Confirm the private epic’s ' +
    'children are absent from: the 6.12 public BOARD, the 7.0 ready SET, and a ' +
    '6.1 SEARCH that would otherwise match a child’s title — all for the public ' +
    'viewer, all server-side.\n' +
    '- **Member bypass.** Sign in as a PROJECT MEMBER → the same epic shows its ' +
    'children normally, with the real child count / progress / point rollup; the ' +
    'tree-expand and the detail child-panel list the children (no placeholder, ' +
    'no stripped tells). Unset the epic’s privacy as the admin → the public ' +
    'viewer now sees the children too.\n' +
    '- `pnpm test` (6.14.8) covers: a public/non-member viewer CANNOT read a ' +
    'private epic’s children via ANY path (tree / detail child-panel / board / ' +
    'ready / search) — asserted at the PAYLOAD level, not the DOM — and the ' +
    'aggregate tells are stripped; a MEMBER reads them; the admin toggle ' +
    'set/unset flips enforcement; the flag is a no-op on a non-public project; ' +
    'all on a real Postgres respecting the per-file coverage gate.\n' +
    '- **4-layer + token review.** No raw Prisma in any route; the epic-privacy ' +
    'predicate lives in the 6.12.4 public projection at the service/repository ' +
    'read layer (one auditable branch, not N filters); the set/unset write ' +
    'routes through a service → `workItemsService`; the placeholder + badge + ' +
    'admin control reference only `--el-*` / `[data-display-style]` tokens + ' +
    'shipped `components/ui/*`.\n' +
    '- **Dep audit.** Confirm no 6.14 subtask references any id > 6.14 (deps are ' +
    '6.14.x / 6.12.x / 6.4.x / Epic-2 only).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '6.14.1',
      title:
        'Design — the "this epic is not public" placeholder (tree-expand + detail child-panel) + the private-epic public row + the project-admin set-private control',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** design (THE design gate — produced FIRST; every UI code ' +
        'subtask here — 6.14.5, 6.14.6, 6.14.7 — depends on this card and is ' +
        '`blocked` until it lands). Produce the surface design assets under ' +
        '`motir-core/design/epic-privacy/`, composing ONLY shipped ' +
        '`components/ui/*` primitives + `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (NO Tier-0 `--color-*`, no ' +
        'hand-rolled spacing/radius), mirroring 7.0.1’s multi-panel design-card ' +
        'shape.\n\n' +
        'The surfaces to draw (every panel — the multi-panel rule, mistake ' +
        '#31):\n\n' +
        '- **Panel 1 — the private epic’s PUBLIC row (in the tree + the ' +
        'roadmap/board).** How a private epic appears to a public/non-member ' +
        'viewer: the epic title + kind icon (`IssueTypeIcon`) STILL shown, plus ' +
        'a **"private" badge** (a `Pill` tone) that reads e.g. "Not public", and ' +
        'crucially NO child count, NO progress bar / rollup, NO point total — ' +
        'draw the row deliberately WITHOUT those aggregate tells (contrast it ' +
        'with a normal epic row that DOES show count/progress so the difference ' +
        'is explicit in the mock). Note in writing that the tells are stripped ' +
        'server-side, not just visually omitted.\n' +
        '- **Panel 2 — the TREE-EXPAND placeholder.** When the public viewer ' +
        'EXPANDS the private epic in the work-item tree, the children rows are ' +
        'replaced by a single **"this epic is not public"** placeholder row (an ' +
        '`EmptyState`-family inline panel) — the exact copy, the icon, and the ' +
        'one-line explanation ("The project admin has kept this epic’s contents ' +
        'private."). Draw it inline at the child-indent level so it reads as ' +
        '"this is where the children would be".\n' +
        '- **Panel 3 — the DETAIL child-panel placeholder.** On the epic’s ' +
        'work-item DETAIL page, the CHILD PANEL (the panel that lists ' +
        'children/sub-issues) shows the same "this epic is not public" statement ' +
        'instead of a child list — drawn in the detail-page child-panel slot ' +
        '(distinct framing from the inline tree row; same copy + tone).\n' +
        '- **Panel 4 — the project-admin "set epic private" control.** The ' +
        'control the project admin (6.4) uses on the epic to set/unset private — ' +
        'e.g. a toggle / segmented control in the epic’s actions or settings ' +
        'area, with explanatory copy ("Private epics stay visible as a row to ' +
        'the public, but their stories/tasks and progress are hidden from ' +
        'non-members."), its ON and OFF states, and the project-admin-gated / ' +
        'read-only-for-non-admins treatment.\n' +
        '- **Panel 5 — the MEMBER view (the contrast / control case).** The ' +
        'SAME private epic as a project MEMBER sees it: children present, real ' +
        'count / progress / points shown, NO placeholder — so the mock makes the ' +
        'member-bypass explicit and the reviewer can see exactly what the public ' +
        'viewer is denied.\n' +
        '- **Panel 6 — states.** The placeholder’s appearance in a dense tree ' +
        '(many siblings), the badge at the board/roadmap card scale, and the ' +
        'admin control’s loading / disabled (non-admin) / error states.\n\n' +
        'Write **`design/epic-privacy/design-notes.md`** naming every primitive ' +
        'composed (e.g. `IssueTypeIcon` for the epic hue, `Pill` for the ' +
        '"private" badge tone, the `EmptyState` family for the placeholder, the ' +
        'toggle/segmented primitive for the admin control), the EXACT copy for ' +
        'the placeholder (tree + detail), the badge label, and the admin-control ' +
        'explanation + states, the per-`--el-*` colour role for every element ' +
        '(use the palette, not grey-only — finding #54; e.g. the "private" badge ' +
        'tint, the placeholder’s muted-but-legible tone), and a "primitives ' +
        'composed (no hand-rolling)" checklist. It MUST state, in writing, that ' +
        '(a) the epic ROW stays visible (title + badge) while its children + ' +
        'aggregate tells (count / progress / points) are ABSENT for public ' +
        'viewers, (b) the same "not public" copy appears in BOTH the tree-expand ' +
        'and the detail child-panel, (c) members see everything (no placeholder), ' +
        'and (d) the set-private control is project-admin-gated.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/epic-privacy/*.mock.html` renders the six panels above, ' +
        'referencing ONLY `--el-*` + `[data-display-style]` tokens (no Tier-0 ' +
        '`--color-*`, no hand-rolled spacing/radius) + shipped ' +
        '`components/ui/*`.\n' +
        '- The private-epic public row is drawn with title + "private" badge and ' +
        'WITHOUT child count / progress / point total (contrasted against a ' +
        'normal epic row that shows them); the member-view panel shows the same ' +
        'epic WITH children + rollups.\n' +
        '- The "this epic is not public" placeholder is drawn in BOTH the ' +
        'tree-expand (inline at child indent) and the detail child-panel slots, ' +
        'with identical copy; the project-admin set-private control is drawn ' +
        'with ON/OFF + the admin-gated / read-only-for-non-admins states.\n' +
        '- `design-notes.md` names every primitive + the exact placeholder / ' +
        'badge / admin-control copy + the per-element `--el-*` role, and states ' +
        'the row-visible / children-and-tells-absent / two-places / ' +
        'member-bypass / admin-gated invariants; AA contrast holds for the ' +
        '"private" badge tint + the placeholder text.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 — the multi-panel ' +
        'design-card shape to mirror.\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.1 — the public ' +
        'project-view / board / roadmap design this composes with (the public ' +
        'row + the public surfaces the badge/placeholder appear on).\n' +
        '- GitLab confidential issues ' +
        '(https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html) ' +
        '+ Canny public-roadmap visibility ' +
        '(https://help.canny.io/en/articles/3828148-public-roadmap) — the ' +
        'hidden-from-non-members + "what shows publicly" surfaces being ' +
        'mirrored.\n' +
        '- `motir-core/components/ui/*`, `app/globals.css` (the `--el-*` + ' +
        '`[data-display-style]` token layers), `motir-core/CLAUDE.md` § colour + ' +
        'shape tokens; `IssueTypeIcon` / `Pill` / `EmptyState` (the kind-hue + ' +
        'badge + placeholder primitives).',
      dependsOn: [],
    },
    {
      id: '6.14.2',
      title:
        'Decision — the epic-privacy model: the epic-kind flag, server-side-everywhere enforcement, members-bypass, public-project scope, the aggregate-tell strip',
      status: 'done',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR the schema + enforcement cards ' +
        '[6.14.3+] build against; no app behavior ships, but the shapes it fixes ' +
        'are load-bearing). Write ' +
        '`motir-core/docs/decisions/epic-privacy.md`, EXTENDING (not forking) ' +
        '6.12’s public-projection ADR. It MUST fix:\n\n' +
        '1. **The model: an epic-kind privacy flag on `work_item`.** Decide the ' +
        'flag shape — a `publicChildrenHidden: boolean @default(false)` column ' +
        '(or an epic `visibility` enum `public | private_children`; pick the ' +
        'boolean unless the enum buys a named future state, and justify). It is ' +
        'meaningful ONLY for an EPIC-kind item; setting it on a non-epic is ' +
        'rejected (or ignored) — state which and why. The epic ROW is NEVER ' +
        'hidden by it; only the epic’s DESCENDANTS + its aggregate tells are.\n' +
        '2. **Scoped to public projects (no-op otherwise).** The flag changes ' +
        'NOTHING on a non-public project: members are the only viewers there, ' +
        'and 6.12’s cross-org read exception is the only thing that creates a ' +
        '"public/non-member viewer" population. State that the enforcement ' +
        'branch is reached ONLY for a non-member viewer on a `public` project, ' +
        'so the flag is inert (a no-op) everywhere else — including for a member ' +
        'on a public project.\n' +
        '3. **SERVER-SIDE enforcement on EVERY read path (the load-bearing ' +
        'requirement).** Enumerate the EXACT read paths a private epic’s ' +
        'children must be excluded from for a public/non-member viewer: the TREE ' +
        'projection, the work-item DETAIL child-panel read, the 6.12 public ' +
        'BOARD, the 7.0 ready SET, and the 6.1 FilterAST SEARCH. Fix that the ' +
        'exclusion is a SINGLE predicate threaded into 6.12’s public PROJECTION ' +
        '(the read shape 6.12.4 already centralises) — "the item descends from a ' +
        'private epic" → excluded — NOT N independent filters, so a future read ' +
        'that goes through the projection inherits it and cannot leak. State ' +
        'explicitly that the children must be EXCLUDED at the read/service layer ' +
        '(never sent), not hidden client-side (no leak in the API/network tab).\n' +
        '4. **The aggregate-tell strip + the "children hidden" marker.** Fix ' +
        'that the public projection of a private epic ROW carries title + kind + ' +
        'status + a "private"/"children-hidden" MARKER, but NOT the child count, ' +
        'progress / rollup, or point total (those are tells that leak the hidden ' +
        'subtree’s shape). Decide how the marker is represented in the ' +
        'projection DTO (e.g. a `childrenHidden: true` flag + `childCount` / ' +
        '`progress` omitted-or-null) so the UI (6.14.5/6.14.6) can render the ' +
        'placeholder without ever receiving a child.\n' +
        '5. **Members bypass; admin sets the flag.** A PROJECT MEMBER (6.4) ' +
        'reads the children + the real rollups exactly as today — the exclusion ' +
        'predicate is gated on "non-member viewer", so a member never hits it. ' +
        'The PROJECT ADMIN (6.4) is the only role that can set/unset the flag ' +
        '(reuse the 6.4 project-admin check — NOT a new permission). State that ' +
        'no read path may key the exclusion off anything but ' +
        '"non-member-on-public-project + descends-from-private-epic".\n' +
        '6. **The descendant test.** Decide HOW "descends from a private epic" ' +
        'is computed for the exclusion — the work_item tree is epic → story → ' +
        'task/subtask (leaf depth ≤ 3 per the kind-parent matrix), so a child’s ' +
        'epic ancestor is a bounded walk; decide whether to resolve it via the ' +
        'stored parent/ancestor path already used by the tree read or a join, so ' +
        'the predicate stays an indexable `where` clause (finding #57 — no ' +
        'load-all post-filter).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The ADR fixes all six sections, naming the chosen flag shape (+ a ' +
        'one-paragraph justification for boolean-vs-enum and for epic-only) and ' +
        'the descendant-resolution approach as an indexable predicate.\n' +
        '- It enumerates EVERY read path that must exclude a private epic’s ' +
        'children for a non-member (tree, detail child-panel, public board, ' +
        'ready set, FilterAST search) as the checklist 6.14.4 + 6.14.8 implement ' +
        'and test, and fixes that the exclusion is ONE predicate in 6.12’s ' +
        'public projection, not N filters.\n' +
        '- It states the children are EXCLUDED server-side (never transmitted, ' +
        'no network-tab leak), the aggregate tells (count / progress / points) ' +
        'are stripped from the private epic’s public row, and the projection ' +
        'carries a "children-hidden" marker the UI renders.\n' +
        '- It fixes the public-project scope (no-op otherwise), the ' +
        'member-bypass, and the project-admin-only set/unset (reusing the 6.4 ' +
        'admin check).\n' +
        '- It cites the verified mirror (GitLab confidential issues + Jira ' +
        'issue-level security as server-enforced-hidden-with-no-leak, and ' +
        'Canny/Productboard per-item public-roadmap visibility) for the ' +
        'epic-privacy shape.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.2 (the public-access ' +
        'semantics) + § 6.12.4 (the public PROJECTION this extends — the read ' +
        'shape the predicate threads into) + § 6.12.7 (the public roadmap that ' +
        'also honours it).\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` — the project-admin check the ' +
        'set/unset reuses (do not add a new permission).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the write authority ' +
        'the set/unset routes through; the tree / detail-child / ready-set read ' +
        'paths the predicate threads into.\n' +
        '- `prisma/sql/work_item_triggers.sql` — the kind-parent matrix ' +
        '(epic → story → task/subtask) the descendant walk relies on.\n' +
        '- GitLab confidential issues ' +
        '(https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html) ' +
        '— hidden-from-non-members incl. search, server-side; Jira issue-level ' +
        'security ' +
        '(https://confluence.atlassian.com/adminjiraserver/configuring-issue-level-security-938847117.html) ' +
        '— "not visible anywhere to a user not in the level" + admin bypass; ' +
        'Canny public roadmap ' +
        '(https://help.canny.io/en/articles/3828148-public-roadmap) — the ' +
        '"what shows publicly" visibility control.',
      dependsOn: [],
    },
    {
      id: '6.14.3',
      title: 'Schema — the epic-privacy flag on `work_item` (epic-kind) + migration',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'Implement the epic-privacy flag on `work_item` per 6.14.2 — the data ' +
        'model the whole story rides, in ONE migration.\n\n' +
        '- **Schema:** add the flag chosen by 6.14.2 — a ' +
        '`publicChildrenHidden: Boolean @default(false)` column (or the epic ' +
        '`visibility` enum, per the ADR) on `work_item`, with a migration. ' +
        'Existing rows backfill to the non-private default (no behaviour change ' +
        'on deploy). Add the supporting index the exclusion predicate needs (so ' +
        'the descended-from-private-epic check stays an indexable `where`, ' +
        'finding #57). The flag is meaningful only for epic-kind items — enforce ' +
        'that at the write layer (6.14.7) rather than with a DB constraint ' +
        'unless a cheap CHECK fits; document the choice.\n' +
        '- **No enforcement / no UI here:** this card is the column + migration ' +
        '+ the regenerated Prisma types only; the server-side exclusion (6.14.4), ' +
        'the placeholders (6.14.5/6.14.6), and the admin set/unset (6.14.7) land ' +
        'in their own cards. (If the descendant walk needs a stored ' +
        'ancestor/path helper not already present, note it for 6.14.4 rather ' +
        'than building enforcement here.)\n\n' +
        'Stay 4-layer: the column lives in `prisma/schema.prisma`; any FK stays ' +
        'a Prisma `@relation` (CLAUDE.md migration rule — no raw-SQL-only FK).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The migration adds the epic-privacy flag (per 6.14.2) to ' +
        '`work_item` with its default + the supporting index; ' +
        '`prisma migrate dev` reports no drift; existing rows backfill to the ' +
        'non-private default (no behaviour change).\n' +
        '- `prisma generate` types the new field; a vitest (real Postgres) ' +
        'asserts the column defaults to non-private and round-trips on an ' +
        'epic-kind item.\n' +
        '- 4-layer respected (the field in the schema; reads/writes added in ' +
        'later cards); any FK modelled as `@relation`.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.2 — the model decision this implements (the flag shape + the ' +
        'index the predicate needs).\n' +
        '- `motir-core/prisma/schema.prisma` — the `work_item` model the flag ' +
        'is added to.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migration FK-as-`@relation` ' +
        'rule.',
      dependsOn: ['6.14.2'],
    },
    {
      id: '6.14.4',
      title:
        'Server-side enforcement — exclude a private epic’s children + strip its tells from EVERY public read path (tree / detail child-panel / public board / ready set / search)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'The load-bearing correctness work: for a public/non-member viewer, ' +
        'EXCLUDE a private epic’s children — and STRIP the epic row’s aggregate ' +
        'tells — from EVERY read path, server-side, by extending 6.12’s public ' +
        'PROJECTION. Per 6.14.2. Nothing under a private epic may ever be ' +
        'transmitted to a non-member (no leak in the API / network tab).\n\n' +
        '- **The single exclusion predicate, in the 6.12.4 projection.** Thread ' +
        'ONE "descends from a private epic" predicate into the SAME public ' +
        'projection 6.12 centralises, gated on the viewer being a NON-MEMBER on ' +
        'a `public` project: when true, a work item whose epic ancestor has the ' +
        'privacy flag set is EXCLUDED from the projected result. Defined once so ' +
        'every read through the projection inherits it — NOT N independent ' +
        'filters. The predicate is an indexable `where` clause over the ' +
        'parent/ancestor walk (finding #57 — no load-all post-filter).\n' +
        '- **Apply it to every read path (the checklist from 6.14.2):** (1) the ' +
        'TREE projection — children of a private epic are absent; (2) the ' +
        'work-item DETAIL child-panel read — the epic’s child list returns ' +
        'EMPTY-with-marker for a non-member; (3) the 6.12 public BOARD read; (4) ' +
        'the 7.0 ready SET read; (5) the 6.1 FilterAST SEARCH compilation (a ' +
        'child of a private epic does NOT match for a public viewer, mirroring ' +
        'GitLab confidential issues being hidden from search). A parameterized ' +
        'shape so adding a new public read without the predicate is caught by ' +
        '6.14.8.\n' +
        '- **Strip the tells + return the marker.** For a private epic ROW in ' +
        'the public projection, OMIT the child count, progress / rollup, and ' +
        'point total, and SET the "children-hidden" marker (per 6.14.2’s DTO ' +
        'decision, e.g. `childrenHidden: true`) so the UI renders the ' +
        'placeholder without ever receiving a child. The epic title / kind / ' +
        'status stay (the row is a visible placeholder).\n' +
        '- **Members bypass.** The predicate is reached ONLY for a non-member ' +
        'viewer on a public project — a project member’s reads return the ' +
        'children + the real rollups unchanged; a non-public project is a no-op.\n\n' +
        'Stay 4-layer: the predicate + the tell-strip live in the public ' +
        'projection at the service/repository read layer (where 6.12.4 put it), ' +
        'never in a route or the client; no raw Prisma in routes.\n\n' +
        '## Acceptance criteria\n\n' +
        '- For a public/non-member viewer, a private epic’s children are ABSENT ' +
        'from the payload of EVERY read path — tree, detail child-panel, public ' +
        'board, ready set, AND FilterAST search — verified at the response ' +
        'level (not the DOM); the predicate is defined ONCE in the 6.12.4 ' +
        'projection (a single auditable branch).\n' +
        '- The private epic’s public ROW carries title / kind / status + the ' +
        '"children-hidden" marker but OMITS child count, progress / rollup, and ' +
        'point total; the marker lets the UI render the placeholder with no ' +
        'child in the payload.\n' +
        '- A project MEMBER’s reads return the children + the real rollups ' +
        'unchanged; the flag is a no-op on a non-public project and for a member ' +
        'on a public project.\n' +
        '- 4-layer respected (predicate + strip in the service/repository ' +
        'projection, no raw Prisma in routes); the exclusion is an indexable ' +
        '`where`, not a load-all post-filter.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.2 (the read-path checklist + the projection-predicate + the ' +
        'tell-strip / marker decision), 6.14.3 (the flag the predicate reads).\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.4 (the public ' +
        'PROJECTION this extends — the use-the-real-public-read-subtask-id ' +
        'dependency) + § 6.12.7 (the public roadmap read it also covers).\n' +
        '- `motir-core/lib/services/workItemsService.ts` + the tree / ' +
        'detail-child / board / ready-set read paths + the 6.1.1 FilterAST ' +
        'search compiler — the reads the projection predicate threads into.\n' +
        '- GitLab confidential issues ' +
        '(https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html) ' +
        '— hidden from non-members incl. search, server-side; Jira issue-level ' +
        'security ' +
        '(https://confluence.atlassian.com/adminjiraserver/configuring-issue-level-security-938847117.html) ' +
        '— "not visible anywhere" server-enforced + member/admin bypass.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['6.14.3', '6.12.4'],
    },
    {
      id: '6.14.5',
      title:
        'Tree UI — a private epic expanded by a public viewer shows the "this epic is not public" placeholder instead of children',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Build the work-item TREE placeholder per the 6.14.1 design, over the ' +
        '6.14.4 enforcement. When a public/non-member viewer EXPANDS a private ' +
        'epic in the tree, the children rows are replaced by the "this epic is ' +
        'not public" placeholder.\n\n' +
        '- **The private epic row:** render the epic title + kind icon ' +
        '(`IssueTypeIcon`) + the "private" badge (`Pill` tone) per the design; ' +
        'render NO child count / progress / point total (the 6.14.4 projection ' +
        'already omits them, so there is nothing to display — the UI must NOT ' +
        'reconstruct or estimate them).\n' +
        '- **The expand placeholder:** on expand, because the projection ' +
        'returned the "children-hidden" marker and zero children, render the ' +
        'inline "this epic is not public" placeholder (an `EmptyState`-family ' +
        'panel) at the child-indent level instead of a child list — the exact ' +
        'copy from 6.14.1. The viewer can still expand/collapse the row; it just ' +
        'never reveals children.\n' +
        '- **Member parity:** a project MEMBER expanding the SAME epic sees the ' +
        'children normally (the 6.14.4 projection returns them for a member) — ' +
        'the placeholder is driven entirely by the marker in the payload, so the ' +
        'member path renders children with no special-casing.\n\n' +
        'Uses ONLY shipped `components/ui/*` + `--el-*` / `[data-display-style]` ' +
        'tokens (no Tier-0 `--color-*`, no raw spacing/radius), matching the ' +
        '6.14.1 design.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A public/non-member viewer expanding a private epic in the tree sees ' +
        'the "this epic is not public" placeholder (the 6.14.1 copy) at the ' +
        'child indent, NOT a child list; the epic row shows title + "private" ' +
        'badge and NO count / progress / points.\n' +
        '- The placeholder is driven by the 6.14.4 "children-hidden" marker (no ' +
        'child in the payload); a project member expanding the same epic sees ' +
        'the children normally.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; matches the 6.14.1 design; AA contrast holds for the ' +
        'badge + placeholder.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.1 (design asset — required), 6.14.4 (the projection + the ' +
        '"children-hidden" marker the row reads).\n' +
        '- the work-item tree component + the epic-row / expand rendering — the ' +
        'surface this extends.\n' +
        '- `motir-core/components/ui/*` (`IssueTypeIcon`, `Pill`, the ' +
        '`EmptyState` family) + `app/globals.css` token layers; ' +
        '`motir-core/CLAUDE.md` § colour + shape tokens.',
      dependsOn: ['6.14.1', '6.14.4'],
    },
    {
      id: '6.14.6',
      title:
        'Detail child-panel UI — a private epic’s detail page shows the "not public" statement instead of its children',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'Build the work-item DETAIL child-panel placeholder per the 6.14.1 ' +
        'design, over the 6.14.4 enforcement. On a private epic’s detail page, ' +
        'the CHILD PANEL (the panel that lists the epic’s children / sub-issues) ' +
        'shows the "this epic is not public" statement instead of a child list, ' +
        'for a public/non-member viewer.\n\n' +
        '- **The child-panel placeholder:** when the detail child-panel read ' +
        '(6.14.4) returns the "children-hidden" marker + zero children for a ' +
        'non-member, render the "this epic is not public" statement (the 6.14.1 ' +
        'copy, the detail-page framing — distinct from the inline tree row, same ' +
        'copy/tone) in the child-panel slot instead of the child list.\n' +
        '- **No tell leak:** the detail page’s epic header / summary must NOT ' +
        'render a child count, progress / rollup, or point total for a ' +
        'non-member (the 6.14.4 projection omits them) — the UI must not ' +
        'reconstruct them.\n' +
        '- **Member parity:** a project MEMBER on the same detail page sees the ' +
        'normal child list + the real rollups (the projection returns them) — ' +
        'driven by the marker in the payload, no special-casing.\n\n' +
        'Uses ONLY shipped `components/ui/*` + `--el-*` / `[data-display-style]` ' +
        'tokens, matching the 6.14.1 design.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A public/non-member viewer on a private epic’s detail page sees the ' +
        '"this epic is not public" statement in the CHILD PANEL (the 6.14.1 ' +
        'copy), NOT a child list; no child count / progress / points render in ' +
        'the epic header/summary for the non-member.\n' +
        '- The placeholder is driven by the 6.14.4 marker (no child in the ' +
        'payload); a project member on the same page sees the children + ' +
        'rollups normally.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; matches the 6.14.1 design; AA contrast holds.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.1 (design asset — required), 6.14.4 (the detail child-panel ' +
        'read + the marker).\n' +
        '- the work-item detail page + its child / sub-issue panel — the surface ' +
        'this extends.\n' +
        '- `motir-core/components/ui/*` (the `EmptyState` family) + ' +
        '`app/globals.css` token layers; `motir-core/CLAUDE.md` § colour + shape ' +
        'tokens.',
      dependsOn: ['6.14.1', '6.14.4'],
    },
    {
      id: '6.14.7',
      title: 'Project-admin control — set/unset an epic as private (project-admin-gated via 6.4)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'Build the project-admin control to set/unset an epic as private per ' +
        'the 6.14.1 design, over the 6.14.3 flag — the write path that turns ' +
        'epic privacy on and off.\n\n' +
        '- **The service + route (4-layer):** a service method ' +
        '`setEpicPrivacy(epicKey, publicChildrenHidden)` (the exact name per ' +
        '6.14.2’s flag) that updates the flag through `workItemsService` (the ' +
        'shipped write authority), validating that the target is an EPIC-kind ' +
        'item (reject otherwise, per 6.14.2) and that the project is the right ' +
        'tenant. Gated to the PROJECT ADMIN — reuse the 6.4 project-admin check ' +
        '(NOT a new permission); a non-admin is rejected (403). One service ' +
        'method = one transaction. A `PATCH …/work-items/[key]/epic-privacy` ' +
        '(or the epic’s settings route) — HTTP-only, typed-error→status.\n' +
        '- **The UI:** the set-private toggle / segmented control on the epic ' +
        '(in the epic’s actions or settings area) per the 6.14.1 design, ' +
        'project-admin-gated (non-admins see it read-only or absent). Inline ' +
        'edits follow the no-whole-tree-refresh rule (a success response is the ' +
        'confirmation — do NOT fan out a router.refresh / revalidate that would ' +
        'revert the cell). Uses ONLY shipped `components/ui/*` + `--el-*` / ' +
        '`[data-display-style]` tokens.\n\n' +
        'Stay 4-layer: the route parses + calls the one service method; the ' +
        'service owns the transaction + the epic-kind + admin validation + the ' +
        '`workItemsService` write; no raw Prisma in the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A project admin can set/unset an epic private via the control; the ' +
        'flag persists through `workItemsService`; setting it on a non-epic is ' +
        'rejected; a non-admin is rejected (403) and sees the control ' +
        'read-only/absent (project-admin-gated via the 6.4 check, no new ' +
        'permission).\n' +
        '- The toggle reflects the current state and uses the ' +
        'success-response-is-confirmation pattern (no whole-tree refresh on ' +
        'success); the control matches the 6.14.1 design.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; 4-layer respected (route → service → ' +
        '`workItemsService`; no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- 6.14.1 (design asset — required), 6.14.3 (the flag the write sets), ' +
        '6.14.2 (the epic-only + admin-gated rules).\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` § 6.4.4 — the project-admin ' +
        'check reused (mirror, do not fork; no new permission).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the write authority ' +
        'the flag update routes through.\n' +
        '- `motir-core/components/ui/*` + `app/globals.css`; ' +
        '`motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens + the ' +
        'inline-edit no-whole-tree-refresh rule.',
      dependsOn: ['6.14.1', '6.14.3'],
    },
    {
      id: '6.14.8',
      title:
        'Tests (vitest) — a public viewer cannot read a private epic’s children via ANY path; a member can; no aggregate-tell leak; the admin toggle',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the load-bearing guarantee: a public/non-member viewer can NEVER ' +
        'read a private epic’s children — via ANY read path — while a member ' +
        'can, and the aggregate tells never leak. On a real Postgres (the ' +
        'standing rule), covering:\n\n' +
        '- **Server-side exclusion at EVERY read path.** Make an epic private ' +
        'on a public project; as a cross-org NON-MEMBER viewer, assert its ' +
        'children are ABSENT from the PAYLOAD (not the DOM) of: the TREE ' +
        'projection, the DETAIL child-panel read, the 6.12 public BOARD, the 7.0 ' +
        'ready SET, and a 6.1 FilterAST SEARCH that matches a child’s title. A ' +
        'PARAMETERIZED test over the read set so adding a new public read ' +
        'without the predicate is caught.\n' +
        '- **No aggregate-tell leak.** Assert the private epic’s public-' +
        'projection ROW carries title / kind / status + the "children-hidden" ' +
        'marker but OMITS child count, progress / rollup, and point total — ' +
        'asserted at the payload level.\n' +
        '- **Member bypass.** As a PROJECT MEMBER, assert the SAME epic’s ' +
        'children ARE present and the real child count / progress / points ARE ' +
        'returned (the exclusion is non-member-only); assert the flag is a ' +
        'no-op on a NON-PUBLIC project and for a member on a public project.\n' +
        '- **The admin toggle.** Assert `setEpicPrivacy` flips enforcement ' +
        '(set → the non-member loses the children; unset → regains them); ' +
        'setting it on a NON-EPIC is rejected; a NON-ADMIN is rejected (403, the ' +
        '6.4 check); the epic-kind + admin guards each have a direct test.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The exclusion is asserted at the PAYLOAD level for tree, detail ' +
        'child-panel, public board, ready set, AND FilterAST search for a ' +
        'non-member; the parameterized read-set test fails if a public read ' +
        'omits the predicate.\n' +
        '- The aggregate-tell strip (count / progress / points omitted + the ' +
        'marker present) and the member-bypass (children + real rollups ' +
        'returned) are each asserted; the non-public-project no-op is asserted.\n' +
        '- The admin toggle (set/unset flips enforcement), the non-epic ' +
        'rejection, and the non-admin 403 are asserted; new service/repository ' +
        'code respects the per-file coverage gate (CLAUDE.md § coverage); the ' +
        'epic-kind / admin / already-set guards each have a direct test; tests ' +
        'use the real Postgres helper.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.4 (the server-side enforcement under test), 6.14.7 (the admin ' +
        'toggle), 6.14.3 (the flag).\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.9 — the public-access ' +
        'test harness (cross-org viewer vs member) this extends.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the per-file ' +
        'coverage gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the per-test truncation harness.',
      dependsOn: ['6.14.4', '6.14.7'],
    },
    {
      id: '6.14.9',
      title:
        'E2E (playwright) — a public viewer expands a private epic → "not public" placeholder (tree + detail); a member sees the children; the admin toggles privacy',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** e2e (playwright) — the full epic-privacy loop in a browser, ' +
        'proving the server-side hiding + the placeholder + the member-bypass + ' +
        'the admin toggle end to end with a SECOND Motir account in a DIFFERENT ' +
        'org (the 6.12 cross-org public viewer).\n\n' +
        'The flow:\n\n' +
        '1. As the `motir` project admin, on a project already made PUBLIC ' +
        '(6.12), mark an epic that has children **private** via the 6.14.7 ' +
        'control.\n' +
        '2. Sign in as a SECOND, seeded Motir account in a DIFFERENT org with NO ' +
        'membership in the project. Open the public project tree → the private ' +
        'epic ROW is visible (title + "private" badge, NO child count / ' +
        'progress); EXPAND it → the **"this epic is not public"** placeholder ' +
        'renders instead of children. Open the epic’s DETAIL page → the CHILD ' +
        'PANEL shows the same "not public" statement.\n' +
        '3. Confirm the children are absent from the public BOARD and from a ' +
        'SEARCH for a child’s title (as the public viewer).\n' +
        '4. Sign in as a PROJECT MEMBER (second browser context) → the same ' +
        'epic shows its children normally in the tree-expand and the detail ' +
        'child-panel, with the real count / progress.\n' +
        '5. As the admin, UNSET the epic’s privacy → the public viewer ' +
        '(re-loaded) now sees the children too (proving the toggle drives ' +
        'enforcement live).\n\n' +
        'Mind the prodect e2e selector + harness gotchas (combobox option = ' +
        'label + secondary; exact/level on heading selectors; the empty-state ' +
        'headings; run the dev server yourself + reuse it). Drive the real UI, ' +
        'not API shortcuts; use a second browser context for the second ' +
        'account; assert the children are absent from the network PAYLOAD for ' +
        'the public viewer, not just the DOM.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The second (different-org) public viewer sees the private epic row ' +
        '(title + "private" badge, no count/progress), the "this epic is not ' +
        'public" placeholder on tree-expand AND in the detail child-panel, and ' +
        'no child match in the public board / search; the children are absent ' +
        'from the response payload (not just the DOM).\n' +
        '- A project member sees the same epic’s children + real rollups ' +
        'normally (tree-expand + detail child-panel).\n' +
        '- The admin set/unset toggle flips enforcement live (unsetting reveals ' +
        'the children to the public viewer on reload); the control is ' +
        'project-admin-gated.\n' +
        '- The test drives the real UI (no API-only shortcuts), uses a second ' +
        'browser context, and follows the prodect E2E selector + run-harness ' +
        'conventions.\n\n' +
        '## Context refs\n\n' +
        '- 6.14.5 (tree placeholder) + 6.14.6 (detail child-panel placeholder) ' +
        '+ 6.14.7 (the admin toggle) — the surfaces driven; 6.14.4 (the ' +
        'server-side enforcement) exercised through them.\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.10 — the cross-org ' +
        'public-project e2e (second-account-in-different-org harness) this ' +
        'builds on.\n' +
        '- `motir-core/e2e/` — the existing Playwright specs + the run-harness ' +
        '+ selector conventions to mirror.',
      dependsOn: ['6.14.5', '6.14.6', '6.14.7'],
    },
  ],
};
