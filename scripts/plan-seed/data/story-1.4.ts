import type { PlanStory } from '../types';

/**
 * Story 1.4 — Work-item (issue) data model.
 * Faithful transcription of prodect_plan/story-1.4-work-item-model.html (frozen archive).
 */
export const story_1_4: PlanStory = {
  id: '1.4',
  title: 'Work-item (issue) data model',
  status: 'done',
  descriptionMd:
    "The `work_item` table — the unit of tracked work in Motir's PM core. Every " +
    'epic, story, task, bug, and subtask a team plans in a project is a row in this table. ' +
    'Self-referencing tree (`parent_id`) with DB-level kind-parent rules and a depth ' +
    'limit. Carries the two user-visible content axes — `descriptionMd` ' +
    '("what to do") and `explanationMd` ("why this matters") — both Markdown-source, ' +
    'GFM-rendered, with explanation provenance tracked (`user_authored` / ' +
    '`ai_draft` / `user_edited`) so the UI can surface "AI-drafted, review me" ' +
    "hints to non-technical reviewers. Wires Story 1.3's per-project key counter to allocate " +
    'human-readable identifiers (`PROD-42`). Ships the schema, repository, service, ' +
    'RLS, dependency join table (`work_item_link`), and revision-history audit trail ' +
    'that every PM-core Epic (2 through 6) and the AI Planning Layer (Epic 7) build on. Reframed ' +
    'from the May 2026 plan revision: this Story models the *tracked work* issue tree ' +
    "(Jira's domain), not the AI planning meta-tree (Epic 7's domain — see Scope).\n\n" +
    '**Prerequisites:** [Story 1.3 (Projects)](story-1.3-projects.html) ' +
    'must be complete — `work_item` FKs against `Project` with ' +
    '`onDelete: Cascade`, the RLS policies key off the same ' +
    '`app.workspace_id` session GUC that 1.2.3 established, and the ' +
    'issue-key allocator (`PROD-42`) calls `projectRepository.allocateWorkItemNumber` ' +
    "shipped in 1.3.1. [Story 1.2 (Workspaces)](story-1.2-workspaces.html)'s RLS " +
    'pattern is the structural model this Story copies. [Story 1.0.5 (Design system)](story-1.0.5-design-system.html) ' +
    'must be complete before 1.4.1 (mockup) — the issue-detail view composes the canonical ' +
    '`Button`, `Input`, `Textarea`, `Select`, `Card`, `Avatar`, `Badge` primitives. All code follows ' +
    "`motir-core/CLAUDE.md`'s 4-layer rule (Route → Service → Repository → Prisma).",
  verificationRecipeMd:
    'Functional verification — run the data layer end-to-end through the test endpoint added in ' +
    "1.4.8. No production UI yet (that's Epic 2); this recipe exercises the service via HTTP + " +
    'Prisma Studio + inspection.\n\n' +
    '- Pull the merged Story branch; `pnpm install && pnpm prisma migrate dev && pnpm dev`.\n' +
    "- Sign in as user A (use the seeded account from Story 1.1's E2E fixtures); confirm a workspace + project exist.\n" +
    '- Hit the test endpoint to create an epic: `curl -X POST .../api/_test/work-items -d \'{"kind":"epic","title":"Q3 launch","projectId":"..."}\' --cookie session`. Note the returned identifier (e.g. `PROD-1`).\n' +
    "- Open Prisma Studio (`pnpm prisma studio`); confirm the work_item row exists with the expected fields and that a work_item_revision row exists with `changeKind = 'created'`.\n" +
    '- Create a story under the epic; create a subtask under the story; try to create a story under the subtask — expect a 4xx with `IllegalParentTypeError`.\n' +
    '- Try to create a 5th-level descendant — expect `DepthLimitExceededError`.\n' +
    '- Update the epic\'s title via PATCH; refresh Prisma Studio — confirm a new revision row with diff `{ title: { from: "Q3 launch", to: ... } }`.\n' +
    '- **Explanation-source check:** PATCH the epic with `{"explanationMd": "## Why this matters\\n\\nThis launch...", "explanationSource": "ai_draft"}` (simulating Epic 7\'s AI-drafting endpoint). GET the epic — confirm both fields stored. PATCH again with only `{"explanationMd": "## Updated\\n\\n..."}` (no explicit source) — GET confirms `explanationSource = user_edited` auto-transitioned. Open Prisma Studio — confirm three revision rows for the epic with the right diffs.\n' +
    "- **Markdown render check:** hit `GET /api/_test/work-items/{id}?render=1` — response body's `descriptionHtml` + `explanationHtml` fields contain sanitized HTML; verify any `<script>` tags in the Markdown source are stripped from the HTML output. Open a code-block test fixture, confirm syntax highlighting markup is present.\n" +
    '- **Dependency check:** create two more issues Y and Z; link the epic is_blocked_by Y and is_blocked_by Z via `POST /api/_test/work-item-links {fromId: epic.id, toId: Y.id, kind: \'is_blocked_by\'}`. Hit `GET /api/_test/work-item-links?workItemId=epic.id&ready=1` — expect `{ready: false}`. PATCH Y and Z to status="done". Re-hit the ready endpoint — expect `{ready: true}`.\n' +
    '- **Cycle check:** try to link Y is_blocked_by the epic — expect a 4xx with `WI_LINK_CYCLE` in the body.\n' +
    "- Sign out, sign in as user B (in a different workspace from the seed fixtures); try to GET the epic by its ID — expect 404. Try to GET any of A's links — expect empty results.\n" +
    '- Optional: open two terminals, fire 20 concurrent POSTs against the test endpoint, confirm the resulting keys are 1..20 with no duplicates.\n' +
    '- Mark accepted if every step matches; mark needs-changes with notes if not.',
  items: [
    {
      id: '1.4.1',
      title:
        'Mockup: issue detail view + tree view + create modal (data-only surface for 1.4 verification)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['1.0.5.2'],
      descriptionMd:
        "Produce viewable mockups of the three surfaces Epic 2 will build on top of Story 1.4's " +
        'data layer — the issue **detail view**, the issue **tree view** ' +
        '(parent → children), and the issue **create modal** — *before* ' +
        'Epic 2 starts. Per Principle #13 (design-before-code, within every Story), and per ' +
        '[notes.html mistake #4](../notes.html): design Subtasks are flat peers, not ' +
        'deferred to feature Stories. Even though 1.4 itself ships no UI, the detail-view shape ' +
        "is the contract Epic 2's UI Subtasks read; landing it here keeps Epic 2 free to focus " +
        'on routes + state, not also visual decisions.\n\n' +
        "**Why now (vs. punting to Epic 2):** Story 1.4's acceptance criteria " +
        'commit to specific fields (priority, assignee, dueDate, estimateMinutes, ' +
        'descriptionMd, explanationMd, explanationSource). The detail-view mockup pressure-tests ' +
        'whether those fields hold up as user-visible shape — especially the ' +
        'description-vs-explanation split (do they read as obviously different concepts? does ' +
        'the AI-drafted badge clutter or clarify?) and the explanation-source state visuals. ' +
        'If the mockup reveals a missing field (e.g. `labels` being too painful to ' +
        'defer) or that explanation badging needs a separate dismissible-notice pattern, it ' +
        'lands in the schema NOW, not as a destructive Epic 5 migration later. Design discovery ' +
        "preceding schema commit is the same load-bearing pattern Story 1.1's 1.1.1 design " +
        'Subtask used.\n\n' +
        "**What you'll do:** Open `@pencil.dev/cli` (per " +
        '`feedback_pencil_cli_for_design_subtasks` — the desktop MCP has no ' +
        '`save()`; CLI does). Compose with the canonical primitives only — Button, ' +
        'Input, Textarea, Select, Card, Avatar, Badge from `components/ui/`. Lay ' +
        'out:\n\n' +
        '- **Detail view** (`/design/work-items/detail.pen`): ' +
        'two-column layout, left = title + **description** (Markdown-rendered, ' +
        'section heading "Description — what to do") + **explanation** ' +
        '(Markdown-rendered, section heading "Explanation — why this matters", collapsed by ' +
        'default for technical users / expanded by default for non-technical users — design a ' +
        "subtle toggle) + activity placeholder (sized to host Epic 5's comments later), right " +
        '= sidebar with status pill, priority pill, assignee Avatar+name + change button, ' +
        'reporter line, due date, estimate, parent breadcrumb, identifier (`PROD-42`) ' +
        'at the top, archive button at the bottom of the sidebar. Linear-style information ' +
        'density — every field visible without scrolling on a 1280px viewport. **Explanation ' +
        'section affordances:** (a) when `explanationMd` is `NULL`, show ' +
        'a "Draft explanation with AI" CTA button + a "Write manually" link as fallback; ' +
        '(b) when `explanationSource = ai_draft`, surface a subtle pill above the ' +
        'rendered Markdown ("AI-drafted — review me") + an "Edit" affordance that opens the ' +
        'editor (the act of editing transitions the source to `user_edited` per ' +
        'the service-layer state machine); (c) when `user_edited` or ' +
        '`user_authored`, no badge — looks like any user-written field; (d) a ' +
        '"Regenerate with AI" link is always available once content exists (overwrites the ' +
        'column, prior text retrievable from revision history).\n' +
        '- **Tree view** (`/design/work-items/tree.pen`): indented ' +
        'list of work_items, each row showing kind icon (epic/story/task/bug/subtask) + ' +
        'identifier + title + assignee Avatar + status Badge. Twisty-arrow for collapse. ' +
        "Drag-handle indicator on hover (Epic 3's board work consumes this affordance). " +
        'Empty state for new projects.\n' +
        '- **Create modal** (`/design/work-items/create.pen`): Dialog ' +
        'with title input, kind Select (epic/story/task/bug — subtask creates via the ' +
        '"Add subtask" affordance on a parent\'s detail view, not the top-level create ' +
        'modal), parent Select (lazy-search, filtered by allowed-children rule — ' +
        'disabled-with-tooltip for illegal pairs), assignee Select, priority Select with ' +
        "medium pre-selected, **description Markdown editor** (with the editor's " +
        'live-preview toggle in the corner — same component used by the detail view), ' +
        'Cancel / Create buttons. **No explanation field in the create modal** ' +
        '— explanation is drafted post-create on the detail page (either AI-assist or ' +
        'manual). Rationale: cluttering the create modal with an "explanation" textarea ' +
        'trains users to skip it; deferring to the detail-page CTA puts AI-assist front and ' +
        'center where it gets used.\n\n' +
        'Save `.pen` sources AND PNG exports for each surface. Update ' +
        '`/docs/design-system.md` if the mockups surface a new pattern (none expected ' +
        '— composition only).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three `.pen` files exist under `/design/work-items/` with PNG exports alongside.\n' +
        '- Detail view shows all v1.4 schema fields (identifier, title, descriptionMd, explanationMd, explanationSource state, status, priority, assigneeId, reporterId, dueDate, estimateMinutes, parentId, archivedAt-state).\n' +
        '- Description and explanation sections are visually distinct on the detail view (clear "Description — what to do" / "Explanation — why this matters" labels; the explanation section\'s prose styling reads as long-form context vs. description\'s actionable spec). A non-technical reviewer looking at the mockup should be able to tell, without prompting, which field tells them WHAT and which tells them WHY.\n' +
        '- Detail-view explanation section renders THREE states: (a) empty — "Draft explanation with AI" CTA + manual fallback link; (b) `ai_draft` — Markdown content with the "AI-drafted — review me" pill above it + Edit affordance; (c) `user_authored` / `user_edited` — Markdown content with no badge, just an Edit pencil and a subtle "Regenerate with AI" link. All three rendered in the .pen file.\n' +
        '- Tree view shows kind icon + identifier + title + assignee Avatar + status Badge per row; supports indentation up to the depth-4 limit visually.\n' +
        '- Create modal has description editor but NO explanation field (explanation drafted post-create on detail page).\n' +
        "- Create modal's parent Select demonstrates the allowed-children rule (illegal parents are disabled with a tooltip explaining why).\n" +
        '- All surfaces compose only existing primitives — no new design tokens or component shapes introduced.\n' +
        '- The mockups reveal no missing v1 schema fields (or, if they do, the Subtask raises a finding in [PRODECT_FINDINGS.md](PRODECT_FINDINGS.md) before merging — per [notes.html mistake #27](../notes.html)).\n' +
        '- Mockups respect the brand-mark deferral principle — no wordmark / logomark anywhere on these surfaces (per MOTIR.md decision).\n\n' +
        '## Context refs\n\n' +
        '- `/docs/design-system.md` — canonical visual reference\n' +
        '- `/components/ui/Button.tsx, Input.tsx, Textarea.tsx, Select.tsx, Card.tsx, Avatar.tsx, Badge.tsx, Dialog.tsx` — primitives to compose from\n' +
        '- `/design/workspaces/settings.pen` from Subtask 1.2.1 — the visual grammar for two-column layouts with a sidebar (the detail view mirrors this shape)\n' +
        '- `/design/projects/*.pen` from Subtask 1.3.3 — the tree-view affordances Story 1.3 established\n' +
        '- [MOTIR.md](../MOTIR.md) — brand-mark deferral principle, design-system tokens\n' +
        '- This Story page (Story 1.4) — the schema fields the detail view must surface',
    },
    {
      id: '1.4.2',
      title:
        'Schema: WorkItem model (incl. descriptionMd / explanationMd / explanationSource) + kind-parent/depth/cycle triggers + repo + Markdown render stack',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: ['1.3.1'],
      descriptionMd:
        "Add the `WorkItem` Prisma model with the verbatim shape from this Story's " +
        'acceptance criteria, generate the migration, write the Postgres trigger functions that ' +
        'enforce the kind-parent rule + depth limit + cycle prevention at the DB layer, and ' +
        'ship the repository (single-Prisma-op leaves with required-`tx` on writes). ' +
        "No service layer in this Subtask — that's 1.4.4.\n\n" +
        '**Why DB-level constraints, not service-layer-only:** the kind-parent ' +
        'rule is a structural invariant of the data model. If it lives only in the service ' +
        'layer, then any future direct Prisma access (a maintenance script, an admin path, a ' +
        'future microservice) can violate it silently. A Postgres trigger is the durable shape ' +
        '— it fires on every INSERT/UPDATE regardless of where the call originated, mirroring ' +
        'how RLS guarantees workspace isolation regardless of application path. The ' +
        'triggers are written in `prisma/sql/work_item_triggers.sql` and applied via ' +
        'a raw-SQL Prisma migration (Prisma supports raw SQL migrations natively).\n\n' +
        '**Trigger sketch:**\n' +
        '`CREATE FUNCTION enforce_work_item_kind_parent() RETURNS TRIGGER AS $$ BEGIN\n' +
        'IF NEW.parent_id IS NULL THEN\n' +
        "  IF NEW.kind = 'subtask' THEN RAISE EXCEPTION 'WI_SUBTASK_NEEDS_PARENT' USING ERRCODE = '23514'; END IF;\n" +
        '  RETURN NEW;\n' +
        'END IF;\n' +
        'SELECT kind INTO parent_kind FROM work_item WHERE id = NEW.parent_id;\n' +
        'IF NOT is_legal_parent_child(parent_kind, NEW.kind) THEN\n' +
        "  RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE' USING ERRCODE = '23514';\n" +
        'END IF;\n' +
        '-- depth + cycle checks here too\n' +
        'RETURN NEW; END; $$ LANGUAGE plpgsql;`\n' +
        "The repository's `create`/`update` methods catch SQLSTATE 23514 " +
        'with the specific MESSAGE markers and translate to typed errors from ' +
        '`lib/workItems/errors.ts`.\n\n' +
        '**Fractional indexing for `position`:** use the ' +
        '[fractional-indexing](https://www.npmjs.com/package/fractional-indexing) ' +
        'library (LexoRank-style, the Linear/Notion/Figma standard). New items at the end of a ' +
        'parent get a key after the current last child; reorders compute a key between the two ' +
        'neighbors. Decimal(20,10) is plenty of headroom — the keys are short strings, but they ' +
        'sort lexically as decimals after parsing. *Choosing this over an integer ' +
        '`position` with bulk-shift-on-insert because shifts are O(N) writes per ' +
        "reorder, and the bulk-shift pattern is what Jira's original design got wrong.*\n\n" +
        "**What you'll do:** Extend `prisma/schema.prisma` with " +
        '`WorkItem` + the three enums (`WorkItemKind`, ' +
        '`WorkItemPriority`, `WorkItemExplanationSource`). Write the ' +
        'trigger SQL in `prisma/sql/work_item_triggers.sql`. Generate the migration ' +
        '`add_work_items`, append the trigger SQL to the migration file. Add ' +
        '`lib/repositories/workItemRepository.ts` with the single-op methods listed ' +
        'in the AC. Add `lib/workItems/errors.ts` with the typed errors. Add ' +
        '`lib/dto/workItems.ts` + `lib/mappers/workItemMappers.ts` ' +
        '(Prisma row → DTO conversion). Install `fractional-indexing` as a runtime ' +
        'dependency. Install the Markdown render stack (`react-markdown`, ' +
        '`remark-gfm`, `rehype-sanitize`, `rehype-highlight`) ' +
        "as runtime dependencies — the renderer component itself is built in Epic 2's " +
        'issue-detail Subtask, but the deps land here so the schema and a smoke-rendered ' +
        '`/dev/markdown` page can confirm GFM features render correctly before the ' +
        'UI Subtask consumes them. Add `lib/markdown/render.tsx` with a single ' +
        '`renderMarkdown(md: string)` helper that pipes through the standard sanitize ' +
        '+ GFM + highlight chain — this is the canonical renderer Epic 2 + Epic 5 + Epic 7 all ' +
        "consume. **No Markdown editor in this Subtask** — that's Epic 2; for " +
        'v1.4 verification the test endpoint writes raw Markdown strings.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `WorkItem` + `WorkItemKind` + `WorkItemPriority` + `WorkItemExplanationSource` in `prisma/schema.prisma` with the verbatim field set + relations + indexes from this Story's AC, including `descriptionMd String? @db.Text`, `explanationMd String? @db.Text`, `explanationSource WorkItemExplanationSource @default(user_authored)`. `pnpm prisma generate` succeeds.\n" +
        '- Markdown render stack installed: `react-markdown`, `remark-gfm`, `rehype-sanitize`, `rehype-highlight`. `lib/markdown/render.tsx` exports a `renderMarkdown(md: string)` component that pipes through the sanitize + GFM + highlight chain. Smoke test (unit test) renders a fixture containing headings, lists, tables, task checkboxes, code blocks, links, images, and an inline `<script>` tag — asserts the script tag is stripped and every other element renders as expected semantic HTML.\n' +
        '- Migration `add_work_items` applies cleanly. The migration includes the trigger functions and `CREATE TRIGGER` statements. Down-migration is reversible (drops triggers, then the table).\n' +
        '- Triggers reject illegal kind-parent pairs (every illegal pair from the matrix in the AC), depth > 4, and re-parent cycles, surfacing SQLSTATE 23514 with distinct error messages per failure mode.\n' +
        '- `workItemRepository` exports `findById`, `findByIdentifier`, `findByProject`, `findSubtree`, `findChildren`, `create(data, tx)`, `update(id, data, tx)`, `archive(id, tx)`. All writes require `tx: Prisma.TransactionClient`. Trigger errors are translated to `IllegalParentTypeError` / `DepthLimitExceededError` / `ParentCycleError` at the repository edge.\n' +
        '- `findSubtree` uses a recursive CTE inside `$queryRaw` and returns the full subtree (with depth info) in one round-trip. Verify on a tree of ~50 items: single query.\n' +
        '- `lib/dto/workItems.ts` exports `WorkItemDto` + `WorkItemSummaryDto` + `WorkItemRevisionDto`. `lib/mappers/workItemMappers.ts` converts. The repository never returns raw Prisma rows past the public boundary except to the service layer (kept internal).\n' +
        '- `fractional-indexing` installed; a helper `lib/workItems/positioning.ts` exposes `keyForAppend(last)`, `keyBetween(prev, next)`, `keyForPrepend(first)`. Unit tests over each (deterministic outputs vs. known fixtures).\n' +
        '- Repository-layer Vitest tests: `create` persists; `create` with illegal parent kind rejects with `IllegalParentTypeError`; `create` at depth 5 rejects with `DepthLimitExceededError`; `update` setting parentId to a descendant rejects with `ParentCycleError`; `findSubtree` returns the right shape. Tests use a real Postgres per the standing no-mocks rule.\n' +
        '- No `db.*` / `$transaction` outside the repository layer (no service layer exists yet).\n' +
        '- All quality gates green: `pnpm prisma generate && typecheck && lint && format:check && build && test`. Existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `prisma/schema.prisma` — current Workspace / WorkspaceMembership / Project models\n' +
        "- `lib/repositories/projectRepository.ts` — the single-op + required-`tx` pattern; `allocateWorkItemNumber` is the method this Story's service layer will consume (in 1.4.4)\n" +
        '- `lib/repositories/workspaceRepository.ts` — error-translation pattern (Prisma error → typed error at the repository edge)\n' +
        '- `lib/workspaces/errors.ts` + `lib/projects/errors.ts` — typed-error pattern\n' +
        '- `lib/dto/projects.ts` + `lib/mappers/projectMappers.ts` — DTO/mapper pattern\n' +
        '- This Story page (Story 1.4) — schema spec + trigger spec + AC\n' +
        '- [fractional-indexing](https://www.npmjs.com/package/fractional-indexing) npm page for the helper API surface',
    },
    {
      id: '1.4.3',
      title: 'WorkItemLink table + repository (issue-to-issue dependencies, many-to-many)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.4.2'],
      descriptionMd:
        'Ship the `WorkItemLink` table — the many-to-many join that models ' +
        'dependencies and other inter-issue relationships. Per the "Why `work_item_link`" ' +
        'section above: a JSON `depends_on` column on the row was the rejected ' +
        'shortcut; a separate join table is the durable shape every comparable tool uses, and ' +
        "it lands HERE (not Epic 5) because the AI Planning Layer's ready-set engine is " +
        'unbuildable without indexed dependency queries.\n\n' +
        '**Schema:**\n\n' +
        '```\n' +
        'model WorkItemLink {\n' +
        '  id          String           @id @default(cuid())\n' +
        '  workspaceId String           // RLS gate (denormalized from fromItem for RLS speed)\n' +
        '  fromId      String\n' +
        '  toId        String\n' +
        '  kind        WorkItemLinkKind\n' +
        '  createdById String\n' +
        '  createdAt   DateTime         @default(now())\n\n' +
        '  fromItem  WorkItem  @relation("LinksFrom", fields: [fromId], references: [id], onDelete: Cascade)\n' +
        '  toItem    WorkItem  @relation("LinksTo",   fields: [toId],   references: [id], onDelete: Cascade)\n' +
        '  createdBy User      @relation(fields: [createdById], references: [id], onDelete: Restrict)\n' +
        '  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)\n\n' +
        '  @@unique([fromId, toId, kind])     // no duplicate links of the same kind\n' +
        '  @@index([toId, kind])              // reverse lookup: "what does B unblock / what blocks B?"\n' +
        '  @@index([fromId, kind])            // forward lookup: "what does A depend on?"\n' +
        '  @@index([workspaceId])             // workspace RLS\n' +
        '  @@map("work_item_link")\n' +
        '}\n\n' +
        'enum WorkItemLinkKind {\n' +
        '  is_blocked_by   // fromItem is_blocked_by toItem  ⇒  "A depends on B" → from=A, to=B\n' +
        '  relates_to      // symmetric soft link\n' +
        '  duplicates      // fromItem duplicates toItem\n' +
        '  clones          // fromItem is a clone of toItem\n' +
        '}\n' +
        '```\n\n' +
        '**Direction convention (Jira-style):** a row reads as ' +
        '*"`fromItem` <kind> `toItem`"*. For "A depends on ' +
        'B, C, D" — three rows are written, all `fromId=A`, `toId IN (B,C,D)`, ' +
        '`kind=is_blocked_by`. The forward query ("A\'s blockers") selects on ' +
        '`fromId=A AND kind=is_blocked_by`; the reverse ("what\'s blocked by B") ' +
        'selects on `toId=B AND kind=is_blocked_by`. Both queries are O(log n) via ' +
        'the dedicated indexes.\n\n' +
        '**Why `workspaceId` denormalized onto the link row:** RLS ' +
        'needs to gate links by workspace. Without the denormalized column, the policy would ' +
        'have to join to `work_item` on every read — adds a join + makes the policy ' +
        'harder to reason about. Denormalize and enforce consistency at write time ' +
        '(the service layer asserts `fromItem.workspaceId === toItem.workspaceId` ' +
        'and writes that workspaceId into the link row; a trigger ALSO validates this on ' +
        'INSERT/UPDATE as the structural backstop).\n\n' +
        '**Cross-project links allowed, cross-workspace links forbidden.** ' +
        'Real teams have epics whose stories live in sibling projects (e.g., a ' +
        '`motir-ai` epic blocks a `motir-core` story — same ' +
        'workspace, different projects). The RLS policy gates by workspace only. The project ' +
        'GUC, when set, narrows reads of *work items* but not of *links* — a ' +
        'link query against a project context returns links where either endpoint matches the ' +
        'active project (so the dependency badge can render in a project-scoped board view).\n\n' +
        '**Cycle prevention on `is_blocked_by`:** A is_blocked_by B ' +
        'is_blocked_by A is incoherent. A Postgres trigger fires on INSERT/UPDATE of any ' +
        '`is_blocked_by` row, walks the blocker chain via recursive CTE, and rejects ' +
        'cycles with SQLSTATE 23514 + `WI_LINK_CYCLE` marker (translated to ' +
        '`WorkItemLinkCycleError` at the repository edge). `relates_to` ' +
        'is symmetric — no cycle check needed; we additionally write the reciprocal row ' +
        'automatically inside the same transaction (so "A relates_to B" produces two rows: A↔B ' +
        'and B↔A, both visible to the both-directions UI). `duplicates` and ' +
        '`clones` are directional but not cycle-prone in practice; cycle check is ' +
        'scoped to `is_blocked_by` only.\n\n' +
        "**What you'll do:** Extend `prisma/schema.prisma` with " +
        '`WorkItemLink` + `WorkItemLinkKind` + the back-relations on ' +
        '`WorkItem` (`linksFrom WorkItemLink[] @relation("LinksFrom")` + ' +
        '`linksTo WorkItemLink[] @relation("LinksTo")`). Generate migration ' +
        '`add_work_item_links`; append the cycle-prevention trigger SQL and the ' +
        'workspaceId-consistency trigger SQL to the migration file. Add ' +
        '`lib/repositories/workItemLinkRepository.ts` with single-Prisma-op leaves: ' +
        '`create(data, tx)`, `delete(id, tx)`, ' +
        '`findByFromItem(fromId, kind?)`, `findByToItem(toId, kind?)`, ' +
        '`findById(id)`. All writes require `tx`. Add ' +
        '`lib/workItems/linkErrors.ts` with ' +
        '`WorkItemLinkCycleError`, `CrossWorkspaceLinkError`, ' +
        '`DuplicateLinkError` (the unique constraint translates to this), ' +
        '`SelfLinkError` (fromId === toId is rejected by trigger). ' +
        'Add `lib/dto/workItemLinks.ts` + `lib/mappers/workItemLinkMappers.ts`. ' +
        '**Service-layer linking methods land in 1.4.4** (alongside the rest of ' +
        'the work-item service surface) — this Subtask stops at the repository edge so 1.4.4 ' +
        'can own all transactional work-item business logic in one place.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `WorkItemLink` + `WorkItemLinkKind` in `prisma/schema.prisma` with the verbatim field set + relations + indexes above. `WorkItem` gets the two back-relations.\n' +
        "- Migration `add_work_item_links` applies cleanly. Includes: the table, the unique + secondary indexes, the cycle-prevention trigger function (scoped to `is_blocked_by` rows), the workspaceId-consistency trigger (rejects rows where the from/to items belong to different workspaces or where the row's `workspaceId` mismatches the from item), and the self-link trigger (`fromId = toId` rejected). Down-migration reverses all of it.\n" +
        '- Triggers reject: cycle insertion on `is_blocked_by` (e.g., A blocks B, B blocks A); cross-workspace links; self-links; workspaceId mismatch between the link row and the from item. Each failure mode uses a distinct SQLSTATE 23514 message marker.\n' +
        '- `workItemLinkRepository` exports the methods above; all writes require `tx: Prisma.TransactionClient`. Trigger errors are translated to the typed errors in `lib/workItems/linkErrors.ts`. The Prisma `P2002` unique-violation is translated to `DuplicateLinkError`.\n' +
        '- `findByFromItem` / `findByToItem` accept an optional `kind` filter. With no kind, returns all link kinds for the endpoint. Pagination not required at this layer (links per item are bounded; service layer can paginate if needed).\n' +
        '- `lib/dto/workItemLinks.ts` exports `WorkItemLinkDto`. Mapper converts Prisma rows; never returns raw Prisma rows past the public boundary.\n' +
        '- Repository-layer Vitest tests against real Postgres: `create` persists; cycle rejection (A→B then B→A on `is_blocked_by`); cross-workspace rejection; self-link rejection; duplicate-link rejection on the unique constraint; `findByFromItem` + `findByToItem` return the right rows with kind filtering.\n' +
        '- No `db.*` / `$transaction` calls inside the repository (4-layer rule).\n' +
        '- All quality gates green: `pnpm prisma generate && typecheck && lint && format:check && build && test`. Existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `prisma/schema.prisma` — current `WorkItem` model from 1.4.2 (this Subtask adds back-relations)\n' +
        '- `prisma/sql/work_item_triggers.sql` from 1.4.2 — the trigger-writing pattern (cycle-check recursive CTE shape, SQLSTATE 23514 + message markers)\n' +
        '- `lib/repositories/workItemRepository.ts` + `lib/workItems/errors.ts` from 1.4.2 — the repository pattern + error-translation pattern to mirror\n' +
        '- This Story page — schema + trigger spec + direction convention',
    },
    {
      id: '1.4.4',
      title:
        'Service layer: createWorkItem (with key allocation) + update + assign + archive + move + link/unlink + ready-set helpers',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['1.4.2', '1.4.3'],
      descriptionMd:
        'Add `lib/services/workItemsService.ts` — the layer that owns transactions, ' +
        'calls the repository, validates business rules, and returns DTOs. This is the surface ' +
        "Epic 2's route handlers will call. Per `motir-core/CLAUDE.md`: services " +
        'own `$transaction`; repositories never call `db.*` without a ' +
        'passed-in `tx`; routes are HTTP-only and call services with mapped inputs.\n\n' +
        '**Method set:**\n\n' +
        '- `createWorkItem(input: CreateWorkItemInput, ctx: ServiceContext): Promise<WorkItemDto>` ' +
        '— within a transaction: assert project membership (the reporter must belong to the ' +
        "project's workspace), assert parent (if any) belongs to the same project, assert " +
        'assignee (if any) is a workspace member, call ' +
        '`projectRepository.allocateWorkItemNumber(projectId, tx)` for the next ' +
        'key, derive `identifier` = `"${project.identifier}-${key}"`, ' +
        'compute `position` via fractional indexing (append after the current ' +
        'last sibling), call `workItemRepository.create` (the trigger validates ' +
        "kind/depth), write the initial revision row (changeKind='created'). Returns DTO.\n" +
        '- `updateWorkItem(id, patch: UpdateWorkItemInput, ctx): Promise<WorkItemDto>` ' +
        '— within a transaction: load the current row, compute the diff vs `patch` ' +
        '(omit unchanged fields), validate parent move (if parentId in patch) against the ' +
        'allowed-children rule at the service layer too (cheap pre-flight before the trigger), ' +
        'call `workItemRepository.update`, write a revision row with the diff ' +
        "(changeKind='updated'). Returns DTO. Rejects no-op patches early without writing.\n" +
        '- `assignWorkItem(id, assigneeId, ctx)` — specialized service for the ' +
        'common case; same shape as updateWorkItem but with explicit assignee-membership ' +
        'validation. (Worth a method because reassignment is the highest-volume mutation in ' +
        "a working PM tool — Linear's metrics show 40%+ of all writes are reassignments.)\n" +
        '- `archiveWorkItem(id, ctx)` — soft-delete via repository, write a ' +
        "revision (changeKind='archived'). Archiving an epic does NOT cascade-archive " +
        "children — that's a Linear-shape choice: orphaned children become top-level " +
        'until manually re-parented. Document this in the service.\n' +
        '- `moveWorkItem(id, newParentId, beforeId, afterId, ctx)` — re-parent + ' +
        'reorder atomically. Computes the new fractional-indexing key from ' +
        "`beforeId` and `afterId`'s positions. Trigger validates the " +
        'kind-parent rule + cycle.\n' +
        '- `listWorkItems(projectId, filter, ctx)` — paginated list with optional ' +
        "kind/status/assignee filters. Calls repository's `findByProject`.\n" +
        '- `getWorkItemSubtree(rootId, ctx)` — returns the full subtree DTOs via ' +
        "repository's `findSubtree`.\n" +
        '- `linkWorkItems(fromId, toId, kind, ctx)` — within a transaction: ' +
        'load both items, assert same-workspace at the service layer (the trigger backstops ' +
        "this), derive the link row's `workspaceId` from the from item, call " +
        '`workItemLinkRepository.create`. For `relates_to`, write the ' +
        'reciprocal row in the same transaction so both endpoints see the symmetric link. ' +
        "Writes a revision row on the from item (changeKind='updated', diff " +
        '`{ links: { added: [{toId, kind}] } }`) — so the activity feed ' +
        'surfaces dependency changes, not just field changes.\n' +
        '- `unlinkWorkItems(linkId, ctx)` — load the link (typed ' +
        '`WorkItemLinkNotFoundError` if absent); for `relates_to`, also ' +
        'delete the reciprocal row; write a revision row with diff ' +
        '`{ links: { removed: [{toId, kind}] } }`.\n' +
        '- `getBlockers(workItemId, ctx): Promise<WorkItemSummaryDto[]>` — ' +
        '"what does A depend on?" Returns the to-items of all `is_blocked_by` ' +
        'links where `fromId = workItemId`. Calls ' +
        "`workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by')` " +
        'then resolves the toIds to summary DTOs via ' +
        '`workItemRepository.findByIds` (add this method to the repo in 1.4.3 if ' +
        'not already there).\n' +
        '- `getBlocking(workItemId, ctx): Promise<WorkItemSummaryDto[]>` — ' +
        'reverse: "what depends on A?" Selects on `toId = workItemId AND kind = ' +
        'is_blocked_by`, resolves fromIds. This is the query the AI ready-set engine ' +
        'runs over many items to figure out what unblocks when an item ships.\n' +
        '- `isReady(workItemId, ctx): Promise<boolean>` — the ready-set ' +
        'predicate Principle #14 specifies. Returns `true` iff every blocker ' +
        '(every to-item of an `is_blocked_by` link with `fromId = ' +
        "workItemId`) has `status = 'done'` (or, conservatively for v1, " +
        'any "terminal" status; v1 hardcodes done, Epic 2\'s workflow Story generalizes to ' +
        'the per-project terminal-status set). Implemented as a single SQL query — a ' +
        'LEFT JOIN over the link table that returns rows where any blocker is not-done; if ' +
        "no rows returned, item is ready. Document: this is the building block Epic 7's " +
        'ready-set engine batches across the whole tree.\n\n' +
        '**`ServiceContext`:** matches the existing ' +
        '`workspacesService` / `projectsService` contract — ' +
        '`{ userId: string, workspaceId: string }`. The middleware that sets the ' +
        '`app.workspace_id` GUC has already run; service methods never re-set it.\n\n' +
        '**Revision rows live in the same transaction.** If the work-item write ' +
        'commits but the revision write fails, the audit trail is broken — both must be in the ' +
        'same `$transaction`. Easy to get wrong; tests in 1.4.7 verify ' +
        'atomicity by injecting a revision-repo failure mid-flight.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/services/workItemsService.ts` exports the 11 methods above (the 7 work-item methods + `linkWorkItems` + `unlinkWorkItems` + `getBlockers` + `getBlocking` + `isReady`). Every write method opens a single `$transaction` and threads `tx` to every repository call inside it.\n' +
        '- Input types (`CreateWorkItemInput`, `UpdateWorkItemInput`, `LinkWorkItemsInput`) live in `lib/dto/workItems.ts` + `lib/dto/workItemLinks.ts` alongside the output DTOs.\n' +
        '- `createWorkItem` allocates the next per-project key atomically with the work-item insert (one transaction) and the initial revision row insert. A concurrent `createWorkItem` against the same project produces non-overlapping keys.\n' +
        '- `updateWorkItem` writes a revision row only when at least one field actually changes; no-op patches return the current row without writing.\n' +
        "- **Explanation-source state machine**: when a patch contains `explanationMd` AND the current row's `explanationSource` is `ai_draft` AND the patch did NOT explicitly set `explanationSource`, the service auto-transitions `explanationSource` to `user_edited` in the same patch. (The user's edit IS the signal that they've taken ownership.) When the AI-drafting service (Epic 7) writes a fresh draft, it explicitly sets `explanationSource = ai_draft` in its patch, overriding any prior state. The revision diff includes the source transition as one of its fields, so the activity feed shows \"User edited the AI draft\" as a first-class event.\n" +
        '- `moveWorkItem` computes a fractional-indexing key from the `beforeId`/`afterId` neighbors; the resulting key sorts between them. Edge cases handled: move to start (`beforeId=null`), move to end (`afterId=null`), only sibling.\n' +
        '- `archiveWorkItem` leaves children intact (NOT cascade-archived); a code comment documents the Linear-shape choice.\n' +
        '- `linkWorkItems` writes the link row + a revision on the from item; for `relates_to`, writes the reciprocal row in the same transaction. Same-workspace asserted at the service layer (the trigger backstops). Rejects with `WorkItemLinkCycleError` when the trigger fires on cycle insertion.\n' +
        '- `unlinkWorkItems` deletes the link + writes the removal revision; for `relates_to`, deletes the reciprocal row too.\n' +
        '- `getBlockers` and `getBlocking` return `WorkItemSummaryDto[]`; resolution from link IDs to work-item summaries is a single follow-up query (`findByIds`), not N+1.\n' +
        '- `isReady` implemented as a single SQL query (no fetch-then-check); for v1, "ready" = every `is_blocked_by` blocker has `status = \'done\'`. Document the v1 hardcode and the Epic-2 generalization point inline.\n' +
        "- Service-layer Vitest tests: createWorkItem assigns sequential keys; updateWorkItem writes a revision with the right diff; concurrent creates against the same project don't collide; archive doesn't cascade; moveWorkItem reorders within parent; moveWorkItem to a new parent updates parentId atomically; linkWorkItems writes link + revision atomically; linkWorkItems with `relates_to` writes both directions; unlinkWorkItems removes both directions for `relates_to`; getBlockers + getBlocking return correct sets; isReady returns false until all blockers are done and true after.\n" +
        '- No `db.*` or `$transaction` calls inside `workItemRepository` or `workItemLinkRepository`. No repository methods called without a passed-in `tx` on writes.\n' +
        '- All quality gates green; existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `lib/services/projectsService.ts` + `lib/services/workspacesService.ts` — the exact transactional pattern to mirror\n' +
        '- `lib/repositories/workItemRepository.ts` (from 1.4.2) + `lib/repositories/projectRepository.ts` + `lib/repositories/workItemLinkRepository.ts` (from 1.4.3)\n' +
        '- `lib/dto/workItems.ts` + `lib/dto/workItemLinks.ts` + `lib/workItems/errors.ts` + `lib/workItems/linkErrors.ts` + `lib/workItems/positioning.ts`\n' +
        '- This Story page — service-method contract + ServiceContext shape + `isReady` spec',
    },
    {
      id: '1.4.5',
      title:
        'RLS policies for work_item + work_item_revision + work_item_link (workspace + project scope)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['1.4.2', '1.4.3'],
      descriptionMd:
        'Add Postgres Row-Level Security policies on `work_item`, ' +
        '`work_item_revision`, AND `work_item_link` matching the ' +
        'workspace-RLS pattern Story 1.2.3 + 1.3.2 established. Without the active ' +
        '`app.workspace_id` GUC, none of these tables can be read or written. ' +
        'Optional `app.project_id` GUC further narrows reads of ' +
        '`work_item` (when a route is project-scoped, the active project is set; ' +
        "when it's not, all projects in the workspace are visible). `work_item_link` " +
        'does NOT narrow by project — cross-project links are a v1 use case (see 1.4.3); the ' +
        'link table is workspace-scoped only.\n\n' +
        '**Why a project-scope GUC too:** a workspace can host many projects ' +
        "after multi-project lights up (the schema already supports it — Story 1.3's UI just " +
        'surfaces one). Workspace-only RLS would mean any signed-in member of workspace A can ' +
        "read every project's work items, including ones their role excludes them from in " +
        "future Epic 6 RBAC. Adding the project GUC NOW (even though v1's UI shows only one " +
        "project) is the durable shape — when Epic 6's permissions land, the GUC layer is " +
        'already in place. Anti-shortcut: a v1-only "workspace is good enough" RLS that Epic 6 ' +
        'has to rewrite.\n\n' +
        '**Policy shape:** `CREATE POLICY work_item_workspace ON ' +
        "work_item USING (workspace_id = current_setting('app.workspace_id', true)::text) WITH " +
        "CHECK (workspace_id = current_setting('app.workspace_id', true)::text);` The " +
        'project narrowing is a separate FOR SELECT-only policy when `app.project_id` ' +
        "is set: `USING (project_id = current_setting('app.project_id', true)::text OR " +
        "current_setting('app.project_id', true) = '')`. " +
        "`work_item_revision`'s policy joins to the work_item for the workspace " +
        'check — simpler and faster than denormalizing `workspace_id` onto the ' +
        'revision row. `work_item_link` carries denormalized `workspace_id` ' +
        "(from 1.4.3), so its RLS policy is the same shape as work_item's — direct comparison, " +
        'no join, fast lookup.\n\n' +
        "**What you'll do:** Add a raw-SQL Prisma migration " +
        '`work_item_rls` with `ALTER TABLE … ENABLE ROW LEVEL SECURITY` ' +
        'and the policy DDL. Extend `lib/db/withWorkspaceContext.ts` (from 1.2.3) so ' +
        "it optionally also sets `app.project_id` if the request's active project is " +
        'known. Update the middleware tests from 1.2.3 to cover the new tables. No ' +
        'application-layer code change beyond the optional project-context wiring.\n\n' +
        '## Acceptance criteria\n\n' +
        '- RLS enabled on `work_item`, `work_item_revision`, AND `work_item_link` via the `work_item_rls` migration.\n' +
        "- Workspace policy on all three tables: rows readable / writable only when `app.workspace_id` matches the row's (or, for revisions, the parent work_item's) `workspace_id`. Verified by a test that queries without GUC set and gets zero rows on each table.\n" +
        "- Project narrowing on `work_item`: when `app.project_id` is set, SELECTs return only that project's items; when unset (empty string), all workspace projects are visible. `work_item_link` intentionally does NOT narrow by project (cross-project links are supported).\n" +
        "- `work_item_revision` RLS joins to the parent work_item's workspace; revisions for cross-workspace tampering are unreadable.\n" +
        "- `work_item_link` RLS uses the denormalized `workspace_id` column directly (no join). The WITH CHECK clause rejects link inserts whose `workspace_id` doesn't match the active GUC.\n" +
        '- `withWorkspaceContext` helper optionally takes `projectId` and sets the GUC inside the transaction.\n' +
        "- Test fixture: User A in workspace W1, User B in workspace W2 — A cannot SELECT B's work items / revisions / links even with explicit IDs; A cannot INSERT into any of the three with W2's `workspace_id` (the WITH CHECK clause rejects).\n" +
        '- All quality gates green; existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/migrations/.../workspace_rls/migration.sql` from 1.2.3 — the exact policy pattern\n' +
        '- `prisma/migrations/.../project_rls/migration.sql` from 1.3.2 — the second instance of the pattern\n' +
        '- `lib/db/withWorkspaceContext.ts` — the GUC-setting transaction helper to extend\n' +
        '- Tests under `tests/integration/rls/` from 1.2.3 + 1.3.2 — the pattern these tests should extend\n' +
        '- This Story page — policy specification',
    },
    {
      id: '1.4.6',
      title: 'Revision history: WorkItemRevision table + repository + service integration',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.4.4'],
      descriptionMd:
        'Land the `WorkItemRevision` table + repository, and wire the service ' +
        "layer's create / update / archive methods to emit revision rows atomically (inside the " +
        "same transaction as the underlying mutation). The audit trail is what Epic 5's " +
        "activity feed consumes, what Epic 6's reporting reads, and what Epic 7's \"what changed " +
        'since last planning pass" diffing requires. Shipping it in 1.4 (vs. deferring to ' +
        'Epic 5) means no migration that retro-fills history — every write from the moment ' +
        'this Subtask lands is auditable.\n\n' +
        '**Schema:** `WorkItemRevision { id String @id @default(cuid()), ' +
        'workItemId String, changedById String, changedAt DateTime @default(now()), ' +
        "changeKind String /* 'created' | 'updated' | 'archived' */, diff Json }`. " +
        'Relations: `workItem WorkItem @relation(onDelete: Cascade)` + ' +
        '`changedBy User @relation(onDelete: Restrict)` (we want to keep history ' +
        'even if the user is deleted — but enforce that the writer existed at the time; ' +
        'user-soft-delete is the workaround if a user really needs to be removed). Indexes: ' +
        '`@@index([workItemId, changedAt])` for the activity-feed query; ' +
        '`@@index([workItemId])` for cascade.\n\n' +
        '**Diff shape:** JSON object ' +
        '`{ field: { from, to } }`. For `created`, `from` is ' +
        '`null` and `to` is the initial value. For `archived`, ' +
        '`{ archivedAt: { from: null, to: <timestamp> } }`. For ' +
        '`updated`, only changed fields appear.\n\n' +
        "**What you'll do:** Add `WorkItemRevision` to " +
        '`prisma/schema.prisma`; generate the migration ' +
        '`add_work_item_revisions`. Add ' +
        '`lib/repositories/workItemRevisionRepository.ts` with `create(data, ' +
        'tx)`, `listByWorkItem(workItemId, paginate)`. Update ' +
        '`workItemsService` to call the revision repo inside its transactions ' +
        "(createWorkItem → 'created'; updateWorkItem with diff → 'updated'; archiveWorkItem → " +
        "'archived'; moveWorkItem and assignWorkItem are forms of updateWorkItem so their " +
        'revisions flow through the same path). Add RLS policy on ' +
        "`work_item_revision` if 1.4.5 didn't already (it should have — coordinate).\n\n" +
        '## Acceptance criteria\n\n' +
        '- `WorkItemRevision` in `prisma/schema.prisma` with the verbatim fields + relations + indexes above. Migration `add_work_item_revisions` applies cleanly.\n' +
        '- `workItemRevisionRepository` exports `create(data, tx)` (required-`tx`) and `listByWorkItem(workItemId, { take, cursor })`.\n' +
        "- `workItemsService.createWorkItem` writes a 'created' revision in the same transaction as the work-item insert.\n" +
        "- `workItemsService.updateWorkItem` writes an 'updated' revision with the field diff. Diff only includes changed fields; identical field assignments are omitted.\n" +
        "- `workItemsService.archiveWorkItem` writes an 'archived' revision.\n" +
        '- Atomicity: an injected failure in the revision write rolls back the work-item write too. Test asserts this by mocking the revision repo to throw — both rows absent after.\n' +
        '- RLS verified: revisions for cross-workspace work items are unreadable (the policy joins to the parent work_item).\n' +
        "- Service-layer tests cover: revision-on-create has changeKind='created' + the full initial state; revision-on-update has only the changed fields; revision-on-archive has changeKind='archived'.\n" +
        '- All quality gates green; existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `lib/services/workItemsService.ts` (from 1.4.4) — the existing transactional skeleton this Subtask extends\n' +
        '- `lib/repositories/workItemRepository.ts` (from 1.4.2) — the repository pattern to mirror\n' +
        '- `prisma/migrations/.../work_item_rls/migration.sql` (from 1.4.5) — confirm the revisions RLS policy is in scope of that migration or add here\n' +
        '- This Story page — revision schema spec + diff shape',
    },
    {
      id: '1.4.7',
      title:
        'Integration tests: kind/depth/cycle triggers, concurrent key allocation, revision atomicity, link cycle + ready-set',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['1.4.4', '1.4.5', '1.4.6'],
      descriptionMd:
        'Comprehensive integration tests against a real Postgres covering the structural ' +
        "invariants. Per Yue's standing rule (and `feedback_planner_decides_user_approves`'s " +
        'no-mocks-on-DB principle), these tests exercise the actual Postgres triggers + RLS + ' +
        'service-layer transactions. They are the safety net Epic 2-7 will lean on every time ' +
        'they touch the work-item path; landing them in 1.4 means later Epics can confidently ' +
        'extend without fear of silently breaking the kind-parent rule.\n\n' +
        '**Test areas:**\n\n' +
        '- **Kind-parent matrix**: for every (parentKind, childKind) pair in ' +
        'the AC matrix, assert legal pairs succeed and illegal pairs reject with ' +
        '`IllegalParentTypeError`. Drive via `workItemsService.createWorkItem` ' +
        'AND via direct repo writes (proves the trigger fires regardless of path).\n' +
        '- **Depth limit**: build a 4-deep chain (epic → story → task → ' +
        'subtask). Asserts the 4-level legal max succeeds. Then attempt to create a child ' +
        'of the depth-4 subtask — rejects with `DepthLimitExceededError`.\n' +
        '- **Cycle prevention**: create A → B → C; attempt to re-parent A under ' +
        'C — rejects with `ParentCycleError`.\n' +
        '- **Concurrent key allocation**: fire 20 concurrent ' +
        '`createWorkItem` calls against the same project; assert the resulting ' +
        'keys are 1..20 (or contiguous from the starting count) with no duplicates and no ' +
        'lost slots beyond rolled-back transactions (none roll back here, so no gaps ' +
        'expected).\n' +
        '- **Workspace RLS isolation**: user A in workspace W1, user B in ' +
        "workspace W2. With W1's GUC set, B's items are invisible. With NO GUC set, all " +
        'tables return zero rows. `WITH CHECK`: A cannot insert a work item with ' +
        "W2's `workspace_id` (constraint rejection).\n" +
        "- **Project RLS narrowing**: with W1 + P1 set, P2's items " +
        'are invisible (even though both belong to W1). With W1 set and no project, both ' +
        "projects' items are visible.\n" +
        '- **Fractional indexing**: reorder via `moveWorkItem`; the ' +
        'resulting positions sort lexically as expected. Edge cases: ' +
        'move-to-start, move-to-end, move-between.\n' +
        '- **Revision atomicity**: inject a failure inside the revision-repo ' +
        'write; assert the work-item write rolls back too. Inject a failure in the ' +
        'work-item write; assert no revision row is left orphaned.\n' +
        '- **Revision diff correctness**: update only `title` → ' +
        'revision has `{ title: { from, to } }` and nothing else. Update ' +
        '`title` + `assigneeId` → both in the diff. No-op patch → no ' +
        'revision written, no transaction opened. Update `explanationMd` while ' +
        '`explanationSource = ai_draft` → diff includes **both** ' +
        '`explanationMd` AND the auto-transitioned ' +
        '`explanationSource: { from: ai_draft, to: user_edited }` (the source ' +
        'transition is itself an audit-worthy event).\n' +
        '- **Explanation-source state machine**: a fresh-row create with ' +
        '`explanationMd = NULL` has source `user_authored`. A subsequent ' +
        'update writing `explanationMd` + explicit source ' +
        '`ai_draft` (the path AI-drafting Epic 7 takes) sets source = ' +
        '`ai_draft`. A subsequent update patching only `explanationMd` ' +
        '(no explicit source in the patch) auto-transitions source to ' +
        '`user_edited` — verified by an integration test in 1.4.7. A subsequent ' +
        'update with explicit source `ai_draft` (a regenerate) resets the badge. ' +
        'Direct PATCH of `explanationSource` alone (no explanationMd) is allowed ' +
        '(e.g., user manually dismisses the AI-draft badge) — the diff records it.\n' +
        '- **Link cycle prevention**: A is_blocked_by B; attempt B is_blocked_by A → trigger rejects with `WorkItemLinkCycleError`. Deeper cycle: A→B→C→A; rejected on the closing edge. `relates_to` A↔B does NOT trigger cycle check (intended).\n' +
        '- **Self-link rejection**: linkWorkItems(A, A, *) rejects with `SelfLinkError`.\n' +
        '- **Cross-workspace link rejection**: A in W1, B in W2; linkWorkItems(A, B, *) rejects with `CrossWorkspaceLinkError` at the service layer, and the trigger backstops if the service is bypassed.\n' +
        "- **Symmetric `relates_to`**: linkWorkItems(A, B, 'relates_to') produces TWO rows (A→B and B→A); unlinkWorkItems on either deletes both.\n" +
        "- **Duplicate link rejection**: linkWorkItems(A, B, 'is_blocked_by') called twice — second call rejects with `DuplicateLinkError` (unique constraint).\n" +
        '- **Link revision audit**: linkWorkItems writes a revision row on the from item with the added link in the diff; unlinkWorkItems writes the removal.\n' +
        '- **Ready-set predicate**: A is_blocked_by B + C; `isReady(A)` returns false. Mark B done → still false (C blocks). Mark C done → returns true. Unlink C while B is still open → returns false again.\n' +
        '- **Cross-project links work**: A in project P1, B in project P2 (same workspace W1); linkWorkItems succeeds. `getBlockers(A)` returns B even when called under a P1-narrowed project context (link table is workspace-scoped, not project-scoped).\n\n' +
        "**What you'll do:** Add tests under " +
        '`tests/integration/work-items/`. Use the test-fixture helpers from 1.2.7 + ' +
        '1.3.5 that spin up users + workspaces + projects against the real Postgres. Add ' +
        '`workItemFixtures.ts` in tests/fixtures for repeatable work-item setups. ' +
        "Tests run against the same docker-compose'd Postgres as 1.2.7 / 1.3.5.\n\n" +
        '## Acceptance criteria\n\n' +
        '- New tests under `tests/integration/work-items/` cover every area enumerated above; every test names the invariant it protects in its describe-block.\n' +
        "- Tests run against the real Postgres (per Yue's no-mocks rule).\n" +
        '- Concurrent-key-allocation test uses `Promise.all` over 20 createWorkItem calls; resulting keys form a contiguous set.\n' +
        "- RLS tests reset the GUC between cases to avoid cross-test bleed; the test suite passes when run in parallel under Vitest's default concurrency.\n" +
        '- Revision-atomicity tests prove transactional rollback for both the work-item-fails and revision-fails directions.\n' +
        '- Test suite green; CI green; coverage report shows the workItemsService + workItemRepository + workItemLinkRepository + workItemRevisionRepository at >= 90%.\n' +
        '- All quality gates green; existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/projects/` and `tests/integration/workspaces/` — the integration-test pattern, fixture helpers\n' +
        '- `tests/fixtures/userFixtures.ts` / `workspaceFixtures.ts` / `projectFixtures.ts`\n' +
        '- `lib/services/workItemsService.ts` + repos + errors (the system under test)\n' +
        '- This Story page — the invariants the tests must protect',
    },
    {
      id: '1.4.8',
      title:
        'Story-level E2E: cross-project work-item isolation + dependency scenarios (closes the Story)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['1.4.5', '1.4.7'],
      descriptionMd:
        "The Story-closing E2E test that proves Story 1.4's structural invariants hold " +
        'end-to-end across realistic multi-workspace, multi-project scenarios. Same shape as ' +
        'Story 1.2.7 (workspace isolation) and Story 1.3.6 (project isolation) — a Playwright ' +
        '(or Vitest-driven HTTP) test that exercises the data layer via a thin throwaway test ' +
        "endpoint (since Epic 2 hasn't shipped the production routes yet). The test endpoint " +
        'lives under `app/api/_test/work-items/` and is gated by a build-time ' +
        "`NODE_ENV !== 'production'` flag.\n\n" +
        '**Scenario:** User A in workspace W1 with projects P1 + P2; User B in ' +
        'workspace W2 with project P3. Each creates 3 work items in each of their projects. ' +
        'Then:\n\n' +
        "- A queries P1's list — sees exactly 3 items.\n" +
        "- A queries P2's list — sees exactly 3 items.\n" +
        '- A tries to query P3 by ID — gets 404 (NOT 403 — leaking existence is the bug 1.2.7 caught).\n' +
        "- A tries to update one of B's items by ID — 404.\n" +
        "- A tries to create a work item with P3's projectId — server rejects with NotInSameProjectError before the DB even sees it (service-layer assertion); if A could bypass the service, the RLS WITH CHECK clause would also reject.\n" +
        '- A creates an epic in P1, adds a story under it, adds a subtask under the story (3-level chain). Verifies the subtree query returns the full tree.\n' +
        '- A archives the epic — children remain visible at top level (Linear-shape choice from 1.4.4 documented).\n' +
        "- A's revision feed for an updated item shows the changes; B cannot read those revisions.\n" +
        '- **Dependency scenario:** A creates issues X, Y, Z in P1. Links X is_blocked_by Y; links X is_blocked_by Z. `getBlockers(X)` returns [Y, Z]; `getBlocking(Y)` returns [X]; `isReady(X)` returns false. Marks Y status=done; isReady(X) still false. Marks Z status=done; isReady(X) returns true. Unlinks X→Y (the link, not the item); isReady(X) stays true (only Z remained, already done).\n' +
        '- **Cross-project dependency scenario:** A creates issue X in P1 and Y in P2 (same workspace W1). Links X is_blocked_by Y — succeeds. getBlockers(X) returns Y even when called under P1 project-context. B cannot see the link at all (cross-workspace gate).\n' +
        '- **Link cycle prevention E2E:** A creates X is_blocked_by Y; attempts Y is_blocked_by X via the HTTP endpoint — gets a 4xx with WI_LINK_CYCLE in the error body.\n' +
        '- **Symmetric link UI contract:** A links X relates_to Y; from the issue-detail GET on both X and Y, the "Related issues" field surfaces the counterpart (one logical link, two row writes, both endpoints render symmetrically).\n' +
        '- **Explanation-source state machine E2E:** create an issue via POST (no explanation); GET confirms `explanationMd = null`, `explanationSource = user_authored`. PATCH with `{ explanationMd: "…", explanationSource: "ai_draft" }` (simulating what Epic 7\'s AI-drafting endpoint will do); GET confirms both. PATCH with `{ explanationMd: "…edited" }` (no explicit source); GET confirms source auto-transitioned to `user_edited`. Revision feed shows three rows in order with the right diffs (including the source transition on the third update).\n' +
        '- **Markdown rendering smoke:** create an issue with `descriptionMd` containing a fenced code block, a GFM table, and an inline `<script>` tag. GET-with-render returns sanitized HTML — script stripped, table rendered, code block with syntax-highlighting markup.\n\n' +
        "**What you'll do:** Add the test endpoint " +
        '`app/api/_test/work-items/route.ts` (POST = createWorkItem, GET = list/get, ' +
        'PATCH = update, DELETE = archive) AND `app/api/_test/work-item-links/route.ts` ' +
        '(POST = linkWorkItems, DELETE = unlinkWorkItems, GET with `?workItemId=&direction=blockers|blocking` ' +
        'wraps getBlockers / getBlocking; GET with `?workItemId=&ready=1` wraps ' +
        'isReady). Wire both through the service layer (NOT raw Prisma) so the tests exercise ' +
        'the production code path. Add the Playwright test ' +
        '`tests/e2e/work-items-isolation.spec.ts` following the 1.2.7 / 1.3.6 ' +
        "pattern. CI runs E2E against the docker-compose'd Postgres + a built Next server.\n\n" +
        '## Acceptance criteria\n\n' +
        "- Test endpoints `app/api/_test/work-items/route.ts` AND `app/api/_test/work-item-links/route.ts` expose CRUD + linking via the service layer; both gated behind `NODE_ENV !== 'production'` (return 404 in production builds).\n" +
        '- E2E spec `tests/e2e/work-items-isolation.spec.ts` covers every bullet from the scenario list above, including the dependency / cross-project link / cycle scenarios.\n' +
        '- Cross-workspace queries return 404 (not 403), preserving the "no existence leak" contract from 1.2.7.\n' +
        '- Cross-project queries within the same workspace return 404 too (project RLS narrowing).\n' +
        '- The Story-level verification recipe (below) reproduces the scenario locally in <10 minutes.\n' +
        '- All quality gates green; CI green; existing E2E suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/workspaces-isolation.spec.ts` from 1.2.7 — the exact pattern\n' +
        '- `tests/e2e/projects-isolation.spec.ts` from 1.3.6 — the second pattern instance\n' +
        '- `app/api/_test/*` existing test endpoints from 1.2.7 / 1.3.6 — the gating convention\n' +
        '- `lib/services/workItemsService.ts` — the service the route delegates to\n' +
        '- This Story page — the scenario specification',
    },
  ],
};
