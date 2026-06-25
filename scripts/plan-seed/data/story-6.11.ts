import type { SeedStory } from '../types';

/**
 * Story 6.11 (Epic 6) — Triage inbox (bug/feature intake → promote). The
 * incoming-work front door for the PM core: a place where bug reports and
 * feature requests LAND — from a workspace member's in-app "report a bug /
 * request a feature" widget OR from a signed-in non-member via the 6.12
 * public-project "Submit a request" form — WITHOUT polluting the planned tree,
 * where an admin then triages each one (accept / promote / decline /
 * mark-duplicate / merge / snooze) into the real backlog. This is a pure
 * motir-core, per-project feature; it touches no AI boundary and carries zero
 * forward dependencies.
 *
 * **Model revision (Yue, 2026-06-14): a work item is created ONLY by a
 * signed-in account — the unauthenticated public portal form is DROPPED.** The
 * shipped `workItemsService.createWorkItem` requires a member actor
 * (`assertReporterMember` + `assertCanEdit`), so an anonymous portal cannot
 * create through it. Triage intake is therefore two SIGNED-IN surfaces: the
 * in-app "Report" widget (a workspace member) and the 6.12 public-project
 * "Submit a request" (a signed-in viewer who is NOT a workspace member —
 * `canSubmitToTriage`, sign-in-to-act), which posts into THIS triage queue.
 * Both submitters carry a real `submittedByUserId`; the captured-external
 * name/email (`externalSubmitter`) and the public form's honeypot / rate-limit /
 * per-form-token route are removed (6.11.10 retires the schema + ADR). The inbox
 * still distinguishes a team member from a "public" (non-member) submitter. This
 * supersedes the public-portal parts of the 2026-06-12 locked model below and
 * mirrors the 6.12 sign-in-to-act revision.
 *
 * **The locked model (Yue, 2026-06-12): a triage submission IS a `work_item`,
 * in a `triage` STATE that excludes it from EVERY normal read.** We do NOT add
 * a second "submissions" table that later has to be promoted/copied into a
 * work_item — a submission is born a real `work_item` (kind `bug` or `task`,
 * the request grammar) the moment it is created, but it carries a `triage`
 * marker that makes it invisible to every tree / board / list / ready-set /
 * search read. The triage-queue read is the ONE read that includes only those
 * items. Promotion is therefore not a copy — it is clearing the triage marker
 * and setting parent + position (backlog rank), through the SHIPPED
 * `workItemsService` write authority, so the same item simply appears in the
 * tree. Decline cancels it; mark-duplicate/merge folds it into a canonical
 * item; snooze hides it from the queue until a chosen time or new activity.
 *
 * **The verified mirror — Linear Triage (rung 1, verified not asserted).**
 * Linear's docs are explicit on every load-bearing decision here:
 *   - **Triage is a state outside the normal workflow, excluded from all
 *     reads.** "By default, we exclude triage issues from all views since
 *     triage is considered to be outside the normal workflow" — you must
 *     explicitly add a status filter to even SEE them. That is exactly 6.11.3's
 *     read-exclusion invariant: triage items are absent from tree/board/list/
 *     ready/search until promoted. (https://linear.app/docs/triage)
 *   - **What lands in triage:** issues "created through an integration (e.g.
 *     Slack, Sentry), created when inside of the Triage view, or if members
 *     outside of your specific team create the issue" — plus external people
 *     via **Linear Asks** / support-tool connections (Intercom, Front,
 *     Zendesk). Motir's analogue: the in-app report widget (6.11.4/6.11.7) +
 *     the signed-in 6.12 public-project "Submit a request" (NOT an anonymous
 *     portal — see the 2026-06-14 revision above). (https://linear.app/docs/triage)
 *   - **The action set (the exact verbs we mirror):** Accept (`1`) "will offer
 *     the option to leave a comment and then move the issue to your team's
 *     default status"; Mark as Duplicate (`2`) merges into an existing issue
 *     and the new one "is updated to a Canceled status type" (attachments +
 *     customer requests move to the canonical issue); Decline (`3`) "will
 *     update the issue to a Canceled status type and present the option of
 *     adding a comment"; Snooze (`H`) "will hide the issue from the triage
 *     queue to return at a time of your choosing, or when there's new activity
 *     on that issue: whichever comes first." 6.11.5 implements accept→backlog,
 *     promote→sprint/epic/story, decline, mark-duplicate/merge, snooze against
 *     this exact taxonomy. (https://linear.app/docs/triage)
 *
 * **Secondary mirror — Jira Product Discovery / JSM intake (cited):** the
 * standard Atlassian pattern routes external submissions through a JSM request
 * type / Confluence form into a staging area, and an agent only promotes a
 * submission into the real JPD idea once it is "triaged" (a triaged checkbox
 * gates idea creation) — i.e. external intake + a deliberate human promote
 * step, never auto-injecting raw requests into the planned backlog. That
 * confirms the in-app + shareable-portal intake split and the promote-gate.
 * (https://community.atlassian.com/forums/Jira-Product-Discovery-articles/How-to-Creating-an-idea-intake-process-with-JPD-and-JSM/ba-p/2777882,
 * https://www.atlassian.com/software/jira/product-discovery)
 *
 * **Why the work_item-with-triage-state shape is the durable one (no
 * shortcut).** A separate submissions table would force a copy-on-promote that
 * loses the submission's comments/attachments/history and duplicates the
 * grammar; modelling the submission AS the work_item from birth means promotion
 * is a metadata edit (clear triage + set parent/rank), the full comment/
 * attachment thread carries over for free (mirroring Linear moving attachments
 * to the canonical issue on merge), and there is ONE source of truth. The cost
 * — every normal read must exclude triage — is paid once, centrally, in the
 * repository read layer (6.11.3), and locked by tests that assert exclusion at
 * EVERY read (tree, board, list, ready, search) so a future read can't
 * accidentally leak triage items.
 *
 * **Scale (finding #57).** The triage queue is an unbounded inbox (the 6.12
 * public submit channel can produce many submissions), so the queue read is
 * paginated/cursor'd — never a load-all list.
 *
 * **Design gate.** Two distinct UI surfaces ship here — the admin triage inbox
 * (queue + detail + actions) and the in-app report widget. Both are gated
 * behind the FIRST subtask, a `design` card that produces the multi-panel mock +
 * design-notes under `design/triage/`, composing only shipped `components/ui/*`
 * primitives + `--el-*` / `[data-display-style]` tokens. Every UI code subtask
 * (6.11.6/6.11.7) depends on it and is `blocked`. (The external "Submit a
 * request" surface is designed + built in Story 6.12.)
 *
 * **Cross-story dep audit: PASSES.** Every `dependsOn` id is same-story
 * (6.11.x) or an already-SHIPPED motir-core service (`workItemsService`, the
 * 6.1.1 FilterAST search) — no forward-pointing dependency, no dependency on an
 * unbuilt higher-numbered story. 6.11.1 (design) and 6.11.2 (decision) have
 * empty deps → `planned`; everything chained behind them → `blocked`.
 */
