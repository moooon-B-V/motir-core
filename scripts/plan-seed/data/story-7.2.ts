import type { SeedStory } from '../types';

/**
 * Story 7.2 — Chat front door + stack/opinion discovery + direction docs. The
 * FIRST human-facing AI surface in Epic 7 and the entry point of the whole
 * planning flow: a project starts here, in a conversation, before a single
 * issue exists. It rides the 7.1 boundary (7.1.3 motir-ai DB, 7.1.4 jobs,
 * 7.1.5 client) and produces the three **direction docs** every later planner
 * (7.3 generate_tree, 7.4 augment/re-plan, 7.6 prompt gen) reads as the
 * grounding context.
 *
 * **What 7.2 is.** The chat front door + the `discovery` job that drives it. A
 * project owner opens the chat, describes the thing they want to build, and
 * motir-ai runs a **discovery pass** — a "do you care?" interview about the
 * decisions a planner cannot safely assume (stack, deploy target, design
 * language, scope, constraints) — then drafts three persisted, human-editable
 * documents:
 *   - **vision** — what we're building and for whom (the durable north star),
 *   - **discovery** — the answered "do you care?" decisions (stack / deploy /
 *     design-language / constraints the user explicitly pinned, vs the ones
 *     they delegated to the planner), and
 *   - **feasibility** — the honest read on scope, risk, and what's unknown.
 * These are the `DirectionDoc` rows that Story 7.1's header reserved for 7.2:
 * the first of motir-ai's three context stores to land (mistakes = 7.10, code
 * graph = 7.5/7.7). They live in motir-ai's OWN Postgres, NOT motir-core —
 * this is the open-core line (motir-core stays a complete exportable Jira
 * clone with zero AI tables; the direction docs are the productized
 * `motir-meta`).
 *
 * **What 7.2 is NOT.** It does NOT generate the issue tree — that's 7.3
 * (`generate_tree`), which CONSUMES these docs. 7.2 ends when the three docs
 * exist and the user is happy with them; "now turn this into a plan" is the
 * 7.3 hand-off. It also is not the retrieval layer (7.5), the prompt
 * generation (7.6), or the mistakes store (7.10).
 *
 * **The architecture it inherits (see story-7.1.ts header for the full prose).**
 * 1. ONE-DIRECTIONAL WRITES — the AI never writes the tree; 7.2 writes only
 *    direction docs, and those live in motir-ai's own DB, so 7.2 doesn't touch
 *    the plan tree at all. (The docs are READ by 7.3 to generate, and 7.3's
 *    delta is what motir-core persists.)
 * 2. A TOOL-USE SESSION, NOT A ONE-SHOT — discovery is a multi-turn interview,
 *    so it is a `discovery` JOB (`jobKind` reserved in 7.1.1), streamed over
 *    the 7.1.4 job stream, NOT a held chat-completion socket. One job model
 *    serves both this web chat AND the headless planners.
 * 3. STATEFUL motir-ai — the docs persist across sessions; re-opening the chat
 *    resumes from the saved docs, it does not re-interview from scratch.
 *
 * **Mirror product (rung 1, Atlassian Rovo — what I actually observed, June
 * 2026, not asserted).** Rovo ships a CONVERSATIONAL planning surface: "Rovo
 * Chat allows you to access the knowledge of your organization through a
 * conversational interface… ask Rovo to write, read, review, or create things
 * the same way you might ask a person," and a project manager "could employ AI
 * to… generate a draft project plan… consolidating relevant details" (the
 * atlassian.com/software/rovo + /jira/ai pages). Rovo's newer **Max** reasoning
 * mode "breaks complex requests into multistep plans, executes them across
 * connected tools, and loops users back in for review" (the Team '26
 * announcement) — the generate→review→loop shape Motir mirrors. Rovo's
 * engineering blog confirms a **Reasoning** mode that "explicitly outputs a
 * natural language research plan" before acting.
 *
 * **The verified GAP (marked as a deliberate Motir choice, not a mirror copy).**
 * I could NOT find evidence that Rovo runs an explicit up-front DISCOVERY /
 * "do you care?" INTERVIEW that asks the user to pin stack/deploy/design
 * decisions before planning, NOR that it persists a durable vision/feasibility
 * document set. Rovo's plan is an artifact it drafts and you edit; the
 * "interview-first, then three durable direction docs" shape is Motir's
 * addition (it's the productized motir-meta direction-docs idea, MOTIR.md). So
 * 7.2.1's discovery-interview panel and the three-doc model are an **assumption
 * to validate against a live Rovo tenant**, recorded as such on 7.2.1 / 7.2.5
 * rather than claimed as a verified mirror surface. What IS verified: the
 * conversational front door, and the generate→human-review→loop posture.
 *
 * **The planner LLM (7.2.2/7.2.3).** Per the repo's claude-api guidance, the
 * planner uses the **Anthropic SDK** with **`claude-opus-4-8`** as the default
 * planning model (the most capable Opus-tier model, 1M context, adaptive
 * thinking) and **`claude-fable-5`** reserved for the hardest long-horizon
 * planning runs. Discovery is a tool-use session, so adaptive thinking +
 * streaming are the defaults. The provider key is provisioned by a manual
 * subtask (7.2.3), mirror 1.6.7 — a coding agent cannot mint an API key.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 7.2 leaf depends
 * only on same-story 7.2.x cards and already-expanded 7.1.x cards (7.1.3 DB,
 * 7.1.4 jobs, 7.1.5 client) — all backward/sideways, no forward-pointing dep.
 * 7.3+ depend on 7.2, never the reverse.
 */
