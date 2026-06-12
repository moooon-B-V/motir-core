import type { PlanStory } from '../types';

/**
 * Story 7.6 — Prompt generation + external-agent dispatch. The story that
 * turns a READY work item into a high-quality, context-injected prompt and
 * hands it to a coding/copy/design agent to actually do the work. This is the
 * payoff of the whole AI layer: 7.0 shipped the dispatch SURFACE (the ready
 * set + the `/api/ready/next` contract), 7.5 built the shared-context
 * RETRIEVAL (plan-tree graph traversal + the code graph), and 7.6 fuses them —
 * per-type prompt generation that INJECTS 7.5's retrieved context (the
 * prompt-quality moat) and a dispatch payload carrying the git-workflow
 * variant the agent must follow.
 *
 * **Where the seam sits (the open-core split, restated for this story).**
 * - **Prompt GENERATION lives in motir-ai.** It is a `generate_prompt` job
 *   (a new `jobKind` registered against the 7.1.4 handler registry,
 *   replacing 7.1.7's `noop`), because the moat is the CONTEXT it injects:
 *   it calls the 7.5 plan-tree + code-graph tools mid-job (7.5.6's two-graph
 *   planning loop) to assemble a prompt the agent could never write itself
 *   from the bare issue. A prompt with no retrieved context is just the
 *   `descriptionMd` 7.0 already returns — the value is the injection.
 * - **The dispatch SURFACE lives in motir-core.** The prompt is displayed,
 *   copied, and (today) hand-carried to a BYOK agent through motir-core's
 *   `/ready` surface (7.0) — the AI never writes the tree, and the agent runs
 *   on the user's machine, calling motir-core over HTTP. 7.6 grows 7.0's
 *   read-only `/api/ready/next` payload from "the references" into "the
 *   full generated prompt + the git-workflow variant", exactly the
 *   shared-context-injection half that 7.0 deferred to "stub 7.6".
 *
 * **THE DISPATCH PAYLOAD (the durable contract, the future-native-AI seam).**
 * The payload a dispatched item carries is the extension point the future
 * native AI-coding executor plugs into behind the SAME shape (MOTIR.md §
 * What Motir is — "a future native AI-coding executor plugs in behind the same
 * dispatch shape"). It carries:
 *   - the **generated prompt** (per-type, context-injected — from the
 *     `generate_prompt` job);
 *   - **`targetRepo`** — which repo the agent should clone/work in (a project
 *     can map to a repo; existing-project migration already has one,
 *     start-fresh gets one after the first dispatch produces code);
 *   - an **inherited `sessionBranch`** — the branch a multi-item "auto" run
 *     accumulates work onto (see the git-workflow variants below);
 *   - the **GIT WORKFLOW block** — a dispatch-time template parameter, NOT a
 *     hardcoded convention, because the right workflow differs by how the
 *     human is driving the agent.
 *
 * **THE GIT WORKFLOW BLOCK — two variants, auto-merge-to-main REJECTED.**
 * AI coding agents reliably follow git instructions only when they are spelled
 * out explicitly in the prompt (branch naming + commit format + PR
 * requirement) — verified convention, the rung-1 mirror for the prompt shape
 * (see the per-subtask Context refs). Motir templates TWO variants and the
 * dispatch picks one; a third — auto-merge straight to `main` — was
 * **considered and REJECTED** (it removes the human review gate Principle #3
 * and the CLAUDE.md "manual merge mode" rule both require; the AI proposes,
 * the human approves — always):
 *   1. **per-item PR** (for `next` / `batch` dispatch — the default, and the
 *      BYOK `motir run` flow): the agent cuts `feat/PROD-<key>-<slug>`, does
 *      the one item, opens a PR targeting `main` (or the session branch),
 *      stops. One reviewable unit per item — the safe, legible default.
 *   2. **session-branch** (for an `auto` run draining a slice of the ready
 *      set): every item in the run commits onto ONE inherited `sessionBranch`,
 *      and a single PR collects the slice. Avoids a PR-per-leaf storm when an
 *      agent runs many small subtasks back-to-back; the human still reviews
 *      one PR before anything reaches `main`.
 * Both end at a PR a human merges — never an auto-merge.
 *
 * **Per-type prompt generation (coding / copy / design / …).** The mirror
 * (Atlassian Rovo Dev, the verified rung-1) produces *different* outputs per
 * work type from a story — "implementation that aligns to your code plans —
 * refactoring, new tests and docs included" — i.e. the same Code-Planner agent
 * emits code, tests, AND docs work shaped to each. Motir mirrors that: the
 * `generate_prompt` job branches on the work item's `type` (the plan card type
 * 7.0/7.1 already carry — code / test / design / content / decision / manual)
 * and assembles the canonical prompt for THAT type — a `code` subtask's prompt
 * leads with the 4-layer contract + the code-graph neighborhood; a `design`
 * subtask's prompt leads with the design-gate + the `--el-*`/shape tokens; a
 * `content`/copy prompt leads with the i18n + tone refs. One job, a per-type
 * template registry, shared context-injection.
 *
 * **What 7.6 is NOT.** It is not the GitHub round-trip — actually cutting the
 * branch, opening the PR, and syncing the PR's status back to the issue is
 * **7.7** (GitHub App + status sync), which builds ON 7.6's dispatch→PR loop.
 * 7.6 GENERATES the prompt + the git-workflow instructions and DISPLAYS/COPIES
 * them; 7.7 is what makes the loop close automatically. 7.6 is also not a
 * native in-app agent runner — the agent still runs BYOK on the user's
 * machine; native execution is the designed-for extension beyond the planned
 * epics, and it reuses THIS payload.
 *
 * **Dependency posture (audited clean — backward/sideways only).** Prompt
 * generation depends on 7.5.6 (the two-graph planning loop it injects context
 * through — the only way the moat exists). The dispatch surface rides the DONE
 * 7.0 ready set (`status: done`, every dep satisfied) + the 7.6 prompt job.
 * No forward-pointing dep: 7.7's GitHub loop depends on 7.6, never the reverse.
 * The design gate fires (the dispatch/prompt view is a real UI surface), so
 * 7.6.1 comes first under `design/dispatch/` and every UI code subtask blocks
 * on it.
 */