export const story_6_11: SeedStory = {
  id: '6.11',
  title: 'Triage inbox (bug/feature intake → promote)',
  status: 'done',
  gitBranch: 'feat/PROD-6.11-triage-inbox',
  descriptionMd:
    'The incoming-work front door for a project. Bug reports and feature ' +
    'requests arrive — from a workspace member through an in-app "report a bug ' +
    '/ request a feature" widget, or from a signed-in non-member through the ' +
    '6.12 public-project "Submit a request" form — and land in a **triage ' +
    'inbox**, a staging queue that is ' +
    'EXCLUDED from the planned tree until an admin acts on it. The admin ' +
    'triages each item: **accept** it into the backlog, **promote** it under ' +
    'a sprint / epic / story (set parent + position), **decline** it, ' +
    '**mark it duplicate / merge** it into a canonical item, or **snooze** ' +
    'it. This is a pure motir-core, per-project feature — no AI boundary, no ' +
    'forward dependency.\n\n' +
    '**The locked model (mirrors Linear Triage):** a submission IS a ' +
    '`work_item` (kind `bug` or `task`) from the moment it is created, but it ' +
    'carries a **`triage` state** that makes it invisible to EVERY normal ' +
    'read — the tree, every board, every list, the ready set, and search all ' +
    'exclude it (Linear: "we exclude triage issues from all views since ' +
    'triage is considered to be outside the normal workflow"). The ' +
    'triage-queue read is the single read that returns ONLY triage items. ' +
    '**Promotion is not a copy** — it clears the triage marker and sets ' +
    'parent + backlog rank through the shipped `workItemsService`, so the ' +
    'same item (with its comments, attachments, and history intact) simply ' +
    'appears in the tree.\n\n' +
    '**Scope:** the design of both surfaces (6.11.1); the triage-model ' +
    'decision (6.11.2); the schema + the read-exclusion-everywhere invariant ' +
    '(6.11.3); the intake path — the in-app member submit (6.11.4); the ' +
    'triage-actions service — accept / promote / decline / mark-duplicate-' +
    'merge / snooze (6.11.5); the admin triage inbox UI (6.11.6); the in-app ' +
    'report widget UI (6.11.7); the read-exclusion + actions tests (6.11.8); ' +
    'the submit→triage→promote e2e (6.11.9); and retiring the dropped ' +
    'external-submitter schema + ADR (6.11.10). (The external "Submit a ' +
    'request" surface itself is Story 6.12.)\n\n' +
    '**Out of scope (named so they are not silently lost):** AI-assisted ' +
    'auto-triage / dedupe-suggestion (an Epic-7 planner enhancement, not ' +
    'this story); triage-responsibility on-call scheduling (Linear ' +
    'Business-tier; a later 6.x setting); SLA / response-time tracking on ' +
    'submissions; and email/Slack ingestion channels (this story ships the ' +
    'in-app member channel and consumes the 6.12 signed-in submit channel; ' +
    'integration channels reuse the same triage-item creation path later); and ' +
    'anonymous/unauthenticated submission (a work item is created only by a ' +
    'signed-in account — the dropped public portal — pending a future ' +
    'abuse/anonymous-identity model).',
  verificationRecipeMd:
    '- **The exclusion invariant (the load-bearing one).** Submit a bug via ' +
    'the in-app widget for the `PROD` project. Confirm it appears in the ' +
    'triage inbox AND is absent from: the issue tree, every board column, ' +
    'every saved/default list, the ready set, and a search that would ' +
    'otherwise match it (e.g. by its title). Then promote it to the backlog ' +
    '→ confirm it now appears in the tree/list/search and is gone from the ' +
    'triage queue.\n' +
    '- **The public (non-member) submit.** Signed in as a non-member, submit a ' +
    'feature request via the 6.12 public-project "Submit a request" form → it ' +
    'lands in the same triage inbox with a **"Public" submitter** chip (a real ' +
    '`submittedByUserId`, no tenant access). (The submit surface itself ships ' +
    'in Story 6.12; 6.11 owns the inbox that receives it.)\n' +
    '- **The action set.** From the inbox: accept an item (→ backlog, ' +
    'default status, optional comment); promote another under a chosen epic/' +
    'story (parent + position set); decline one (→ canceled, optional ' +
    'comment); mark one a duplicate of a canonical item (the duplicate is ' +
    'canceled and its attachments/comments fold into the canonical item); ' +
    'snooze one (it leaves the queue and returns at the chosen time / on new ' +
    'activity).\n' +
    '- `pnpm test` (motir-core) — 6.11.8 covers the exclusion at EVERY read ' +
    '(tree/board/list/ready/search), the queue-only read, and each action ' +
    '(promote re-parents + ranks via `workItemsService`, decline cancels, ' +
    'merge folds + cancels, snooze hides/returns), all on a real Postgres per ' +
    'the standing rule, respecting the per-file coverage gate.\n' +
    '- **4-layer + token review.** No raw Prisma in any route; every triage ' +
    'write goes through a service → `workItemsService`; the inbox + form UIs ' +
    'reference only `--el-*` / `[data-display-style]` tokens and shipped ' +
    '`components/ui/*` primitives.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '6.11.1',
      title: 'Design — the triage inbox + the submission surfaces (widget + portal form)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**⚠️ Partially superseded (Yue, 2026-06-14).** The **public portal ' +
        'form** panel (unauthenticated, captured name/email, confirmation + ' +
        'rate-limit states) is **dropped** — a work item is created only by a ' +
        'signed-in account; the external-intake surface is the 6.12 signed-in ' +
        '"Submit a request". The `design/triage/` asset has been revised ' +
        'accordingly (in-app widget + inbox only; the "external" chip is now a ' +
        '"Public" chip). This card is kept as the record of what was designed; ' +
        'see the story revision note + 6.11.10.\n\n' +
        '**Type:** design (THE design gate — produced FIRST; every UI code ' +
        'subtask here, 6.11.6 and 6.11.7, depends on this card and is ' +
        '`blocked` until it lands). Produce the surface design assets for ' +
        'BOTH UI surfaces under `motir-core/design/triage/`, composing ONLY ' +
        'shipped `components/ui/*` primitives + `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (NO Tier-0 `--color-*`, no ' +
        'hand-rolled spacing/radius), mirroring 7.0.1’s multi-panel ' +
        'design-card shape.\n\n' +
        'Two surfaces, each a panel in the mock:\n\n' +
        '1. **The admin triage inbox** — a paginated QUEUE list (each row: ' +
        'kind icon via `IssueTypeIcon`, title, submitter [member avatar OR ' +
        '"external" chip], age, a snippet) + a DETAIL pane (full submission ' +
        'body, comments, attachments, submitter attribution) + the ACTION ' +
        'bar: Accept, Promote (a picker for backlog / sprint / epic / story ' +
        'parent + position), Decline, Mark duplicate / Merge (a canonical-' +
        'item picker), Snooze (a time picker). Mirror Linear Triage’s ' +
        'queue+detail+action shape.\n' +
        '2. **The submission surfaces** — (a) the in-app "report a bug / ' +
        'request a feature" widget (a compact modal/popover: type toggle, ' +
        'title, description, optional attachment), and (b) the shareable ' +
        '**public portal form** (an unauthenticated, branded, single-column ' +
        'form; a "thanks, we got it" confirmation state; the rate-limit / ' +
        'error states).\n\n' +
        '`design-notes.md` MUST name every primitive used, the exact copy for ' +
        'each action + the empty-queue state, and the `--el-*` role for every ' +
        'colour (e.g. the "external" chip tint, the kind hue, the destructive ' +
        '`--el-danger` for Decline). Call out the empty state ("No items to ' +
        'triage") and the loading/error states for the public form.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/triage/*.mock.html` renders the inbox (queue + detail + ' +
        'actions) AND both submission surfaces (widget + public form, incl. ' +
        'its confirmation + rate-limit states) as panels, composing only ' +
        'shipped `components/ui/*` + `--el-*` + `[data-display-style]` ' +
        'tokens.\n' +
        '- `design/triage/design-notes.md` names every primitive + the copy ' +
        'for every action and empty/confirmation/error state, with the ' +
        '`--el-*` role for each colour; no Tier-0 `--color-*` and no raw ' +
        'spacing/radius anywhere.\n' +
        '- The promote picker design shows the four targets (backlog / sprint ' +
        '/ epic / story) and where position/rank is chosen.\n' +
        '- AA contrast holds for the external chip and the destructive ' +
        'action (tint background + `--el-text-strong`).\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 — the ' +
        'multi-panel design-card shape to mirror.\n' +
        '- Linear Triage (https://linear.app/docs/triage) — the queue + ' +
        'detail + action-set surface being mirrored.\n' +
        '- `motir-core/components/ui/*`, `app/globals.css` (the `--el-*` + ' +
        '`[data-display-style]` token layers), `motir-core/CLAUDE.md` ' +
        '§ colour + shape tokens.\n' +
        '- `IssueTypeIcon` / `Pill` — the kind-hue + tone primitives the rows ' +
        'use.',
      dependsOn: [],
    },
    {
      id: '6.11.2',
      title:
        'Decision — the triage model: work_item + `triage` state, read-exclusion, promote/decline/merge semantics',
      status: 'done',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**⚠️ Partially superseded (Yue, 2026-06-14).** §3 below — submitter ' +
        'attribution "member OR external (captured name/email)" — is **revised**: ' +
        'a work item is created only by a signed-in account, so EVERY triage ' +
        'item carries a real `submittedByUserId` (a workspace member, or a ' +
        'signed-in non-member via 6.12’s `canSubmitToTriage`); the ' +
        'captured-external `externalSubmitter` and the unauthenticated portal ' +
        'are dropped. 6.11.10 amends `triage-model.md` §3 + retires the schema. ' +
        'The rest of this ADR (triage-state, read-exclusion, promote/decline/' +
        'merge/snooze) stands. Kept as the record of the original decision.\n\n' +
        '**Type:** decision (the keystone ADR the schema + service cards ' +
        'build against; no app behavior ships, but the shapes it fixes are ' +
        'load-bearing). Write `motir-core/docs/decisions/triage-model.md`. It ' +
        'MUST fix:\n\n' +
        '1. **A submission IS a work_item, in a `triage` state (Yue).** Not a ' +
        'separate submissions table. A submission is born a `work_item` (kind ' +
        '`bug` for a bug report, `task` for a feature request — the request ' +
        'grammar) with NO parent and a `triage` marker. Decide the marker ' +
        'shape: a dedicated boolean/`triagedAt` column vs. a reserved ' +
        '`workflow_status` — choose the one that makes the read-exclusion a ' +
        'cheap, indexable predicate AND survives the item later taking a ' +
        'normal status on promote (a column is the durable choice; justify).\n' +
        '2. **Read-exclusion is total and central.** EVERY normal read — the ' +
        'tree, every board, every list, the ready set, and 6.1.1 FilterAST ' +
        'search — excludes triage items; the triage-queue read is the ONLY ' +
        'read that includes only them. Decide WHERE the predicate lives so it ' +
        "can't be forgotten by a future read (a repository-level default " +
        'scope / a shared `where` fragment threaded through every list query ' +
        '— NOT N independent filters). This mirrors Linear: "we exclude ' +
        'triage issues from all views since triage is considered to be ' +
        'outside the normal workflow."\n' +
        '3. **Submitter attribution — member OR external.** A triage item ' +
        'records its origin: a member (userId) or an external portal ' +
        'submitter (a captured name/email, no account). Decide the storage ' +
        '(nullable `submittedByUserId` + an `externalSubmitter` JSON/embedded ' +
        'fields) and that external submitters get no tenant access.\n' +
        '4. **Promote semantics.** Promote = clear the triage marker + set ' +
        'parent (backlog = no parent but triage-cleared / sprint / epic / ' +
        'story, per the kind-parent matrix) + set position/backlogRank — ALL ' +
        'through `workItemsService` (never raw). Accept = promote to the ' +
        'backlog at the default status with an optional comment. The ' +
        'kind-parent matrix still governs (a `bug` can parent to epic/story/' +
        'task; a `task` similarly) — promotion must respect it.\n' +
        '5. **Decline / mark-duplicate / merge / snooze.** Decline → a ' +
        'canceled terminal status (+ optional comment). Mark-duplicate/merge ' +
        '→ pick a canonical item; the duplicate is canceled and its ' +
        'comments + attachments fold into the canonical item (mirror Linear ' +
        'moving attachments/customer-requests to the canonical issue). ' +
        'Snooze → hidden from the queue until a chosen time OR new activity, ' +
        'whichever first (decide the `snoozedUntil` storage + the ' +
        'return-on-activity trigger).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The ADR fixes all five sections with the chosen column/relation ' +
        'shapes and a one-paragraph justification for the `triage`-marker ' +
        'column over a reserved status, and for the central exclusion ' +
        'predicate over per-read filters.\n' +
        '- It enumerates EVERY normal read that must exclude triage items ' +
        '(tree, each board read, each list read, ready set, FilterAST ' +
        'search) as the checklist 6.11.3 + 6.11.8 implement and test.\n' +
        '- It states that promotion/decline/merge all route through ' +
        '`workItemsService` (write authority unchanged) and respect 6.4 ' +
        'permissions + the kind-parent matrix.\n' +
        '- Linear Triage is cited as the verified mirror for the state-' +
        'outside-the-workflow exclusion and the action taxonomy.\n\n' +
        '## Context refs\n\n' +
        '- Linear Triage (https://linear.app/docs/triage) — exclusion + ' +
        'action semantics.\n' +
        '- Jira Product Discovery / JSM intake ' +
        '(https://www.atlassian.com/software/jira/product-discovery) — the ' +
        'triaged-gate-before-promote pattern.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the write ' +
        'authority promote/decline commit through.\n' +
        '- `prisma/sql/work_item_triggers.sql` — the kind-parent matrix ' +
        'promotion must satisfy.\n' +
        '- 6.1.1 FilterAST search (shipped) — the search read that must also ' +
        'exclude triage items.',
      dependsOn: [],
    },
    {
      id: '6.11.3',
      title: 'Schema + the read-exclusion-everywhere invariant',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        '**⚠️ Partially superseded (Yue, 2026-06-14).** The `externalSubmitter` ' +
        'embedded columns added here are now **dead** — intake is signed-in ' +
        'only, so attribution is always a real `submittedByUserId`. The columns ' +
        'remain in the DB until **6.11.10** drops them (ADR amend + migration); ' +
        'this card kept as the record of what shipped. `submittedByUserId` + ' +
        '`snoozedUntil` + the exclusion invariant are unchanged.\n\n' +
        'Implement the triage marker on `work_item` and enforce the ' +
        'exclusion invariant across EVERY normal read (the load-bearing ' +
        'correctness work of this story). Per 6.11.2:\n\n' +
        '- **Schema:** add the `triage` marker (a `triagedAt: DateTime?` / ' +
        '`isTriage` column per the ADR) + `snoozedUntil: DateTime?` + the ' +
        'submitter-attribution columns (`submittedByUserId` nullable ' +
        '`@relation`; `externalSubmitter` embedded fields) to `work_item`, ' +
        'with a migration and a partial index supporting the cheap exclusion ' +
        'predicate + the queue read. Model every FK as a Prisma `@relation` ' +
        '(CLAUDE.md migration rule — no raw-SQL-only FK).\n' +
        '- **Central exclusion:** thread a single shared "not-in-triage" ' +
        '`where` fragment (or a repository default scope) through EVERY ' +
        'normal list read so the predicate is defined once: the issue tree, ' +
        'every board column read, every list/saved-view read, the ready-set ' +
        'read, and the 6.1.1 FilterAST search compilation. A triage item (and ' +
        'a snoozed item, in the inbox sense) is absent from all of them.\n' +
        '- **The queue read:** a new repository read + service method ' +
        'returning ONLY triage items for a project, paginated/cursor’d ' +
        '(finding #57 — never load-all), excluding currently-snoozed items, ' +
        'newest-first, with submitter attribution.\n\n' +
        'All reads stay 4-layer (Route→Service→Repository→' +
        'Prisma); the queue and exclusion live in the repository read layer so ' +
        'no future read can bypass them.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The migration adds the triage marker + snooze + submitter columns ' +
        'with the supporting index; `prisma migrate dev` reports no drift ' +
        '(every FK modelled as `@relation`).\n' +
        '- The exclusion predicate is defined ONCE and applied to the tree, ' +
        'every board read, every list read, the ready set, and FilterAST ' +
        'search — verified by the 6.11.8 tests at each read.\n' +
        '- The triage-queue read returns ONLY triage items for the project, ' +
        'paginated, excluding snoozed items, with submitter attribution; no ' +
        'load-all.\n' +
        '- 4-layer respected; no raw Prisma outside repositories; the queue ' +
        'read goes through a service.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.2 — the model decision this implements (marker shape + the ' +
        'reads-to-exclude checklist).\n' +
        '- `motir-core/lib/repositories/workItemRepository.ts` + the tree / ' +
        'board / ready-set read paths — where the shared exclusion fragment ' +
        'threads in.\n' +
        '- 6.1.1 FilterAST search compiler — the search read to extend with ' +
        'the exclusion.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migration FK-as-' +
        'relation rule.',
      dependsOn: ['6.11.2'],
    },
    {
      id: '6.11.4',
      title: 'Submission intake — the in-app member submit (the shared triage-create service)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The intake path that CREATES a triage work_item from a **signed-in** ' +
        'actor. It creates a `work_item` (kind `bug` or `task`) with the ' +
        '`triage` marker set and no parent, through `workItemsService` (the ' +
        'same create authority the rest of the app uses — which REQUIRES a ' +
        'member actor, so intake is signed-in only; the unauthenticated public ' +
        'portal is dropped, Yue 2026-06-14).\n\n' +
        '- **In-app submit** (authenticated workspace member): a triage ' +
        'intake service method + a `POST /api/.../triage/submissions` route ' +
        'taking `{ kind, title, descriptionMd, attachment? }`, attributing the ' +
        'submission to the session user, scoped to the active project.\n' +
        '- **The service method is the shared triage-create authority.** ' +
        'Expose it so Story 6.12’s public-project "Submit a request" (a ' +
        'signed-in NON-member, gated by `canSubmitToTriage`) reuses the SAME ' +
        'method to create the identical triage work_item, attributed to that ' +
        'user’s real `submittedByUserId` (no captured name/email). 6.11 owns ' +
        'the create path; 6.12 owns its public route + grant.\n\n' +
        'Stay 4-layer: the route parses + calls one service method; the ' +
        'service owns the transaction and calls `workItemsService` to create ' +
        'the item. There is NO unauthenticated route, no per-project form ' +
        'token, and no honeypot/rate-limit here (all were public-portal-only ' +
        'and are removed).\n\n' +
        '## Acceptance criteria\n\n' +
        '- An authenticated in-app submit creates a triage work_item ' +
        'attributed to the session user, in the right project, invisible to ' +
        'the tree (it shows only in the queue).\n' +
        '- The intake service method is callable by both the in-app route and ' +
        'the 6.12 public submit, always attributing a real `submittedByUserId` ' +
        '(member or signed-in non-member); a logged-out caller is rejected ' +
        '(401), never creating a work item.\n' +
        '- Creation goes through `workItemsService` (no raw Prisma in the ' +
        'route); the kind-parent matrix + 6.4 access are honoured.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.3 — the triage marker + `submittedByUserId` the created item ' +
        'carries.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the create ' +
        'authority (`createWorkItem` requires a member `ServiceContext`).\n' +
        '- Story 6.12 (`canSubmitToTriage`, the public submit) — the second ' +
        'caller of this intake service.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['6.11.3'],
    },
    {
      id: '6.11.5',
      title: 'Triage actions service — accept / promote / decline / mark-duplicate-merge / snooze',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'The service + APIs an admin uses to clear the queue, implementing the ' +
        '6.11.2 action taxonomy (the verified Linear set). Every action ' +
        'mutates through `workItemsService` and honours 6.4 permissions + the ' +
        'kind-parent matrix:\n\n' +
        '- **Accept → backlog:** clear the triage marker, place the item in ' +
        'the backlog at the team default status, optional comment. (Linear: ' +
        'accept "move[s] the issue to your team’s default status".)\n' +
        '- **Promote → sprint / epic / story:** clear the triage marker + set ' +
        'parent + set position/`backlogRank` via `workItemsService` ' +
        '(re-parent honouring the kind-parent matrix). The same item now ' +
        'appears in the tree with its full thread.\n' +
        '- **Decline:** move to a canceled terminal status + optional ' +
        'comment; it leaves the queue. (Linear: decline → Canceled.)\n' +
        '- **Mark-duplicate / merge:** pick a canonical item; cancel the ' +
        'duplicate and fold its comments + attachments into the canonical ' +
        'item (mirror Linear moving attachments/customer-requests to the ' +
        'canonical issue), recording the duplicate-of link.\n' +
        '- **Snooze / unsnooze:** set `snoozedUntil`; the item drops out of ' +
        'the active queue until that time OR new activity (a comment / edit) ' +
        'returns it, whichever first.\n\n' +
        'One service method = one transaction; reads that gate a write take ' +
        '`tx` + `SELECT FOR UPDATE` where a concurrent triage action could ' +
        'race the same item (lock-before-read-derived-update). Routes are ' +
        'thin; typed errors map to status codes.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Accept places the item in the backlog at the default status; ' +
        'promote sets parent + position via `workItemsService` respecting the ' +
        'kind-parent matrix; both clear the triage marker so the item enters ' +
        'the tree.\n' +
        '- Decline cancels + optionally comments; the item leaves the ' +
        'queue.\n' +
        '- Mark-duplicate/merge cancels the duplicate, folds its comments + ' +
        'attachments into the canonical item, and records the duplicate-of ' +
        'link.\n' +
        '- Snooze removes the item from the active queue until the chosen ' +
        'time or new activity; each action is permission-checked (6.4) and ' +
        'transactional (FOR UPDATE where it gates a write).\n\n' +
        '## Context refs\n\n' +
        '- 6.11.2 — the action taxonomy + semantics.\n' +
        '- 6.11.3 — the triage marker + snooze columns the actions mutate.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the re-parent / ' +
        'rank / status write authority.\n' +
        '- Linear Triage (https://linear.app/docs/triage) — accept/decline/' +
        'merge/snooze behaviour.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + one-method-one-transaction; ' +
        'the lock-before-read-derived-update rule.',
      dependsOn: ['6.11.3'],
    },
    {
      id: '6.11.6',
      title: 'Triage inbox UI — queue + detail + actions (paginated)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the admin triage inbox per the 6.11.1 design, over the 6.11.3 ' +
        'queue read + the 6.11.5 actions service. A paginated/infinite queue ' +
        'list (kind icon, title, submitter [member avatar, or avatar + a ' +
        '"Public" chip for a signed-in non-member], age, snippet) + a detail ' +
        'pane (full body, comments, attachments, ' +
        'attribution) + the action bar wiring Accept, Promote (the backlog / ' +
        'sprint / epic / story parent + position picker), Decline, Mark ' +
        'duplicate / Merge (the canonical-item picker), and Snooze (the time ' +
        'picker). It uses ONLY shipped `components/ui/*` primitives + ' +
        '`--el-*` / `[data-display-style]` tokens (no Tier-0 `--color-*`, no ' +
        'raw spacing/radius), renders the empty state ("No items to ' +
        'triage"), and is paginated (finding #57). The promote/merge pickers ' +
        'reuse the existing item-picker / parent-picker primitives.\n\n' +
        'Watch the Radix-portal-in-dialog gotcha if the promote/merge picker ' +
        'is a popover rendered inside a modal (gate the portal on not-in-' +
        'dialog).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The inbox renders the queue (paginated/infinite, newest-first), ' +
        'the detail pane, and every action from 6.11.1, matching the design ' +
        'asset.\n' +
        '- Accept / promote / decline / merge / snooze call the 6.11.5 ' +
        'service and reflect the result (the item leaves the queue on a ' +
        'terminal action); the promote picker offers backlog / sprint / epic ' +
        '/ story + position.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; the empty + loading + error states render; AA ' +
        'contrast holds for the "Public" chip + the destructive Decline.\n' +
        '- A promoted item disappears from the queue and (verified in 6.11.9) ' +
        'appears in the tree.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.1 (design asset — required), 6.11.5 (the actions service), ' +
        '6.11.3 (the queue read).\n' +
        '- `motir-core/components/ui/*` + `app/globals.css` token layers; ' +
        'the existing item-picker / parent-picker primitives.\n' +
        '- `motir-core/CLAUDE.md` § colour + shape tokens; the ' +
        'portal-popover-in-Radix-Dialog gotcha note.',
      dependsOn: ['6.11.1', '6.11.5'],
    },
    {
      id: '6.11.7',
      title: 'Submission form UI — the in-app report widget',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'Build the in-app submission surface per the 6.11.1 design, over the ' +
        '6.11.4 intake endpoint:\n\n' +
        '- **In-app widget** — a compact "report a bug / request a feature" ' +
        'modal/popover (type toggle bug|feature, title, description, optional ' +
        'attachment) reachable from the app shell; on submit it posts to the ' +
        'authenticated intake endpoint as the session member and confirms with ' +
        'a toast.\n\n' +
        'The unauthenticated public portal form is DROPPED (Yue 2026-06-14 — a ' +
        'work item is created only by a signed-in account). The external ' +
        '"Submit a request" surface is built in Story 6.12 (it reuses the ' +
        '6.11.4 intake service); it is NOT part of this subtask.\n\n' +
        'Use ONLY shipped `components/ui/*` + `--el-*` / `[data-display-style]` ' +
        'tokens (no Tier-0 `--color-*`, no raw spacing/radius), matching the ' +
        'design asset.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The in-app widget submits to the authenticated endpoint and shows ' +
        'a success confirmation; it is reachable from the shell.\n' +
        '- A logged-out user never reaches a work-item-creating submit (no ' +
        'unauthenticated form ships in this story).\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        'primitives; matches the 6.11.1 design asset.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.1 (design asset — required), 6.11.4 (the in-app intake ' +
        'endpoint).\n' +
        '- Story 6.12 — the external "Submit a request" surface (not built ' +
        'here).\n' +
        '- `motir-core/components/ui/*` + `app/globals.css` token layers.\n' +
        '- `motir-core/CLAUDE.md` § colour + shape tokens.',
      dependsOn: ['6.11.1', '6.11.4'],
    },
    {
      id: '6.11.8',
      title: 'Tests (vitest) — read-exclusion everywhere + promote/decline/dedupe/snooze',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Lock the two load-bearing guarantees: (1) triage items are excluded ' +
        'from EVERY normal read, and (2) the actions do exactly what the ' +
        'taxonomy says. On a real Postgres (the standing rule), covering:\n\n' +
        '- **Exclusion at every read** — create a triage item, then assert it ' +
        'is ABSENT from: the issue tree, each board read, each list/saved-' +
        'view read, the ready set, and a 6.1.1 FilterAST search that matches ' +
        'its title; and assert it IS present in the triage-queue read. (A ' +
        'parameterized test over the read set so adding a new read without ' +
        'the exclusion is caught.)\n' +
        '- **Intake** — the in-app submit creates a triage item attributed to ' +
        'the session member (`submittedByUserId`); the shared intake service ' +
        'also attributes a signed-in NON-member (the 6.12 path) to a real ' +
        '`submittedByUserId`; a logged-out caller is rejected (401) and ' +
        'creates nothing.\n' +
        '- **Actions** — accept lands it in the backlog at default status; ' +
        'promote sets parent + position via `workItemsService` and the item ' +
        'now appears in the tree/search; decline cancels it; mark-duplicate ' +
        'folds comments+attachments into the canonical item and cancels the ' +
        'duplicate; snooze hides it from the queue and new activity returns ' +
        'it. Each respects 6.4 permissions.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The exclusion is asserted at tree, every board read, every list ' +
        'read, ready set, AND FilterAST search; the queue-only read is ' +
        'asserted; the parameterized read-set test fails if a read omits the ' +
        'exclusion.\n' +
        '- Promote/accept/decline/merge/snooze each assert their post-state ' +
        '(parent/position/status/queue-presence) against a repository read.\n' +
        '- The intake rejects a logged-out caller (no work item created); ' +
        'promote/decline assert 6.4 permission enforcement.\n' +
        '- New service/repository code respects the per-file coverage gate ' +
        '(CLAUDE.md § coverage); tests use the real Postgres helper.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.3 (exclusion + queue read), 6.11.4 (intake), 6.11.5 ' +
        '(actions).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the ' +
        'per-file coverage gate.\n' +
        '- `tests/helpers/db.ts` — the truncate-between-tests harness.',
      dependsOn: ['6.11.4', '6.11.5'],
    },
    {
      id: '6.11.9',
      title:
        'E2E (playwright) — submit a bug → lands in triage (not the tree) → admin promotes → appears in the tree',
      status: 'done',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** e2e (playwright) — the full intake→triage→' +
        'promote loop across both surfaces, proving the exclusion + promotion ' +
        'end to end in a browser.\n\n' +
        'Flow: (1) submit a bug via the in-app widget (signed-in member) for ' +
        'the `PROD` project; (2) confirm it appears in the ' +
        'triage inbox and is ABSENT from the issue tree / a board / a list / ' +
        'search; (3) as an admin, promote it from the inbox to the backlog ' +
        '(or under a chosen epic/story); (4) confirm it is now GONE from the ' +
        'triage queue and PRESENT in the tree (and matches in search). Add a ' +
        'second leg exercising decline (→ it leaves the queue, never ' +
        'enters the tree).\n\n' +
        'Mind the known prodect e2e selector + harness gotchas (heading ' +
        'level/exact-name on empty states; the combobox option name = label + ' +
        'secondary; run the dev server yourself + reuse it).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A submitted bug appears in the triage inbox and is verifiably ' +
        'absent from the tree/board/list/search before promotion.\n' +
        '- Promoting it removes it from the queue and makes it appear in the ' +
        'tree (and search) under the chosen parent.\n' +
        '- A declined item leaves the queue and never appears in the tree.\n' +
        '- (The signed-in non-member "Submit a request" leg is exercised by ' +
        'Story 6.12’s e2e, which lands a "Public" submission in this same ' +
        'inbox.)\n\n' +
        '## Context refs\n\n' +
        '- 6.11.6 (inbox UI) + 6.11.7 (submission UIs) — the surfaces driven.\n' +
        '- The prodect e2e selector + run-harness gotcha notes (empty-state ' +
        'headings, combobox option naming, reuse-existing-server).\n' +
        '- `tests/e2e/*` — the existing Playwright setup to mirror.',
      dependsOn: ['6.11.6', '6.11.7'],
    },
    {
      id: '6.11.10',
      title: 'Retire the dropped external-submitter intake — ADR amend + schema column drop',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Clean up after the dropped unauthenticated public portal (Yue ' +
        '2026-06-14 — a work item is created only by a signed-in account). The ' +
        '6.11.3 schema and the 6.11.2 ADR baked in a **captured-external ' +
        '`externalSubmitter` (name/email, no account)** attribution that is now ' +
        'unreachable: every triage item — in-app member OR the 6.12 signed-in ' +
        'non-member — carries a real `submittedByUserId`. This subtask owns the ' +
        'full retirement:\n\n' +
        '- **Schema (drop the dead columns).** Remove the `externalSubmitter` ' +
        'embedded fields from `work_item` (keep `submittedByUserId` as the ' +
        '`@relation`, keep `snoozedUntil`). Author the Prisma migration so ' +
        '`migrate dev` reports no drift afterward (model the change on the ' +
        'schema, never raw-SQL-only — CLAUDE.md FK-as-relation rule); on the ' +
        'shared dev DB hand-author + `migrate resolve` per the shared-DB ' +
        'drift rule rather than letting `migrate dev` propose a reset.\n' +
        '- **Consumers.** Grep for every `externalSubmitter` reference — DTOs, ' +
        'mappers, the queue-read attribution shape, the inbox DTO, any test ' +
        'fixture — and remove/replace it with the `submittedByUserId`-based ' +
        '"member vs public (non-member)" distinction. Typecheck + the touched ' +
        'services’ vitest stay green.\n' +
        '- **ADR amend.** Update `docs/decisions/triage-model.md` §3 ' +
        '(submitter attribution) to record the revision: attribution is ' +
        'ALWAYS a real `submittedByUserId` (a workspace member, or a signed-in ' +
        'non-member via the 6.12 `canSubmitToTriage` grant); the ' +
        'captured-external name/email and the unauthenticated portal are ' +
        'removed. Cite the 2026-06-14 decision; leave the rest of the ADR ' +
        '(triage-state, read-exclusion, promote/decline/merge/snooze) intact.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `externalSubmitter` columns are dropped via a clean migration ' +
        '(`migrate dev` reports no difference after); `submittedByUserId` + ' +
        '`snoozedUntil` are unchanged.\n' +
        '- No `externalSubmitter` reference remains in schema, services, ' +
        'mappers, DTOs, or tests; typecheck + the affected vitest are green; ' +
        'the per-file coverage gate holds.\n' +
        '- `docs/decisions/triage-model.md` §3 records the signed-in-only ' +
        'attribution revision; the inbox still distinguishes member vs public ' +
        'submitter off `submittedByUserId` + workspace-membership.\n\n' +
        '## Context refs\n\n' +
        '- 6.11.2 ADR (`docs/decisions/triage-model.md` §3) + 6.11.3 schema — ' +
        'what this retires.\n' +
        '- 6.11.4 — the intake that establishes `submittedByUserId`-only ' +
        'attribution; Story 6.12 — the signed-in non-member path.\n' +
        '- `motir-core/CLAUDE.md` § migration FK-as-relation + the shared-DB ' +
        'migrate-dev drift rule + the per-file coverage gate.',
      dependsOn: ['6.11.4', '6.11.8'],
    },
  ],
};