export const story_7_2: SeedStory = {
  id: '7.2',
  title: 'Chat front door + discovery + direction docs',
  status: 'planned',
  gitBranch: 'feat/PROD-7.2-chat-discovery-direction-docs',
  descriptionMd:
    'The **conversational entry point** of the AI planning layer: a project ' +
    'starts as a chat, not a blank backlog. The owner describes what they want ' +
    'to build; motir-ai runs a **discovery interview** (the "do you care?" ' +
    'pass over the decisions a planner must not silently assume — stack, ' +
    'deploy target, design language, scope, constraints) and drafts three ' +
    'persisted, human-editable **direction docs** (vision / discovery / ' +
    'feasibility) that every later planner reads as grounding context. This is ' +
    'the first of motir-ai’s three context stores to ship (mistakes = ' +
    '7.10, code graph = 7.5/7.7), and it lands in **motir-ai’s own DB**, ' +
    'never motir-core — the open-core line holds (motir-core stays a ' +
    'complete exportable Jira clone with zero AI tables).\n\n' +
    '**The flow (locked, see the module header for the full rationale):**\n\n' +
    '- **Front door** — a chat panel where the owner describes the ' +
    'project. The chat is a thin motir-core surface that proxies a `discovery` ' +
    'job to motir-ai over the 7.1.5 client + 7.1.4 job stream (NOT a held ' +
    'chat-completion socket — discovery is a multi-step tool-use session, ' +
    'so it rides the async job model that ALSO serves the headless ' +
    'planners).\n' +
    '- **Discovery** — motir-ai’s `discovery` job interviews the ' +
    'user, distinguishing decisions they PIN (a chosen stack, a deploy target, ' +
    'a design language) from decisions they DELEGATE to the planner — and ' +
    '**never assumes an unfit default** (the central anti-pattern this story ' +
    'exists to prevent). Progress streams token-by-token over the job ' +
    'stream.\n' +
    '- **Direction docs** — the job drafts and persists three ' +
    '`DirectionDoc` rows (vision / discovery / feasibility) keyed to the ' +
    'project; the user reviews and lightly edits them in a docs view. Re-' +
    'opening the chat resumes from the saved docs (motir-ai is stateful), it ' +
    'does not re-interview from scratch.\n\n' +
    '**Scope:** the design asset for the chat + discovery + 3-doc surfaces ' +
    '(7.2.1); the planner-LLM/SDK decision (7.2.2) + its provider-key ' +
    'provisioning (7.2.3); the `DirectionDoc` store in motir-ai (7.2.4); the ' +
    '`discovery` job handler that drives the interview and drafts the docs ' +
    '(7.2.5); the motir-core chat API + streaming proxy (7.2.6); the chat ' +
    'front-door UI (7.2.7); the direction-docs render/light-edit view (7.2.8); ' +
    'and the vitest + Playwright coverage (7.2.9 / 7.2.10).\n\n' +
    '**Out of scope (named so they land in their owning stories):** issue-tree ' +
    'GENERATION from the docs (7.3 `generate_tree` — 7.2 ends at "the ' +
    'docs exist and the user is happy"; "turn this into a plan" is the 7.3 ' +
    'hand-off); augment / expand / re-plan (7.4); shared-context retrieval + ' +
    'the code graph (7.5); per-type prompt generation (7.6); the GitHub feed ' +
    '(7.7); the planning-mistakes store (7.10).',
  verificationRecipeMd:
    '- **Discovery smoke (the front door).** With both services running ' +
    'locally (motir-ai on its dev port with a valid Anthropic key from 7.2.3, ' +
    'motir-core on `:3000`, each pointed at the other via env): open the chat ' +
    'front door for the `PROD` project, describe a small product in one ' +
    'paragraph, and confirm motir-ai (a) streams a discovery interview that ' +
    'ASKS about stack / deploy / design language rather than assuming them, ' +
    '(b) lets you pin some decisions and delegate others, and (c) ends by ' +
    'producing three direction docs (vision / discovery / feasibility) that ' +
    'appear in the docs view. Re-open the chat — it RESUMES from the saved ' +
    'docs (no re-interview).\n' +
    '- `pnpm test` (motir-core) + the motir-ai test suite — 7.2.9 covers: ' +
    'the `discovery` job lifecycle (`queued → running → succeeded`) ' +
    'with the docs persisted; `DirectionDoc` create/read/version through ' +
    'motir-ai’s repo+service; the chat proxy mapping the 7.1.1 taxonomy ' +
    'into motir-core typed errors; the job-scoped auth on the docs read-back; ' +
    'and a discovery pass that, given a deliberately under-specified prompt, ' +
    'emits a QUESTION rather than a fabricated default (the no-unfit-default ' +
    'guarantee).\n' +
    '- `pnpm test:e2e` (Playwright) — 7.2.10 covers: signed in as ' +
    '`zhuyue@motir.co`, open the chat, answer the discovery questions, and ' +
    'watch the three direction docs appear and become editable; an edit to a ' +
    'doc persists across reload.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** ' +
    'Confirm the `DirectionDoc` table lives ONLY in motir-ai’s schema ' +
    '(zero AI tables in motir-core’s `prisma/schema.prisma`); the chat ' +
    'and docs surfaces reach motir-ai ONLY through the 7.1 client / job stream ' +
    '(no `motir-ai` import in motir-core; browsers never call motir-ai); and ' +
    'the Anthropic key is held ONLY by motir-ai, never shipped to the ' +
    'browser.\n' +
    '- **Provisioning (7.2.3) confirmation.** The Anthropic API key + model ' +
    'access are set for motir-ai and the planner model ids decided in 7.2.2 ' +
    'resolve — Yue confirms (no PR).\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a ' +
    'follow-up Subtask under the same Story.',
  items: [
    {
      id: '7.2.1',
      title: 'Design — chat front door + discovery Q&A + the 3 direction-docs view',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (planning-time design gate, Principle #13 + the ' +
        'design-reference rule). Every UI-touching subtask in this Story ' +
        '(7.2.7 chat UI, 7.2.8 docs view) depends on this one; without it those ' +
        'surfaces would be improvised, which is forbidden (notes.html #31). ' +
        'This is the FIRST human-facing AI surface in Epic 7, so it sets the ' +
        'visual language for the whole planning flow (7.3 review, 7.4 diff, ' +
        '7.6 dispatch reuse its grammar).\n\n' +
        'Produce the design asset for the AI-chat surface under ' +
        '`motir-core/design/ai-chat/`. Author it as a **`*.mock.html` mockup** ' +
        'built from the real design system (the `components/ui/*` primitives + ' +
        'the `--el-*` tokens + the `[data-display-style]` shape tokens) — ' +
        'NOT a `.pen`. The HTML route is preferred when a coding agent produces ' +
        'the design (no Pencil→code translation gap; the reviewer sees the ' +
        'actual tokens). Render a PNG export if useful, but the `.mock.html` is ' +
        'the source of truth (MOTIR.md § Design-reference rule).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-' +
        'panel rule, mistake #31):\n\n' +
        '- **Panel 1 — chat front door (empty / first run).** The entry ' +
        'state: a heading ("Let’s plan " + the active project identifier), ' +
        'a short explainer of what discovery does, and a prompt input (the ' +
        'shipped textarea/editor primitive) where the owner describes the ' +
        'product. A "What happens next?" info popover that explains the ' +
        'discovery→docs flow to a first-time user.\n' +
        '- **Panel 2 — discovery interview (mid-conversation, streaming).** ' +
        'The "do you care?" Q&A in flight: alternating user / assistant message ' +
        'bubbles, the assistant streaming a question, and a streaming/typing ' +
        'affordance. Crucially, draw the **PIN-vs-DELEGATE** choice: when the ' +
        'assistant asks a decision question (e.g. "Which deploy target?"), the ' +
        'user can answer OR tap a "you decide" affordance that delegates it to ' +
        'the planner. Show one of each in the transcript. (Mirror posture: ' +
        'Rovo’s conversational chat is verified; the explicit discovery-' +
        'interview shape is a Motir assumption — see the module header — ' +
        'so note in design-notes.md that this panel’s interaction is to be ' +
        'validated against a live Rovo tenant.)\n' +
        '- **Panel 3 — the three direction docs (review/light-edit).** A ' +
        'tabbed or three-column view of **vision / discovery / feasibility**, ' +
        'each rendered as Markdown with a light inline-edit affordance (reuse ' +
        'the shipped Markdown render + the existing editable-field pattern). ' +
        'The discovery doc visibly separates PINNED decisions from DELEGATED ' +
        'ones. A primary "Looks right — generate the plan" CTA that is the ' +
        '7.3 hand-off (drawn but wired in 7.3, NOT here).\n' +
        '- **Panel 4 — in-progress + error/empty states.** The job-running ' +
        'state (a progress indicator tied to the 7.1.4 job stream), the ' +
        'discovery-failed state (reuse the shipped error/EmptyState primitive ' +
        'with a retry), and the "docs already exist — resume" state when a ' +
        'user re-opens the chat for a project that already has direction docs.\n\n' +
        'Also write **`design/ai-chat/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings (incl. the ' +
        'discovery question framing and the pin/delegate labels), the placement ' +
        'decisions, the per-`--el-*` colour role for each element, and a ' +
        '"primitives composed (no hand-rolling)" checklist (the convention ' +
        '1.3.3 / 1.5.1 established). Record the Rovo-mirror assumption + the ' +
        'three-doc model explicitly so the reviewer sees what is verified vs ' +
        'assumed.\n\n' +
        '**Branch.** `design/PROD-7.2.1-ai-chat-surface`. The `design/*` prefix ' +
        'gate skips CI E2E + the Vercel preview deploy (per MOTIR.md § Plan ' +
        'seed Workflow) — this PR only edits `design/ai-chat/**`, no app ' +
        'code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-chat/ai-chat.mock.html` exists, renders the ' +
        'four panels above side-by-side, and references ONLY `--el-*` colour ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled spacing — the rules in `motir-core/CLAUDE.md` ' +
        '§ colour / shape).\n' +
        '- The discovery panel draws BOTH an answered question and a "you ' +
        'decide / delegate" affordance (the pin-vs-delegate model is visible).\n' +
        '- The docs panel draws vision / discovery / feasibility as three ' +
        'editable Markdown surfaces, with the pinned-vs-delegated split visible ' +
        'in the discovery doc, and the "generate the plan" CTA present (wired ' +
        'in 7.3).\n' +
        '- `motir-core/design/ai-chat/design-notes.md` exists, names every ' +
        'primitive + copy string + per-element `--el-*` role, and records the ' +
        'verified-vs-assumed mirror note.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Button`, the ' +
        'Markdown renderer, the editable-field, `EmptyState`, the message-' +
        'bubble/chat primitive if one exists — else flag a NEW `design/` ' +
        'subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ready/` (7.0.1) and `motir-core/design/work-' +
        'items/` — the closest existing areas; mirror their layout and ' +
        '`design-notes.md` shape.\n' +
        '- `motir-core/components/ui/*` — the shipped primitives (Card, ' +
        'Button, EmptyState, the Markdown renderer, the editable-field, the ' +
        'toast) the mockup composes.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup must ' +
        'reference).\n' +
        '- This module header — the verified Rovo mirror + the discovery/' +
        'three-doc assumption to flag.',
      dependsOn: [],
    },
    {
      id: '7.2.2',
      title: 'Decision — motir-ai’s planner LLM + SDK (Anthropic SDK, latest Claude)',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        '**Type:** decision (the ADR that fixes which model + SDK every ' +
        'motir-ai planning job — discovery here, generation in 7.3, ' +
        'augment/re-plan in 7.4, prompt gen in 7.6 — calls). No app ' +
        'behavior ships here; the shapes it fixes are load-bearing for every ' +
        'later AI card and for the 7.2.3 provisioning subtask.\n\n' +
        'Write `motir-ai/docs/planner-llm.md` (the authoritative planner-model ' +
        'ADR). Per the repo’s **claude-api guidance**, it MUST fix:\n\n' +
        '1. **SDK.** motir-ai uses the official **Anthropic SDK** ' +
        '(`@anthropic-ai/sdk`, the TypeScript SDK, matching motir-ai’s ' +
        'Hono/TS stack) — NOT raw HTTP, NOT an OpenAI-compatible shim. The ' +
        'planning loop is a tool-use SESSION, so it uses the SDK’s message ' +
        'streaming + tool-use loop (the `discovery` job consumes the stream and ' +
        'relays progress over the 7.1.4 job stream).\n' +
        '2. **Model ids (record them + why).** Default planning model = ' +
        '**`claude-opus-4-8`** — the most capable Opus-tier model (1M ' +
        'context, adaptive thinking), the right default for planning per the ' +
        'claude-api skill. Reserve **`claude-fable-5`** for the hardest long-' +
        'horizon planning runs (Anthropic’s most capable widely-released ' +
        'model) behind a config flag — note its differing API surface ' +
        '(thinking always on; new tokenizer; 30-day-retention requirement) so a ' +
        'later switch is a config change, not a rewrite. Pin the EXACT id ' +
        'strings (no date suffixes).\n' +
        '3. **Inference defaults.** Adaptive thinking (`thinking: {type: ' +
        '"adaptive"}`) for the planning reasoning; STREAM every job (planning ' +
        'runs are long — streaming avoids request timeouts and feeds the ' +
        'job stream); `output_config.effort` at `high` for planning quality. ' +
        'No `temperature`/`budget_tokens` (removed on Opus 4.8 — they 400).\n' +
        '4. **Structured output.** Discovery drafts three docs and later jobs ' +
        'emit a tree-delta — decide the structured-output mechanism ' +
        '(`output_config.format` JSON schema and/or a tool the model fills) so ' +
        'the doc/delta shapes are validated, not parsed from prose. (7.3 reuses ' +
        'this for the tree-delta.)\n' +
        '5. **Env keys to provision** (the input to 7.2.3): the Anthropic API ' +
        'key (`ANTHROPIC_API_KEY`) + any model-access prerequisites, named so ' +
        '7.2.3 can provision them.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/planner-llm.md` exists and fixes all five sections ' +
        'with the exact model id strings (`claude-opus-4-8` default, ' +
        '`claude-fable-5` reserved) and a one-paragraph justification of the ' +
        'default per the claude-api guidance.\n' +
        '- The inference defaults (Anthropic SDK, adaptive thinking, streaming, ' +
        'effort) are stated, with the removed-on-Opus-4.8 params (`temperature`, ' +
        '`budget_tokens`) explicitly excluded.\n' +
        '- The env-key inventory (`ANTHROPIC_API_KEY` + model access) is ' +
        'explicit — it is the input to 7.2.3.\n' +
        '- The structured-output mechanism for the three docs is decided (so ' +
        '7.2.5 implements against it, not free-text parsing).\n\n' +
        '## Context refs\n\n' +
        '- The repo’s claude-api guidance (the `/claude-api` skill) — ' +
        'the SDK + model-id + adaptive-thinking + streaming defaults this ADR ' +
        'records.\n' +
        '- `motir-ai/package.json` + `motir-ai/src/index.ts` — the Hono/TS ' +
        'stack the `@anthropic-ai/sdk` slots into.\n' +
        '- 7.1.4 § the `(job, ctx) => Promise<Result>` handler interface + ' +
        'job stream the planner streams progress over.\n' +
        '- This module header — the discovery-as-tool-use-session shape the ' +
        'model serves.',
      dependsOn: [],
    },
    {
      id: '7.2.3',
      title: 'Provision the Anthropic API key + model access for motir-ai (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 25,
      descriptionMd:
        '**Type:** manual/human (no PR — secret / dashboard / SaaS work, ' +
        'mirror 1.6.7; marked done on Yue’s confirmation). A coding agent ' +
        'cannot mint a production LLM provider key or grant model access. Wired ' +
        'here via `dependsOn` so the prerequisite is visible at PLAN time ' +
        '(notes.html #30), not discovered when the `discovery` job (7.2.5) ' +
        'first runs and 401s.\n\n' +
        'Using the env-key inventory fixed by 7.2.2:\n\n' +
        '1. **Provision the Anthropic API key** — create/obtain an ' +
        'Anthropic API key for the motir-ai service (its own key, separate from ' +
        'any personal dev key) and confirm the org has **model access** to the ' +
        'planner models 7.2.2 pinned (`claude-opus-4-8`; and, if the reserved ' +
        '`claude-fable-5` path is to be exercised, its 30-day-data-retention ' +
        'prerequisite is satisfied for the org).\n' +
        '2. **Wire env** on motir-ai: set `ANTHROPIC_API_KEY` (+ any base-URL / ' +
        'region keys the deployment needs) in motir-ai’s environment — ' +
        'server-side ONLY; the key is NEVER shipped to the browser (the open-' +
        'core invariant: browsers never call motir-ai, and the planner key ' +
        'lives only on the closed side).\n' +
        '3. **Local dev** — add the key to motir-ai’s `.env.example` ' +
        'as a NAMED placeholder (no real value committed) so a fresh checkout ' +
        'knows the key is required.\n\n' +
        '## Acceptance criteria\n\n' +
        '- An Anthropic API key exists for motir-ai and is set in its ' +
        'environment (cloud) + documented as a placeholder in `.env.example` ' +
        '(local).\n' +
        '- The org has confirmed model access to `claude-opus-4-8` (and the ' +
        'retention prerequisite for `claude-fable-5` if that path is enabled).\n' +
        '- The key is server-side only — no Anthropic key appears in any ' +
        'motir-core env or any client bundle.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.2.2’s env-key inventory + the pinned model ids.\n' +
        '- `motir-ai/.env.example` (extended in 7.1.3) — where the ' +
        'placeholder lands.\n' +
        '- 7.1.2 (the motir-ai datastore + service-credential provisioning) as ' +
        'the precedent shape for secret wiring.',
      dependsOn: ['7.2.2'],
    },
    {
      id: '7.2.4',
      title: 'Direction-docs store — `DirectionDoc` schema + repo/service (motir-ai)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Add the FIRST of motir-ai’s three context stores to the ' +
        'foundation 7.1.3 stood up: the **direction docs**. This is the table ' +
        'Story 7.1’s header reserved for 7.2 — it lives in ' +
        'motir-ai’s OWN Postgres (Prisma, from 7.1.3), NOT motir-core, ' +
        'keeping the open-core line clean.\n\n' +
        '- **`DirectionDoc`** model: `{ id, aiProjectId, kind, contentMd, ' +
        'version, createdAt, updatedAt }` where `kind` is an enum ' +
        '`vision | discovery | feasibility`, `aiProjectId` references the ' +
        '`AiProject` spine (7.1.3), and `version` is an integer bumped on each ' +
        'edit (so the discovery job can re-draft and a user edit is a new ' +
        'version, not a destructive overwrite — durable shape, no "latest ' +
        'only" shortcut). A unique on `(aiProjectId, kind, version)`, and an ' +
        'index for "latest version per (project, kind)".\n' +
        '- **Repository** (`directionDocRepository`) — single-op methods ' +
        'mirroring motir-core’s 4-layer spirit (lightly, on the closed ' +
        'side, per 7.1.3): `findLatestByProjectAndKind`, `listLatestByProject` ' +
        '(the three current docs), `create` (a new version row). Writes take ' +
        'the Prisma tx; reads use the db singleton.\n' +
        '- **Service** (`directionDocsService`) — owns the transaction + ' +
        'the "upsert as a new version" business rule: ' +
        '`saveDoc(aiProjectId, kind, contentMd)` reads the current max version ' +
        'for `(project, kind)` and writes `version + 1`; ' +
        '`getCurrentDocs(aiProjectId)` returns the latest of each kind (or the ' +
        'subset that exists). Returns DTOs, not raw Prisma rows.\n\n' +
        'No motir-core involvement — these rows never leave motir-ai except ' +
        'through the 7.1 read surface that 7.2.8 consumes. This is the open-core ' +
        'data boundary: motir-core has zero AI tables.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains the `DirectionDoc` model + the ' +
        '`kind` enum + a migration; `pnpm prisma generate` + `pnpm migrate` run ' +
        'clean against the local docker Postgres (the 7.1.3 setup).\n' +
        '- `directionDocRepository` + `directionDocsService` exist with the ' +
        'methods above; saving the same `(project, kind)` twice produces ' +
        'version 1 then version 2 (no overwrite), and `getCurrentDocs` returns ' +
        'the latest of each kind.\n' +
        '- A unit test covers: create→versioned-create, latest-per-kind ' +
        'read, and the empty case (a project with no docs yet returns an empty ' +
        'set, not an error).\n' +
        '- NO `DirectionDoc` (or any AI table) appears in motir-core’s ' +
        '`prisma/schema.prisma` — the open-core boundary holds.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.3 — the motir-ai Prisma foundation + the `AiProject` spine ' +
        'this hangs off + the repo/service layering to mirror.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer — the Route→Service' +
        '→Repository→Prisma spirit motir-ai mirrors lightly.\n' +
        '- This module header — the three-doc model (vision / discovery / ' +
        'feasibility) + the open-core line.\n' +
        '- Story 7.1 header — direction docs reserved as 7.2’s store.',
      dependsOn: ['7.1.3'],
    },
    {
      id: '7.2.5',
      title: 'The `discovery` job handler — interview → draft the 3 docs (motir-ai)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Register the **`discovery` job handler** in motir-ai (the `jobKind` ' +
        'reserved in 7.1.1, replacing the 7.1.7 `noop` stub for this kind). ' +
        'This is the brain of the front door: a chat-driven, tool-use ' +
        'interview that surfaces the decisions a planner must not assume, then ' +
        'drafts the three direction docs.\n\n' +
        '- **Handler shape.** Implements the 7.1.4 `(job, ctx) => ' +
        'Promise<Result>` interface for `kind: discovery`. It runs a planning ' +
        'SESSION using the Anthropic SDK + the model fixed in 7.2.2 ' +
        '(`claude-opus-4-8` default, adaptive thinking, streaming), consuming ' +
        'the user’s message turns (carried in the job envelope / appended ' +
        'via the chat proxy 7.2.6) and emitting assistant turns.\n' +
        '- **The "do you care?" pass.** The system prompt drives a DISCOVERY ' +
        'interview over the decisions a fresh-project planner cannot safely ' +
        'default: **stack** (language/framework/DB), **deploy target**, ' +
        '**design language**, **scope boundaries**, and hard **constraints**. ' +
        'For each, the user may PIN a choice or DELEGATE it ("you decide"). The ' +
        'handler **never assumes an unfit default** — when the prompt is ' +
        'under-specified on a load-bearing decision, it ASKS rather than ' +
        'fabricating (the central guarantee 7.2.9 tests).\n' +
        '- **Streaming progress.** Token/assistant-turn progress streams over ' +
        'the 7.1.4 job stream (SSE) so the 7.2.6 proxy can relay it live to the ' +
        'chat UI — NOT a held completion socket.\n' +
        '- **Drafting the docs.** When discovery has enough, the handler emits ' +
        'three structured documents (using the 7.2.2 structured-output ' +
        'mechanism) — **vision** (what + for whom), **discovery** (the ' +
        'pinned-vs-delegated decisions), **feasibility** (scope/risk/unknowns) ' +
        '— and persists each via `directionDocsService.saveDoc` (7.2.4), ' +
        'so a re-draft is a new version, not a clobber. The job result reports ' +
        'the doc ids/versions written.\n' +
        '- **Stateful resume.** On a project that already has docs, the handler ' +
        'reads the current docs (7.2.4) and RESUMES/refines rather than re-' +
        'interviewing from scratch (motir-ai is stateful, per the architecture).\n\n' +
        '**Mirror note (assumption to validate).** The conversational front ' +
        'door mirrors Rovo Chat (verified); the explicit up-front discovery ' +
        'INTERVIEW + the durable three-doc set is a Motir choice not confirmed ' +
        'in Rovo (see the module header) — keep the interview prompt + doc ' +
        'shape behind the structured-output contract so it can be tuned once ' +
        'validated against a live Rovo tenant.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `discovery` job submitted for a project drives `queued → ' +
        'running → succeeded`; on success three `DirectionDoc` rows ' +
        '(vision / discovery / feasibility) exist for that project via 7.2.4.\n' +
        '- Given an under-specified prompt, the handler emits a discovery ' +
        'QUESTION (streamed) rather than fabricating a stack/deploy default — ' +
        'the no-unfit-default guarantee.\n' +
        '- A user can PIN a decision (recorded as pinned in the discovery doc) ' +
        'or DELEGATE it (recorded as delegated) — both reflected in the ' +
        'drafted discovery doc.\n' +
        '- Progress streams over the 7.1.4 job stream; the handler uses the ' +
        '7.2.2 model + Anthropic SDK (adaptive thinking, streaming).\n' +
        '- Re-running discovery on a project that already has docs RESUMES from ' +
        'the saved docs (writes a new version), it does not duplicate or ignore ' +
        'them.\n' +
        '- Uses the structured-output mechanism from 7.2.2 — docs are ' +
        'validated structures, not free-text screen-scraped from prose.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.4 — the job substrate + the `(job, ctx) => Promise<Result>` ' +
        'handler registry + the SSE job stream (this replaces `noop` for ' +
        '`kind: discovery`).\n' +
        '- 7.2.2 — the Anthropic SDK + model ids + structured-output ' +
        'mechanism this implements against.\n' +
        '- 7.2.3 — the provisioned `ANTHROPIC_API_KEY` (a missing key ' +
        'fails the job cleanly per the 7.1.1 taxonomy).\n' +
        '- 7.2.4 — `directionDocsService.saveDoc` / `getCurrentDocs` (the ' +
        'persist + resume surface).\n' +
        '- This module header — the discovery model + the verified-vs-' +
        'assumed Rovo mirror.',
      dependsOn: ['7.2.4', '7.2.3', '7.1.4'],
    },
    {
      id: '7.2.6',
      title: 'Chat API + streaming proxy to the discovery job (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The motir-core side of the chat front door: the API the chat UI talks ' +
        'to, which submits/streams the `discovery` job to motir-ai over the ' +
        '7.1.5 client + 7.1.4 job stream. motir-core owns NO planning logic ' +
        'here — it is a thin, authenticated proxy that keeps the open-core ' +
        'invariant (browsers never call motir-ai directly).\n\n' +
        '- **Submit / append turn** — a route (e.g. ' +
        '`POST /api/ai/chat`) that, via a service, resolves the active project, ' +
        'submits (or appends a user turn to) a `discovery` job through the ' +
        "7.1.5 `motirAiClient.submitJob('discovery', tenant, context, ctx)` " +
        '— minting the job-scoped read-back token the same way 7.1.5 does ' +
        '— and returns the `jobId`. 4-layer: route → a chat service ' +
        '→ the client; no business logic in the route, no `motir-ai` ' +
        'import in motir-core.\n' +
        '- **Stream** — a route (e.g. `GET /api/ai/chat/:jobId/stream`) ' +
        'that proxies the motir-ai job stream (7.1.5 `streamJob`) to the ' +
        'browser as SSE, relaying assistant-turn tokens + progress + terminal ' +
        'status, mapping the 7.1.1 error taxonomy into motir-core typed errors. ' +
        'This is the live channel the 7.2.7 UI subscribes to.\n' +
        '- **Auth + tenancy** — every call reads the session via ' +
        '`getSession()`, applies the workspace-membership gate, and is scoped ' +
        'to the active project (the established `getActiveProject` pattern); ' +
        'cross-tenant project → 404 (finding #26), no session → 401.\n' +
        '- **Server-only boundary** — the client + token minting are ' +
        'server-side; the browser reaches motir-ai ONLY through these motir-' +
        'core routes (the open-core invariant).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/ai/chat` submits/append-to a `discovery` job via the ' +
        '7.1.5 client (with a freshly minted job-scoped token) and returns the ' +
        '`jobId`; the route imports no Prisma and no `motir-ai` package.\n' +
        '- `GET /api/ai/chat/:jobId/stream` relays the motir-ai job stream to ' +
        'the browser as SSE, surfacing assistant turns + progress + the ' +
        'terminal status, and closes on a terminal state.\n' +
        '- Errors from motir-ai map through the 7.1.1 taxonomy into motir-core ' +
        'typed errors → correct HTTP status (401 no session, 404 cross-' +
        'tenant project, 5xx on an upstream job failure).\n' +
        '- 4-layer respected: route → chat service → 7.1.5 client; the ' +
        'browser never calls motir-ai directly.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.5 — `motirAiClient.submitJob` / `streamJob` + the job-scoped ' +
        'token minting (the seam this rides).\n' +
        '- 7.1.4 — the job stream shape (SSE) being proxied.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the `getActiveProject` / ' +
        '`getSession` patterns.\n' +
        '- 7.0 `/ready` SSE live-badge usage — the existing SSE pattern in ' +
        'motir-core to mirror for the stream route.',
      dependsOn: ['7.1.5'],
    },
    {
      id: '7.2.7',
      title: 'Chat front-door UI — streaming read-react-revise discovery loop (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the chat front-door page that the 7.2.1 design specifies: the ' +
        'owner describes the project, the discovery interview streams, the user ' +
        'reads-reacts-revises (answering or delegating each "do you care?" ' +
        'question), and the three direction docs are produced. This is the ' +
        'human surface over 7.2.6 + the `discovery` job.\n\n' +
        '- **Page.** A route under the authed shell (e.g. ' +
        '`app/(authed)/plan/page.tsx` or `app/(authed)/projects/[key]/plan`) ' +
        'resolving the active project. It renders EXACTLY what 7.2.1 ' +
        'specifies: the empty/first-run front door (Panel 1), the streaming ' +
        'interview transcript (Panel 2) with the pin-vs-delegate affordance, ' +
        'and the in-progress / error / resume states (Panel 4). The docs view ' +
        'itself is 7.2.8 — this page hands off to it (or embeds it) once ' +
        'the docs exist.\n' +
        '- **Streaming loop.** Submit the user’s prompt via ' +
        '`POST /api/ai/chat` (7.2.6) → subscribe to ' +
        '`GET /api/ai/chat/:jobId/stream` → render assistant turns ' +
        'token-by-token as they stream; when the assistant asks a decision ' +
        'question, the UI offers an answer input AND a "you decide" delegate ' +
        'action, posting the user’s response back as the next turn (read-' +
        'react-revise). A client component owns the SSE subscription; it never ' +
        'touches the service layer directly (it goes through the 7.2.6 API).\n' +
        '- **Resume.** If the project already has direction docs, the page ' +
        'opens in the resume state (Panel 4) rather than re-interviewing from a ' +
        'blank slate.\n' +
        '- **i18n + a11y.** Add the chat strings to a new `aiChat` namespace ' +
        '(same locale set the app ships); the transcript uses correct ' +
        'semantic/`aria-live` markup for streamed turns; the streaming ' +
        'indicator and the pin/delegate controls are keyboard-reachable.\n' +
        '- **Tokens.** References ONLY `--el-*` colour + `[data-display-style]` ' +
        'shape tokens (no Tier-0 utilities), per `motir-core/CLAUDE.md`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page renders the Panel-1 / Panel-2 / Panel-4 elements from the ' +
        '7.2.1 mockup, composed of the named primitives, referencing only ' +
        '`--el-*` + shape tokens (no Tier-0 utilities).\n' +
        '- Submitting a description streams a discovery interview live (tokens ' +
        'appear as they arrive over the 7.2.6 stream); answering or delegating ' +
        'a question posts the next turn and the interview continues.\n' +
        '- When discovery completes, the page surfaces/links the three ' +
        'direction docs (handing off to 7.2.8).\n' +
        '- A project that already has docs opens in the resume state, not a ' +
        'fresh interview.\n' +
        '- No client component calls the service layer directly — all AI ' +
        'traffic goes through the 7.2.6 routes; a11y (`aria-live` on streamed ' +
        'turns, keyboard-reachable controls) holds.\n\n' +
        '## Context refs\n\n' +
        '- 7.2.1 — the design asset this implements (every panel).\n' +
        '- 7.2.6 — `POST /api/ai/chat` + the `:jobId/stream` SSE route this ' +
        'consumes.\n' +
        '- `motir-core/app/(authed)/*` — the authed shell + the existing ' +
        'SSE-consuming client pattern (7.0 live badge) to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` + `[data-display-style]` ' +
        'tokens.\n' +
        '- `motir-core/CLAUDE.md` § colour / shape + Server/Client ' +
        'component conventions.',
      dependsOn: ['7.2.1', '7.2.6'],
    },
    {
      id: '7.2.8',
      title: 'Direction-docs render + light-edit view (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The view that renders the three direction docs and lets the user ' +
        'lightly edit them (Panel 3 of 7.2.1). The docs LIVE in motir-ai ' +
        '(7.2.4); motir-core fetches + writes them over the 7.1 boundary — ' +
        'it stores none of them locally (open-core line).\n\n' +
        '- **Read surface (motir-core → motir-ai).** A small internal ' +
        'read path over the 7.1.5 client to fetch the current direction docs ' +
        'for the active project (the latest version of each kind, from 7.2.4 ' +
        '`getCurrentDocs`). Mirrors the 7.1.6 read-back posture (job-scoped / ' +
        'service-credentialled, permission-checked as the requesting user); the ' +
        'route is server-to-service only, never CORS-exposed to browsers.\n' +
        '- **Write surface (light edit).** Saving an edited doc proxies a ' +
        'write to `directionDocsService.saveDoc` (7.2.4) over the same ' +
        'boundary, which lands as a NEW version (no destructive overwrite). The ' +
        'motir-core route is a thin proxy — 4-layer: route → a docs ' +
        'service → the 7.1.5 client; no `motir-ai` import, no Prisma.\n' +
        '- **UI.** Render vision / discovery / feasibility as Markdown ' +
        '(the shipped renderer) in the tabbed/columned layout 7.2.1 specifies, ' +
        'with the existing editable-field/inline-edit affordance for light ' +
        'edits, and the pinned-vs-delegated split visible in the discovery doc. ' +
        'Inline edits follow the inline-edit memory rule: a successful save IS ' +
        'the confirmation — NO whole-view `router.refresh()`/' +
        '`revalidatePath()` fan-out on the field-save success path.\n' +
        '- **The 7.3 hand-off CTA.** Render the "Looks right — generate ' +
        'the plan" button (drawn in 7.2.1) as a placeholder/disabled-until-7.3 ' +
        'affordance; the actual generate wiring is Story 7.3, NOT here (no ' +
        'forward dep — the button is inert until 7.3 lands its handler).\n' +
        '- **Tokens + i18n.** Only `--el-*` + shape tokens; doc-view strings in ' +
        'the `aiChat` namespace.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The view fetches the current three docs for the active project over ' +
        'the 7.1 boundary and renders each as Markdown per the 7.2.1 layout ' +
        '(referencing only `--el-*` + shape tokens).\n' +
        '- A light edit to a doc persists as a NEW version via 7.2.4 over the ' +
        'boundary; reloading shows the edit. The save success path does NOT ' +
        'trigger a whole-view refresh fan-out (inline-edit rule).\n' +
        '- The discovery doc visibly separates pinned decisions from delegated ' +
        'ones.\n' +
        '- The "generate the plan" CTA is present but inert (wired by 7.3); ' +
        '7.2.8 carries no dependency on 7.3.\n' +
        '- 4-layer respected: the docs read/write routes proxy via the 7.1.5 ' +
        'client; no `motir-ai` import, no Prisma, no AI table in motir-core; the ' +
        'read route is service-to-service only (never browser-CORS).\n\n' +
        '## Context refs\n\n' +
        '- 7.2.1 — the docs panel design (layout, edit affordance, the ' +
        'CTA).\n' +
        '- 7.2.4 — `directionDocsService.getCurrentDocs` / `saveDoc` (the ' +
        'data this view fetches + writes).\n' +
        '- 7.1.5 — the motir-core → motir-ai client; 7.1.6 — the ' +
        'read-back posture to mirror for the docs read.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the inline-edit / no-refresh-' +
        'fan-out rule (the field-update memory).\n' +
        '- The shipped Markdown renderer + editable-field primitives.',
      dependsOn: ['7.2.1', '7.2.4', '7.1.5'],
    },
    {
      id: '7.2.9',
      title: 'Vitest — discovery job + docs persistence + chat proxy',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Lock the discovery flow against drift at the unit/integration level ' +
        '(NOT browser E2E — that’s 7.2.10). Tests use a real Postgres ' +
        'on each side (no mocks — motir-core’s standing rule; mirror ' +
        'it in motir-ai), per `motir-core/CLAUDE.md`. The Anthropic call itself ' +
        'is the one boundary stubbed (a fake SDK transport returning canned ' +
        'tool-use turns / structured docs) so the suite is deterministic + ' +
        'offline — the DB, job substrate, and HTTP boundary stay real.\n\n' +
        '- **`DirectionDoc` store** (motir-ai) — `saveDoc` writes ' +
        'version 1 then version 2 on the same `(project, kind)` (no overwrite); ' +
        '`getCurrentDocs` returns the latest of each kind; an empty project ' +
        'returns an empty set, not an error (extends 7.2.4’s unit test).\n' +
        '- **`discovery` job** (motir-ai) — with the stubbed SDK ' +
        'transport: a complete pass drives `queued → running → ' +
        'succeeded` and persists three docs; a pass given an UNDER-specified ' +
        'prompt emits a discovery QUESTION turn rather than a fabricated stack/' +
        'deploy default (the no-unfit-default guarantee); a PIN vs a DELEGATE ' +
        'answer is reflected in the drafted discovery doc; a re-run on a ' +
        'project that already has docs writes a NEW version (resume, not ' +
        'duplicate); a missing/invalid Anthropic key fails the job cleanly per ' +
        'the 7.1.1 taxonomy.\n' +
        '- **Chat proxy** (motir-core) — `POST /api/ai/chat` submits a ' +
        '`discovery` job via the 7.1.5 client and returns the `jobId`; the ' +
        'stream route relays job events as SSE; auth holds (401 no session via ' +
        'the single allowed `getSession` mock; 404 cross-tenant project); ' +
        'upstream job errors map through the taxonomy into the right HTTP ' +
        'status.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All cases above pass; motir-core specs run green over a real ' +
        'Postgres, motir-ai specs over its real Postgres.\n' +
        '- The no-unfit-default case FAILS if the handler is made to fabricate ' +
        'a default instead of asking — proving the test guards the ' +
        'guarantee.\n' +
        '- No mocks beyond `getSession()` (motir-core) + the Anthropic SDK ' +
        'transport (the single external-LLM boundary) — every DB / job / ' +
        'HTTP path is real.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — e.g. ' +
        '`directionDocsService`’s empty-input guard has a direct test.\n\n' +
        '## Context refs\n\n' +
        '- 7.2.5 (the discovery handler) + 7.2.4 (the docs store) + 7.2.6 (the ' +
        'chat proxy) — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the coverage ' +
        'gate + the single-allowed-`getSession`-mock rule.\n' +
        '- 7.1.1 § error taxonomy (the failure-mapping under assertion).',
      dependsOn: ['7.2.5', '7.2.6'],
    },
    {
      id: '7.2.10',
      title: 'Playwright E2E — chat discovery flow → the 3 direction docs appear',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/ai-chat.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant, closing the front-door promise from the ' +
        'user’s seat: describe a project → answer the discovery ' +
        'interview → the three direction docs appear and are editable. The ' +
        'motir-ai planner is run against the same deterministic stubbed-SDK ' +
        'transport as 7.2.9 (canned discovery turns + canned docs) so the E2E ' +
        'is stable + offline — the test exercises the real chat UI, the ' +
        'real 7.2.6 proxy, the real job substrate, and the real docs DB.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager) via the ' +
        'existing `signIn` helper; navigate to the plan/chat front door for the ' +
        'active project.\n' +
        '2. Enter a one-paragraph project description; submit. Assert the ' +
        'discovery interview STREAMS (an assistant turn appears, including a ' +
        '"do you care?" decision question).\n' +
        '3. ANSWER one decision question (pin a choice) and DELEGATE another ' +
        '(tap "you decide"). Assert the interview proceeds after each.\n' +
        '4. When discovery completes, assert the three direction docs — ' +
        'vision / discovery / feasibility — are rendered (the 7.2.8 view), ' +
        'and the discovery doc shows BOTH the pinned and the delegated ' +
        'decision.\n' +
        '5. Light-edit one doc; reload; assert the edit persisted (the new-' +
        'version write through the boundary), and that the edit did NOT trigger ' +
        'a disruptive whole-view reload during save (inline-edit behavior).\n' +
        '6. (Resume) Re-open the chat for the same project; assert it opens in ' +
        'the resume state showing the saved docs, NOT a blank interview.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ai-chat` passes locally + in CI against the stubbed ' +
        'planner transport.\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper — ' +
        'no new auth plumbing invented.\n' +
        '- It asserts the streamed interview, the pin + delegate paths, the ' +
        'three docs appearing, an edit persisting across reload, and the resume ' +
        'state.\n' +
        '- Not flake-prone: explicit waits on `aria-live` for streamed turns ' +
        'and on the docs-rendered state (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.2.7 (the chat UI) + 7.2.8 (the docs view) — the surfaces ' +
        'under test.\n' +
        '- 7.2.9 — the stubbed-SDK transport reused for a deterministic ' +
        'planner.\n' +
        '- `motir-core/tests/e2e/*` + the `signIn` helper + the established ' +
        'Playwright SSE/`aria-live` waiting patterns to mirror.',
      dependsOn: ['7.2.7', '7.2.8'],
    },
  ],
};