export const story_7_6: PlanStory = {
  id: '7.6',
  title: 'Prompt generation + external-agent dispatch',
  status: 'planned',
  gitBranch: 'feat/PROD-7.6-prompt-dispatch',
  descriptionMd:
    'Turn a READY work item into a high-quality, context-injected PROMPT and ' +
    'hand it to an external coding/copy/design agent — the payoff of the AI ' +
    'layer. 7.0 shipped the dispatch SURFACE (the `/ready` page + the ' +
    '`/api/ready/next` contract that returns `contextRefs` but NOT the ' +
    'injected prompt); 7.5 shipped the shared-context RETRIEVAL (plan-tree ' +
    'graph traversal + the code graph). **7.6 fuses them**: per-type prompt ' +
    'generation that INJECTS 7.5-retrieved context (the prompt-quality moat) ' +
    'plus a dispatch payload carrying the git-workflow variant the agent must ' +
    'follow.\n\n' +
    '**The seam (open-core split):**\n\n' +
    '- **Prompt GENERATION is a `generate_prompt` job in motir-ai** — a new ' +
    '`jobKind` on the 7.1.4 handler registry. It branches on the work item ' +
    "`type` (code / test / design / content / …) and calls 7.5's two-graph " +
    'tools mid-job to assemble the canonical per-type prompt with the ' +
    'plan-tree neighborhood + code-graph context injected. (A prompt with no ' +
    'injected context is just the `descriptionMd` 7.0 already returns — the ' +
    'injection IS the value.)\n' +
    '- **The dispatch SURFACE is in motir-core** — the prompt is displayed, ' +
    'copied, and hand-carried to a BYOK agent through the `/ready` surface. ' +
    '7.6 grows 7.0\'s read-only `/api/ready/next` payload from "the ' +
    'references" into "the full generated prompt + the git-workflow ' +
    'variant" — the context-injection half 7.0 explicitly deferred to ' +
    '"stub 7.6".\n\n' +
    '**The dispatch payload (the durable contract + the future-native-AI ' +
    'seam).** The payload carries the **generated prompt**, **`targetRepo`** ' +
    '(which repo the agent works in), an inherited **`sessionBranch`** (for ' +
    'multi-item runs), and the **GIT WORKFLOW block** (a dispatch-time ' +
    'template param with TWO variants — per-item PR / session-branch; ' +
    'auto-merge-to-main REJECTED). This is the SAME shape a future native ' +
    'AI-coding executor plugs into (MOTIR.md § What Motir is).\n\n' +
    '**The git-workflow variants (auto-merge-to-main REJECTED):**\n\n' +
    '- **per-item PR** (`next` / `batch` — default + the BYOK `motir run` ' +
    'flow): the agent cuts `feat/PROD-<key>-<slug>`, does the one item, opens ' +
    'a PR targeting `main`, stops. One reviewable unit per item.\n' +
    '- **session-branch** (`auto` — draining a ready-set slice): every item ' +
    'in the run commits onto ONE inherited `sessionBranch`; a single PR ' +
    'collects the slice (no PR-per-leaf storm).\n' +
    '- Both end at a PR a HUMAN merges. Auto-merge straight to `main` was ' +
    'considered and rejected — it removes the review gate Principle #3 + the ' +
    'CLAUDE.md "manual merge mode" rule require.\n\n' +
    '**Scope:** the dispatch/prompt design surface (7.6.1); the per-type ' +
    '`generate_prompt` job with context injection (7.6.2); the dispatch ' +
    'payload contract + the git-workflow template variants (7.6.3); the ' +
    'dispatch surface UI riding the DONE 7.0 ready set (7.6.4); vitest ' +
    '(7.6.5); the e2e (7.6.6).\n\n' +
    '**Out of scope (named so they land in their owning stories):** actually ' +
    'cutting the branch / opening the PR / syncing PR status back to the ' +
    'issue — that is **7.7** (GitHub App + status sync), which builds ON ' +
    "7.6's dispatch→PR loop. 7.6 GENERATES + DISPLAYS the prompt + the " +
    'git-workflow instructions; 7.7 closes the loop. Also out of scope: the ' +
    'NATIVE in-app agent runner (the agent still runs BYOK on the ' +
    "user's machine; native execution is the designed-for extension that " +
    'reuses THIS payload).',
  verificationRecipeMd:
    '- Pull the Story branch; with both services running locally (motir-ai ' +
    'on its dev port, motir-core on `:3000`, each pointed at the other), ' +
    '`pnpm install`, `pnpm prisma generate`, `pnpm db:seed`, `pnpm dev`.\n' +
    '- **The prompt-generation smoke (the moat).** Open `/ready`, pick a ' +
    'ready `code` subtask, click **Generate prompt** → a `generate_prompt` ' +
    'job runs in motir-ai and streams back a prompt that (a) leads with the ' +
    '4-layer contract, (b) names real files from the code graph (the ' +
    '7.5-injected neighborhood, not just the issue body), and (c) carries an ' +
    'explicit GIT WORKFLOW block. Pick a `design` subtask → the prompt ' +
    'instead leads with the design-gate + `--el-*`/shape-token refs. Same ' +
    'job, per-type template — confirm the two prompts differ by type.\n' +
    '- **The git-workflow variant.** With the variant selector on ' +
    '**per-item PR**, the prompt instructs the agent to cut ' +
    '`feat/PROD-<key>-<slug>` and open a PR to `main`. Switch to ' +
    '**session-branch** → the prompt instead instructs committing onto the ' +
    'inherited `sessionBranch`. Confirm NEITHER variant ever says "merge to ' +
    'main" / "auto-merge" (the rejected third variant).\n' +
    '- **The payload contract.** `POST /api/ready/next` (or the dispatch ' +
    'endpoint) returns a payload carrying `prompt`, `targetRepo`, ' +
    '`sessionBranch`, and the resolved git-workflow block; `excludeIds` still ' +
    'walks the set (the 7.0 contract is preserved, not broken).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.6.5 covers per-type ' +
    'prompt assembly, context injection present, and BOTH payload variants.\n' +
    '- `pnpm test:e2e` — 7.6.6 drives pick-ready → generate → copy-with-variant.\n' +
    '- **Open-core check (this Epic’s recurring posture).** Confirm the ' +
    'dispatch surface + payload live entirely in motir-core; prompt ' +
    'generation lives in motir-ai; no `motir-ai` import sneaks into ' +
    'motir-core (the call is over the 7.1 boundary only). The AI never writes ' +
    'the tree; every git-workflow variant ends at a human-merged PR.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.6.1',
      title:
        'Design — the dispatch/prompt surface (generated-prompt view + git-workflow variant selector + per-type)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The dispatch surface is real UI; every ' +
        'UI-touching subtask in this Story (7.6.4) depends on this one, so it ' +
        'comes FIRST — without it the prompt view would be improvised, which ' +
        'is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **dispatch / prompt** surface under ' +
        '`motir-core/design/dispatch/`. Author it as a **`*.mock.html` ' +
        'mockup** built from the real design system (the `components/ui/*` ' +
        'primitives + the `--el-*` tokens + the `[data-display-style]` shape ' +
        'tokens) — NOT a `.pen` (the coding-agent-produced-design route, ' +
        'MOTIR.md § Design-reference rule). Render a PNG export if useful, ' +
        'but the `.mock.html` is the source of truth.\n\n' +
        '**Surfaces to draw** (multi-panel board — EVERY panel, the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the generated-prompt view.** Reached from a ready row ' +
        '(7.0’s `/ready` list) via a **Generate prompt** action. While ' +
        'the `generate_prompt` job runs, a streaming/progress state (reuse ' +
        'the job-stream pattern). On completion: the full prompt in a ' +
        'monospace, scrollable, read-only block (an `--el-surface-soft` panel, ' +
        '`--radius-card`), with a prominent **Copy prompt** icon-button ' +
        '(its own `--el-*` tooltip-on-hover state) and a small "regenerate" ' +
        'affordance. Show the prompt clearly SECTIONED (context / task / ' +
        'acceptance criteria / git workflow) so a human can eyeball that the ' +
        'injected context landed.\n' +
        '- **Panel 2 — the GIT WORKFLOW variant selector.** A segmented ' +
        'control / radio group (compose the shipped control primitive) with ' +
        'the TWO variants: **Per-item PR** (default) and **Session branch**, ' +
        'each with a one-line explainer of what the agent will do. Draw the ' +
        'selected state changing the GIT WORKFLOW section of the Panel-1 ' +
        'prompt live. There is NO third "auto-merge" option (it was ' +
        'rejected) — do not draw one.\n' +
        '- **Panel 3 — per-type prompt variation.** Show the prompt header ' +
        'differing by work-item type: a `code` subtask (leads with the ' +
        '4-layer contract + code-graph file refs), a `design` subtask (leads ' +
        'with the design-gate + token refs), a `content`/copy subtask (leads ' +
        'with i18n + tone refs). A small type-pill (the `IssueTypeIcon` hue ' +
        'via `--el-type-*`) labels each. This communicates the per-type ' +
        'template registry to the 7.6.2/7.6.4 implementers.\n' +
        '- **Panel 4 — the `targetRepo` + `sessionBranch` affordance + ' +
        'copy-confirmation toast.** Where the dispatch shows which repo the ' +
        'agent works in and (for a session-branch run) the inherited branch ' +
        'name; plus the small confirmation toast on Copy ("Copied. Paste ' +
        'this into your agent.") reusing the shipped toast primitive (mirror ' +
        '7.0.1 Panel 4).\n\n' +
        'Also write **`design/dispatch/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings (incl. each ' +
        "variant's explainer and the toast), the placement decisions, the " +
        'per-`--el-*` colour role for each element, and a "primitives ' +
        'composed (no hand-rolling)" checklist (the `design-notes.md` ' +
        'convention 1.3.3 / 1.5.1).\n\n' +
        '**Mirror (rung-1, VERIFIED).** Atlassian Rovo Dev surfaces a code ' +
        'PLAN from a work item (subtasks + acceptance criteria + suggested ' +
        'file changes) inside Jira / the IDE / the terminal; it produces ' +
        'per-type output (code, tests, docs). Motir’s dispatch view is ' +
        'the analog but explicitly EXPOSES the generated prompt + the ' +
        'git-workflow choice to the human (BYOK), where Rovo Dev keeps the ' +
        'prompt internal — a justified deviation (Motir is BYOK-first, the ' +
        'prompt IS the handoff artifact). Cite Rovo Dev as the mirror; record ' +
        'the deviation in design-notes.\n\n' +
        '**Branch.** `design/PROD-7.6.1-dispatch-surface`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md § ' +
        'Plan seed Workflow) — this PR only edits `design/dispatch/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/dispatch/dispatch.mock.html` exists, renders ' +
        'the four panels above side-by-side, and references ONLY `--el-*` ' +
        'colour tokens + `[data-display-style]` shape tokens (no Tier-0 ' +
        '`--color-*`, no hand-rolled radius/spacing — the `motir-core/' +
        'CLAUDE.md` colour/shape rules).\n' +
        '- The GIT WORKFLOW selector shows exactly TWO variants (per-item PR, ' +
        'session-branch); NO auto-merge option is drawn.\n' +
        '- Panel 3 shows the per-type prompt-header variation for at least ' +
        'code / design / content.\n' +
        '- `motir-core/design/dispatch/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` ' +
        'role, and records the Rovo-Dev mirror + the BYOK deviation.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`IssueTypeIcon`, `Button`, the segmented-control + toast primitives, ' +
        'etc.) — no new design-system entries invented inside this Story (if ' +
        'one would be needed, that is a NEW `design/` subtask, not a code ' +
        'workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ready/` — the closest existing area (7.0.1); ' +
        'mirror its layout + `design-notes.md` shape, and the dispatch view ' +
        'launches FROM the `/ready` row it designed.\n' +
        '- `motir-core/components/ui/Pill.tsx`, ' +
        '`motir-core/components/issues/IssueTypeIcon.tsx` — the type-pill / ' +
        'per-kind hue for Panel 3.\n' +
        '- `motir-core/components/ui/` — the segmented-control + toast ' +
        'primitives to compose for Panel 2 / Panel 4.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup must ' +
        'reference).\n' +
        '- Atlassian Rovo Dev (the verified rung-1 mirror: story→' +
        'subtasks + suggested file changes + per-type output) — cited in ' +
        'design-notes as the mirror, with the BYOK deviation recorded.',
      dependsOn: [],
    },
    {
      id: '7.6.2',
      title: '`generate_prompt` job (motir-ai) — per-type, context-injected prompt assembly',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Implement the **`generate_prompt`** job handler in motir-ai (a new ' +
        '`jobKind` registered against the 7.1.4 handler registry, replacing ' +
        "7.1.7's `noop` for this kind). This is the prompt-quality MOAT: it " +
        'produces a prompt the agent could never write from the bare issue, ' +
        'because it INJECTS 7.5-retrieved context.\n\n' +
        '**Input (job request envelope, per 7.1.1).** The target work-item ' +
        'key + its `type` + the active `AiProject`/tenant + the requesting ' +
        'user (the job-scoped read-back token from 7.1.5). NO prompt text is ' +
        'passed in — the job ASSEMBLES it.\n\n' +
        '**Algorithm.**\n\n' +
        '1. **Read the item** through the 7.1.6 read-back + 7.5.1 graph ' +
        'tools: `get_item(withComments, history)` for the full issue + its ' +
        'comments/decisions, `get_subtree`/`walk_blocking` for its place in ' +
        'the plan (parent story intent, sibling context, what it is blocked ' +
        'by). This is the plan-tree HALF of the injection.\n' +
        '2. **Retrieve code context** through the 7.5.5 code-graph tools ' +
        '(search / explore / callers / impact): the files + symbols the item ' +
        'most likely touches — the "suggested file changes" the mirror ' +
        '(Rovo Dev) surfaces. This is the code-graph HALF. (For a start-fresh ' +
        'project with no code yet, this half is empty and the prompt says so ' +
        '— do not fabricate file refs.)\n' +
        '3. **Branch on the work-item `type`** and select the per-type ' +
        'TEMPLATE from a registry (`code` / `test` / `design` / `content` / ' +
        '`decision` / `manual`):\n' +
        '   - **`code`** — leads with the 4-layer contract ' +
        '(Route→Service→Repository→Prisma), the ' +
        '`--el-*`/shape rules, the code-graph neighborhood, "tests use real ' +
        'Postgres", and "run `pnpm test` + `pnpm lint` + `pnpm format:check` ' +
        'before opening the PR".\n' +
        '   - **`design`** — leads with the design-gate (produce a ' +
        '`*.mock.html` + `design-notes.md` under `design/<area>/`, compose ' +
        'shipped primitives, `--el-*` + shape tokens only).\n' +
        '   - **`content`/copy** — leads with the i18n namespace conventions ' +
        '+ the locale set + the tone/register refs.\n' +
        '   - **`test`** — leads with the real-Postgres rule + the ' +
        'per-file coverage gate.\n' +
        '   - **`manual`/`decision`** — a human-oriented brief (no PR ' +
        'expectation), not an agent prompt.\n' +
        '4. **Assemble the canonical prompt** in the five-element shape the ' +
        'AI-coding-agent convention rewards (verified mirror): ' +
        '**context** (the injected plan-tree + code-graph) → **task** ' +
        '(the item’s `descriptionMd`) → **constraints** (the ' +
        'per-type rules above) → **acceptance criteria** (lifted from ' +
        "the item's `## Acceptance criteria`) → a **GIT WORKFLOW** " +
        'PLACEHOLDER (the actual block is filled at dispatch by 7.6.3 from the ' +
        'chosen variant + `targetRepo`/`sessionBranch` — the job emits the ' +
        'context-rich body, the dispatch param-fills the git block).\n' +
        '5. **Stream** assembly progress over the 7.1.4 job stream; return ' +
        'the assembled prompt as the job result (the structured ' +
        '`{ promptMd, type, contextRefs, codeRefs }` shape motir-core ' +
        'consumes).\n\n' +
        'Lightly layer it on the motir-ai side (its own Prisma from 7.1.3): a ' +
        'handler module + a per-type template registry + the ' +
        'context-injection helper that wraps the 7.5 tools. The job reuses ' +
        "7.5.6's two-graph planning loop wiring — it does NOT re-implement " +
        'graph access.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `generate_prompt` handler is registered on the 7.1.4 registry; ' +
        'submitting the job for a real ready item returns a prompt result, ' +
        'streaming progress to terminal.\n' +
        '- The prompt INJECTS plan-tree context (parent intent + ' +
        'comments/decisions via 7.5.1) AND code-graph context (likely files/' +
        'symbols via 7.5.5) — verified: the prompt names real items/files ' +
        'beyond the bare `descriptionMd`. For a code-less project the ' +
        'code half is honestly empty, not fabricated.\n' +
        '- The per-type template registry produces a DIFFERENT leading ' +
        'section for at least `code` vs `design` vs `content` (asserted in ' +
        '7.6.5).\n' +
        '- The prompt follows the five-element shape (context / task / ' +
        'constraints / acceptance criteria / GIT WORKFLOW placeholder); the ' +
        'GIT WORKFLOW is a PLACEHOLDER the dispatch (7.6.3) fills, not ' +
        'hardcoded in the job.\n' +
        '- The handler reads ONLY via the 7.1.6/7.5 tools (no direct ' +
        'motir-core DB access); it carries the job-scoped token so every read ' +
        'is permission-checked as the requesting user.\n\n' +
        '## Context refs\n\n' +
        '- 7.5.6 — the two-graph planning loop (plan-tree + code-graph tools ' +
        'mid-job) this job injects context through.\n' +
        '- 7.5.1 (`get_item`/`get_subtree`/`walk_blocking`) + 7.5.5 (code-' +
        'graph search/explore/callers/impact) — the retrieval tools.\n' +
        '- 7.1.4 (the `jobKind` handler registry + job stream), 7.1.6 (the ' +
        'read-back), 7.1.1 (the request/result envelope).\n' +
        '- `motir-core/CLAUDE.md` — the 4-layer + `--el-*`/shape + ' +
        'real-Postgres + coverage rules the `code`/`test`/`design` templates ' +
        'embed into the prompt.\n' +
        '- AI-coding-agent prompt convention (the verified five-element ' +
        'framework: context / task / constraints / edge cases / acceptance ' +
        'criteria) + Atlassian Rovo Dev’s per-type / suggested-file-' +
        'changes plan as the mirror.',
      dependsOn: ['7.5.6'],
    },
    {
      id: '7.6.3',
      title:
        'Dispatch payload contract — `targetRepo` + inherited `sessionBranch` + the GIT WORKFLOW template variants',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Build the motir-core DISPATCH PAYLOAD — the durable contract a ' +
        'dispatched item carries, and the seam the future native AI-coding ' +
        'executor plugs into behind the SAME shape (MOTIR.md § What Motir ' +
        'is). This GROWS 7.0’s read-only `ReadyItemDispatchDto`: 7.0 ' +
        'returned `descriptionMd` + `contextRefs` (the references); 7.6 adds ' +
        'the generated prompt (from 7.6.2) + the git-workflow block + ' +
        '`targetRepo`/`sessionBranch`.\n\n' +
        '**The payload shape (extend, do not fork, the 7.0 DTO):**\n\n' +
        '```ts\n' +
        '// lib/dto/dispatch.ts (NEW) — extends ReadyItemDispatchDto (7.0.3)\n' +
        'export type GitWorkflowVariant = "per_item_pr" | "session_branch";\n\n' +
        'export interface DispatchPayloadDto extends ReadyItemDispatchDto {\n' +
        '  prompt: string;                    // the 7.6.2 generated prompt body\n' +
        '  promptType: string;                // the work-item type it was built for\n' +
        '  targetRepo: string;                // owner/name the agent works in\n' +
        '  sessionBranch: string | null;      // inherited branch for an auto run; null for per-item\n' +
        '  gitWorkflow: string;               // the rendered GIT WORKFLOW block\n' +
        '  gitWorkflowVariant: GitWorkflowVariant;\n' +
        '}\n' +
        '```\n\n' +
        '**The GIT WORKFLOW template — TWO variants, auto-merge-to-main ' +
        'REJECTED.** AI agents reliably follow git instructions only when ' +
        'spelled out explicitly (branch naming + commit format + PR ' +
        'requirement) — the verified rung-1 convention. A small ' +
        '`lib/dispatch/gitWorkflow.ts` renders the GIT WORKFLOW block from ' +
        'the variant + `targetRepo` + the item key, filling the placeholder ' +
        'the 7.6.2 prompt left:\n' +
        '- **`per_item_pr`** (default; the `next`/`batch`/BYOK `motir run` ' +
        'flow): instruct the agent to cut `feat/PROD-<key>-<slug>` off ' +
        '`main`, do the ONE item, open a PR targeting `main`, stop. ' +
        '`sessionBranch` is `null`.\n' +
        '- **`session_branch`** (the `auto` run draining a ready-set slice): ' +
        'instruct the agent to commit onto the inherited `sessionBranch` ' +
        '(NOT cut a new branch); the run’s single PR collects the slice. ' +
        'The `sessionBranch` is inherited from the run, not minted per item.\n' +
        '- **REJECTED — auto-merge to `main`.** Neither variant ever ' +
        'instructs a merge; both end at a PR a human merges (Principle #3 + ' +
        'the CLAUDE.md "manual merge mode" rule). A unit test asserts the ' +
        'rendered block for both variants contains NO "merge"/"auto-merge" ' +
        'instruction to `main`.\n\n' +
        '**`targetRepo` resolution.** A project maps to a repo: ' +
        'existing-project migration already has one; a start-fresh project ' +
        'gets one after its first dispatch produces code. Resolve it from the ' +
        'project settings (the field 7.7’s GitHub install will populate; ' +
        'until then it is a configured value / a clear "no repo connected ' +
        'yet" state — surface it, do not crash). 7.6 only READS + carries ' +
        'it; 7.7 owns the install that sets it.\n\n' +
        '**4-layer.** A `dispatchService.buildDispatchPayload(projectId, ' +
        'itemKey, { variant, sessionBranch }, ctx)` orchestrates: resolve the ' +
        'item via `workItemsService`, submit + await the 7.6.2 ' +
        '`generate_prompt` job via the 7.1.5 client, render the git-workflow ' +
        'block, map to `DispatchPayloadDto`. Wired into the existing ' +
        '`POST /api/ready/next` route (extend its body to accept ' +
        '`{ gitWorkflowVariant?, sessionBranch? }`, defaulting to ' +
        '`per_item_pr`) so the BYOK contract stays ONE endpoint — the 7.0 ' +
        '`excludeIds`/sort/cursor behavior is preserved, not broken. No ' +
        'Prisma in the route; mappers are pure.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `DispatchPayloadDto` extends the 7.0 `ReadyItemDispatchDto` and ' +
        'adds `prompt`, `promptType`, `targetRepo`, `sessionBranch`, ' +
        '`gitWorkflow`, `gitWorkflowVariant`.\n' +
        '- The GIT WORKFLOW renderer produces the `per_item_pr` block (cut ' +
        '`feat/PROD-<key>-<slug>`, PR to `main`, stop) and the ' +
        '`session_branch` block (commit onto the inherited branch) — and ' +
        'NEITHER instructs an auto-merge to `main` (asserted).\n' +
        '- `per_item_pr` yields `sessionBranch: null`; `session_branch` ' +
        'carries the inherited branch through unchanged.\n' +
        '- `targetRepo` resolves from project settings; a project with no ' +
        'connected repo yields a clear "not connected" payload state, not a ' +
        'crash.\n' +
        '- `POST /api/ready/next` accepts the new optional body fields, ' +
        'defaults to `per_item_pr`, and STILL honors `excludeIds` + the 7.0 ' +
        'sort/cursor (the 7.0 contract is preserved).\n' +
        '- 4-layer holds: route → dispatch service → ' +
        'workItemsService + 7.1.5 client + the git-workflow renderer; no ' +
        'Prisma in the route, pure mappers.\n\n' +
        '## Context refs\n\n' +
        '- 7.6.2 — the `generate_prompt` job whose result this payload ' +
        'carries (the GIT WORKFLOW placeholder it fills).\n' +
        '- `motir-core/lib/dto/ready.ts` + `lib/mappers/readyMappers.ts` ' +
        '(7.0.3) — the `ReadyItemDispatchDto` this extends.\n' +
        '- `motir-core/app/api/ready/next/route.ts` (7.0.5) — the endpoint ' +
        'this extends (ONE BYOK contract, body grows optional fields).\n' +
        '- `motir-core/lib/ai/motirAiClient.ts` (7.1.5) — submit/await the ' +
        'prompt job.\n' +
        '- `motir-core/CLAUDE.md` § "manual merge mode" + § 4-layer; ' +
        'Principle #3 (generate → human approve → persist) — why ' +
        'auto-merge-to-main is rejected.\n' +
        '- Story 7.7 (stub) — the GitHub install that POPULATES `targetRepo` ' +
        'and CLOSES the dispatch→PR→status loop 7.6 only opens.',
      dependsOn: ['7.6.2'],
    },
    {
      id: '7.6.4',
      title:
        'Dispatch surface UI — prompt display + copy + git-workflow variant selector (rides the DONE 7.0 ready set)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Build the dispatch surface UI exactly as 7.6.1 specifies, hung off ' +
        'the DONE 7.0 `/ready` ready set. A ready row gains a **Generate ' +
        'prompt** action; choosing it opens the dispatch view (a peek/panel ' +
        'consistent with the existing `/ready` row interaction) that submits ' +
        'the 7.6.2 job (via the 7.6.3 dispatch service/endpoint), streams ' +
        'progress, then renders the generated prompt with copy + the ' +
        'git-workflow variant selector.\n\n' +
        '**Renders EXACTLY what 7.6.1 designed:**\n\n' +
        '- **The generated-prompt view** — the streaming/progress state while ' +
        'the job runs (reuse the 7.1.4 job-stream consumption pattern + the ' +
        'shipped progress primitive), then the prompt in a monospace, ' +
        'read-only, scrollable `--el-surface-soft` block, sectioned ' +
        '(context / task / acceptance criteria / git workflow), with a ' +
        'prominent **Copy prompt** icon-button (aria-label, keyboard-' +
        'reachable, the panel-4 toast on click) + a regenerate affordance.\n' +
        '- **The GIT WORKFLOW variant selector** (segmented control / radio): ' +
        '**Per-item PR** (default) and **Session branch**; changing it ' +
        're-renders the GIT WORKFLOW section of the displayed prompt (it ' +
        're-requests the payload with the chosen `gitWorkflowVariant`, or ' +
        're-renders the already-returned block — implementer’s call, but ' +
        'the displayed prompt MUST match the selected variant). NO ' +
        'auto-merge option exists.\n' +
        '- **`targetRepo` + `sessionBranch`** surfaced (which repo the agent ' +
        'works in; for a session-branch run, the inherited branch), with the ' +
        '"no repo connected yet" state handled gracefully (7.6.3).\n' +
        '- **Per-type** — the prompt header reflects the item type (the ' +
        'type-pill via `IssueTypeIcon` hue), per 7.6.1 Panel 3.\n\n' +
        '**i18n.** Add the dispatch strings (the Generate-prompt action, the ' +
        'variant labels + explainers, the copy toast, the repo states) to a ' +
        'new `dispatch` namespace; locale = the same set the rest of the app ' +
        'ships.\n\n' +
        '**Client/server split (4-layer for UI).** The dispatch view is a ' +
        'client component for the streaming/interaction; it calls the 7.6.3 ' +
        'endpoint, never the service or Prisma directly. No business logic in ' +
        'the component — it consumes the `DispatchPayloadDto`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A ready row exposes **Generate prompt**; choosing it opens the ' +
        'dispatch view, streams job progress, then renders the prompt — ' +
        'composed of the named primitives, referencing ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities, the ' +
        '`motir-core/CLAUDE.md` rule).\n' +
        '- The git-workflow variant selector shows exactly **Per-item PR** + ' +
        '**Session branch**; switching it changes the displayed GIT WORKFLOW ' +
        'section; NO auto-merge option is present.\n' +
        '- **Copy prompt** is keyboard-reachable, has an aria-label, copies ' +
        'the exact rendered prompt, and shows the confirmation toast.\n' +
        '- The prompt header reflects the work-item type (per-type, per ' +
        '7.6.1 Panel 3); `targetRepo`/`sessionBranch` are surfaced, with the ' +
        '"no repo connected" state handled.\n' +
        '- The view rides the 7.0 `/ready` row interaction (peek/panel, not a ' +
        'full-page nav); no client component touches the service layer ' +
        'directly.\n' +
        '- Mobile: the surface is usable in the drawer/narrow layout (reuse ' +
        'the existing responsive patterns).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/dispatch/` (7.6.1) — the mockup + design-notes ' +
        'this implements verbatim.\n' +
        '- `motir-core/app/(authed)/ready/` (7.0.6) — the `/ready` page + row ' +
        'this hangs the Generate-prompt action off.\n' +
        '- 7.6.3 — the `DispatchPayloadDto` + `POST /api/ready/next` (the ' +
        'endpoint this UI calls).\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx`, ' +
        '`motir-core/components/ui/` (segmented-control, toast, progress) — ' +
        'the primitives composed.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` + `[data-display-' +
        'style]` token layers.',
      dependsOn: ['7.6.1', '7.6.2', '7.6.3'],
    },
    {
      id: '7.6.5',
      title: 'Vitest — per-type prompt generation + the dispatch payload variants',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Lock the prompt-generation moat + the dispatch contract against ' +
        'drift. Cover both sides — the motir-ai `generate_prompt` job and the ' +
        'motir-core dispatch payload — at the unit/integration level (NOT ' +
        "browser E2E, that's 7.6.6). Tests use a real Postgres on each side " +
        '(the motir-core standing rule, mirrored in motir-ai; the single ' +
        'allowed `vi.mock` on the core side is `getSession()`).\n\n' +
        '**Prompt-generation tests (motir-ai):**\n\n' +
        '- **Context injection present.** Over a fixture project (plan tree + ' +
        'the 7.5.4 fixture code graph), `generate_prompt` for a `code` item ' +
        'produces a prompt that names the parent story intent + at least one ' +
        'code-graph file/symbol beyond the bare `descriptionMd` (the moat: ' +
        'assert injected refs appear).\n' +
        '- **Per-type templates differ.** The SAME context yields a ' +
        'different leading section for `code` vs `design` vs `content` ' +
        '(assert each template’s signature header: 4-layer for code, ' +
        'design-gate for design, i18n/tone for content).\n' +
        '- **Code-less project.** A start-fresh project with no code graph ' +
        'yields a prompt whose code-context section is honestly empty (no ' +
        'fabricated file refs).\n' +
        '- **Five-element shape + placeholder.** The result has the ' +
        'context / task / constraints / acceptance-criteria sections AND a ' +
        'GIT WORKFLOW PLACEHOLDER (not a filled git block — that is the ' +
        'dispatch’s job).\n\n' +
        '**Dispatch-payload tests (motir-core):**\n\n' +
        '- **Both git-workflow variants render.** `per_item_pr` → a ' +
        'block instructing `feat/PROD-<key>-<slug>` + PR to `main`, ' +
        '`sessionBranch: null`; `session_branch` → a block instructing ' +
        'commit onto the inherited branch, `sessionBranch` carried through.\n' +
        '- **Auto-merge REJECTED (the guard test).** NEITHER rendered variant ' +
        'contains an auto-merge / merge-to-`main` instruction — assert the ' +
        'absence explicitly (this is the test that proves the rejected ' +
        'variant stays rejected).\n' +
        '- **Payload carries everything.** `DispatchPayloadDto` carries the ' +
        '7.6.2 `prompt` + `promptType` + `targetRepo` + the resolved ' +
        'git-workflow block, and still carries the 7.0 fields (`descriptionMd`,' +
        ' `contextRefs`, `blockerKeys`, `runCommand`).\n' +
        '- **7.0 contract preserved.** `POST /api/ready/next` with the new ' +
        'optional body fields defaults to `per_item_pr` AND still honors ' +
        '`excludeIds` + the sort/cursor (a regression guard on the 7.0 ' +
        'behavior).\n' +
        '- **`targetRepo` not-connected.** A project with no repo yields the ' +
        'clear "not connected" payload state, not a throw.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass green on both sides over a real Postgres; the ' +
        'suites run in each repo’s CI.\n' +
        '- The auto-merge guard test FAILS if a future change adds a ' +
        'merge-to-`main` instruction to either variant (it actually guards ' +
        'the rejection).\n' +
        '- The motir-core cases respect the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) for the new dispatch ' +
        'service/mapper/git-workflow code.\n\n' +
        '## Context refs\n\n' +
        '- 7.6.2 (the `generate_prompt` job + per-type registry) + 7.6.3 ' +
        '(the payload + git-workflow renderer) — everything under test.\n' +
        '- 7.5.4 — the LOCAL FIXTURE code graph the injection tests index ' +
        'against.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage gate.\n' +
        '- 7.0.7 — the existing `/api/ready/next` service/endpoint suite this ' +
        'extends (the 7.0-contract regression guard).',
      dependsOn: ['7.6.2', '7.6.3'],
    },
    {
      id: '7.6.6',
      title:
        'Playwright E2E — pick a ready item → generate prompt → copy with the right git-workflow variant',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/dispatch.spec.ts`) over the ' +
        'seeded `moooon`/`motir` tenant — closes the dispatch promise from ' +
        "the user's seat. Runs with both services up (motir-ai stubbed/real " +
        'per the existing e2e harness; the `generate_prompt` job either runs ' +
        'against the fixture code graph or a deterministic stub, matching how ' +
        'the e2e harness handles the AI boundary).\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager).\n' +
        '2. Go to **Ready**; pick a ready `code` subtask; choose **Generate ' +
        'prompt**. The dispatch view opens and shows the streaming/progress ' +
        'state, then the generated prompt (poll the `aria-live`/progress ' +
        'region; no fixed sleep — flake-resistant).\n' +
        '3. Assert the prompt is SECTIONED (context / task / acceptance ' +
        'criteria / git workflow) and names at least one injected context ref ' +
        '(a parent intent or a file path) beyond the bare title — the moat is ' +
        'visible to the user.\n' +
        '4. Confirm the GIT WORKFLOW variant selector shows **Per-item PR** ' +
        '(selected) + **Session branch** and NO auto-merge option. With ' +
        'per-item PR selected, the prompt’s git section instructs ' +
        '`feat/PROD-<key>-<slug>` + a PR to `main`.\n' +
        '5. Switch to **Session branch**; the prompt’s git section ' +
        're-renders to commit onto the inherited session branch (and never ' +
        'says "merge to main").\n' +
        '6. Click **Copy prompt**; read the clipboard; assert it equals the ' +
        'displayed prompt verbatim (the established Playwright clipboard ' +
        'pattern, no new flag-flipping) and the confirmation toast appears.\n' +
        '7. (Per-type smoke) Back to Ready, pick a `design` subtask, Generate ' +
        'prompt; assert the leading section differs from the code prompt ' +
        '(the design-gate header, not the 4-layer header).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e dispatch` passes locally + in CI.\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper ' +
        '+ the established clipboard-read pattern — no new auth/clipboard ' +
        'plumbing invented.\n' +
        '- It asserts: the prompt streams + renders sectioned + injected, the ' +
        'two git-workflow variants (and the ABSENCE of auto-merge), the copy ' +
        'verbatim + toast, and the per-type difference (code vs design).\n' +
        '- Flake-resistant: explicit waits on the progress/`aria-live` region ' +
        'and on the prompt-text change after switching variant (poll up to ' +
        '5s), no fixed sleeps.\n\n' +
        '## Context refs\n\n' +
        '- 7.6.4 — the dispatch surface UI under test.\n' +
        '- `motir-core/tests/e2e/ready.spec.ts` (7.0.8) — the sibling e2e ' +
        'over the same `/ready` surface; mirror its `signIn` + clipboard ' +
        'patterns + the seeded tenant.\n' +
        '- The e2e harness’s handling of the motir-ai boundary (how the ' +
        '`generate_prompt` job is run/stubbed in e2e).',
      dependsOn: ['7.6.4'],
    },
  ],
};
