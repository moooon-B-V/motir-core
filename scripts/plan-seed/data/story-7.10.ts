import type { SeedStory } from '../types';

/**
 * Story 7.10 — Planning-mistakes store + the learning loop (the productized
 * `notes.html`). The capability that turns Motir's planner from a fixed prompt
 * into a system that REMEMBERS the lessons a real planning practice
 * accumulates — and the lessons a given tenant teaches it by correcting it.
 *
 * **What this productizes.** `motir-meta/notes.html` is a hand-kept log of 30+
 * planning mistakes ("Assumed Next.js without asking", "Omitted the design
 * system as a prerequisite", "Planned only the CODING subtasks", "Treated the
 * Subtask card as ground truth above the shipped schema", "Updated an entity
 * without locking the row", …) — each a *what-happened → what-corrected-me →
 * lesson → prompt-hint* quadruple. Today those lessons live in a static HTML
 * file a human curates and a planning agent reads by hand. Story 7.10 turns
 * that file into a real, first-class STORE inside motir-ai, INJECTS the
 * relevant lessons into the planner at plan time, and adds the feedback path
 * so a correction during planning becomes a NEW lesson — the loop that makes
 * the planner improve instead of repeating itself.
 *
 * **Where it lives — the THIRD stateful-motir-ai store (architecture #5).** Per
 * the locked Epic-7 architecture (story-7.1.ts header), motir-ai owns its OWN
 * Postgres holding the three context classes with no home in an open PM tool:
 * direction docs (7.2), the code graph (7.5/7.7), and — here — the
 * planning-mistakes knowledge. So `Lesson` is a motir-ai-side table on the
 * 7.1.3 Prisma foundation, NOT a motir-core table. This SHARPENS the open-core
 * line: motir-core stays a complete, exportable Jira clone with zero AI tables;
 * the learned-lessons knowledge is part of the closed, stateful planning brain.
 * The only motir-core surface is the admin VIEW (7.10.6), which reads the store
 * over the 7.1 boundary like every other motir-core→motir-ai call.
 *
 * **Two scopes — the global base set vs. tenant-taught lessons.** Mirroring how
 * agentic planners separate shared knowledge from per-context preference
 * (verified, see below), a `Lesson` carries a `scope`:
 *   - **`global`** — the curated BASE set ported from notes.html. Shipped with
 *     the product, injected for every tenant, owned by the Motir team. These are
 *     the durable craft lessons ("discovery before stack defaults"; "design is a
 *     prerequisite, not a peer"; "plan the non-code subtasks too").
 *   - **`tenant`** — lessons a SPECIFIC workspace/project taught the planner by
 *     correcting it (the capture loop, 7.10.4). Injected only for that tenant.
 *     This is where a customer's house style accumulates ("we always ship a
 *     feature flag with a new endpoint"; "our designers own copy, never the
 *     planner").
 *
 * **Mirror (rung 1, VERIFIED — not asserted).** Atlassian's **Rovo Dev CLI
 * memory** is the closest direct mirror and it matches this shape almost
 * one-for-one: it keeps **two scopes** — *user memory* (`~/.rovodev/AGENTS.md`,
 * applies to every session = our `global` base set) and *project memory*
 * (`AGENTS.md` in the workspace = our `tenant` scope); it captures lessons two
 * ways — **manual** (`/memory` add/edit) and **automatic reflection**
 * (`/memory reflect`, which "analyzes the current session to identify mistakes,
 * inefficiencies, or suboptimal choices" and writes them back) — exactly our
 * curated-base (7.10.2) + correction-capture (7.10.4) split; and it INJECTS
 * hierarchically at runtime (user memory first, then project) — our
 * global-then-tenant injection (7.10.3). The broader agent-memory field frames
 * the same thing as **procedural memory** ("learned behaviors / decision
 * logic") layered under **semantic memory** (durable facts/preferences), and
 * the canonical capture mechanism is **session-level reflection** — the agent
 * analyzes an interaction, identifies the preference/lesson, and persists it.
 * Tools in this space (Mem0, AWS AgentCore long-term memory, OpenClaw's
 * `MEMORY.md`) all converge on store-once / retrieve-relevant / consolidate.
 * Motir's deviation from those: it is **graph/structured, not a vector dump**
 * (consistent with architecture #3 — the planner already runs a tool-use loop,
 * so lessons are RETRIEVED as structured records and injected into system
 * context, not RAG-stuffed). We inject the relevant lessons as structured
 * `Lesson` rows, scoped + ranked, into the 7.3.2/7.4 system context.
 *
 * **This is an ENHANCEMENT — 7.3 does NOT hard-depend on it (dep audit).** The
 * generation engine (7.3) runs perfectly with an empty lesson set; 7.10 makes
 * it *better*, not *possible*. So 7.10 depends BACKWARD on 7.1.3 (the motir-ai
 * DB the store sits on) and 7.3.2 (the planner loop it injects into) — never
 * the reverse. Every `dependsOn` here points at 7.1.x / 7.3.2 / same-story
 * 7.10.x; nothing in 7.3/7.4 points back at 7.10. Cross-story dep audit
 * (notes.html #32): PASSES.
 *
 * **The design gate fires for the lessons admin view (7.10.5 → 7.10.6).** The
 * mistakes store + injection + capture are all server-side (no pixels). But the
 * tenant needs to SEE and CURATE its lessons — view the global base set, read
 * the tenant lessons the capture loop wrote, edit/disable a lesson that has gone
 * stale. That is a real motir-core UI surface, so it carries its own
 * `type: design` subtask FIRST (7.10.5, AREA `design/ai-admin/`, deps [],
 * `planned`), and the admin UI (7.10.6) depends on it and is `blocked`. No
 * improvised admin screen (notes.html #31 — the design-gate rule).
 *
 * **TWO self-improving mechanisms — inward (capture-own-mistake) + outward
 * (analyze-cross-project-bugs).** The store is only half a quality system; the
 * loops that make Motir actually improve are two distinct, complementary
 * mechanisms, and they must not be conflated:
 *
 * **(1) INWARD — the planner captures ITS OWN mistake → a bug in THAT project
 * (7.10.8).** Capturing a lesson is only HALF the inward loop — a lesson the
 * planner notes but nobody can act on is a private regret. So when the capture
 * loop (7.10.4) records a mistake DURING planning, motir-ai ALSO files a
 * `kind: bug` work item INTO THE PROJECT BEING PLANNED (7.10.8) — the planning
 * gap becomes a trackable, fixable, assignable item in the very backlog the
 * planner manages. This is **Motir using Motir on Motir**: the planner files
 * bugs about its OWN planning mistakes through the same write authority an
 * agent uses. The mechanism is GENERAL (any tenant's project), but the FIRST /
 * canonical instance is Motir's own planner, while building Motir, filing bugs
 * into the live `motir` / `PROD` project — the dogfood that proves the inward
 * loop end-to-end: mistake captured → `create_work_item` → a bug appears in the
 * tracker the team already watches. It is the FIRST self-improving mechanism:
 * the quality loop is demonstrated by turning the tool on itself.
 *
 * **(2) OUTWARD — analyze a bug raised in a USER's project → if Motir-caused,
 * a meta-bug in motir/PROD (7.10.9 + 7.10.10).** The inward loop only fires
 * when the planner CATCHES itself mid-plan. But the overwhelming majority of
 * Motir's failures surface LATER and ELSEWHERE: a user (or their coding agent)
 * files a `kind: bug` in their OWN project because something Motir planned or an
 * agent Motir dispatched went wrong in the real world. The SECOND mechanism
 * harvests those. When a `kind: bug` work item is created in ANY project OTHER
 * than motir's own (the trigger is a bug-created event on the shipped Story-1.6
 * Inngest cron/job pipeline — `work-item/created` with `kind: bug`), motir-ai
 * is triggered to ANALYZE the bug and classify its root cause into one of three
 * buckets: **planning mistake** (the plan was wrong — a missing subtask, a bad
 * dependency, an unconsidered prerequisite) | **coding-agent mistake** (the plan
 * was sound but the dispatched agent mis-executed — the 7.6 dispatch prompt /
 * the 7.7 PR-status context tells this apart from a planning fault) |
 * **out-of-scope** (a genuine user/product bug — Motir is NOT at fault, no
 * action). If — and only if — the conclusion is a Motir planning- or
 * coding-agent mistake, motir-ai logs a `kind: bug` work item in the
 * **motir / PROD** project so Motir's own team fixes the ROOT CAUSE in Motir's
 * planner / agent system, AND captures the lesson (7.10.4) so the planner
 * itself learns. This is how Motir improves its planner + agents from REAL
 * failures aggregated across its WHOLE user base — failure telemetry, productized.
 *
 * **The two, contrasted (do not conflate them).**
 *   - 1st (7.10.8): Motir catches its OWN mistake during planning → bug filed in
 *     THAT project (the project being planned). Trigger: the 7.10.4 capture.
 *   - 2nd (7.10.9/10): a bug appears in a USER's project → motir-ai ANALYZES it
 *     → if Motir-caused → bug filed in MOTIR / PROD (the meta-improvement / the
 *     failure-telemetry loop that improves Motir itself). Trigger: a
 *     bug-created event on the 1.6 pipeline.
 *
 * **CRITICAL — privacy / cross-tenant sanitization (the open-core line holds).**
 * The meta-bug the SECOND mechanism files into motir/PROD is CROSS-TENANT
 * telemetry — it leaves the user's tenant and lands in Motir's own project. So
 * it MUST be SANITIZED: it carries ONLY the abstracted ROOT-CAUSE signal (the
 * planner/agent flaw as a transferable pattern — "the planner omits a feature-
 * flag prerequisite for new endpoints"), NEVER the user's confidential code,
 * project names, identifiers, issue text, or any reconstructable detail. This
 * is the same per-tenant-isolation + open-core posture every Epic-7 store
 * already holds (the 6.4 permission model + the 7.1 boundary): the only thing
 * that crosses tenants is the de-identified lesson about Motir's OWN system. The
 * inward bug (7.10.8) stays IN-tenant and needs no sanitization; the outward bug
 * (7.10.10) is sanitized by construction and idempotent (one meta-bug per
 * distinct abstracted root cause — no re-file for the same flaw across many
 * users hitting it).
 *
 * **The write path — the AI never writes directly (architecture #1).** Per the
 * locked 7.1 boundary, motir-ai holds NO write credential to the plan tree; it
 * REQUESTS a create through motir-core's write authority. The bug is filed via
 * the SAME core-side path every other write rides: the MCP `create_work_item`
 * tool (Story 7.8 — verified the `kind: bug` bug-logging tool, the "agents log
 * bugs via the Motir MCP" protocol) and/or the 7.1.6 persist callback
 * (`POST /api/internal/ai/plan-delta`, committed through `workItemsService`
 * with every 6.4 permission + tenant guard). Both are motir-core authority; the
 * AI proposes, core persists. So 7.10.8 depends BACKWARD on 7.8.5 (the
 * `create_work_item` tool, 7.8 < 7.10 — no forward dep) and 7.10.4 (the capture
 * that triggers it).
 *
 * **Scope (the ten cards).** the `Lesson` store schema + repo/service on the
 * motir-ai DB (7.10.1); the curated BASE lesson set ported from notes.html as
 * seed content (7.10.2, `type: content`); injecting the relevant lessons into
 * the planner at plan time inside the 7.3.2/7.4 loop (7.10.3); the capture loop
 * where a correction becomes a new tenant lesson (7.10.4); the lessons admin
 * view design (7.10.5) + the admin UI in motir-core (7.10.6); the test suite
 * over store + injection + capture (7.10.7); the FIRST (inward) self-improving
 * mechanism that turns a captured mistake into a `kind: bug` work item in the
 * project being planned (7.10.8); and the SECOND (outward) self-improving
 * mechanism — the cross-project bug ROOT-CAUSE classifier (7.10.9) and the
 * 1.6-event trigger that, when the classifier blames Motir, files the SANITIZED
 * meta-bug into motir/PROD and captures the lesson (7.10.10).
 *
 * **Out of scope (named so they don't silently expand this story):** no vector
 * store / embedding retrieval (architecture #3 — lessons are structured records
 * injected into system context, ranked by scope + relevance heuristics, not RAG;
 * a future relevance-ranking upgrade is additive behind the same store); no
 * cross-tenant lesson sharing or a "promote a tenant lesson to global" workflow
 * (a Motir-team curation tool, not a tenant feature — lands later if ever); no
 * automatic editing of the notes.html FILE (the file becomes the seed input
 * once, in 7.10.2; thereafter the STORE is the source of truth and notes.html is
 * historical); the prompt-generation moat (7.6) and the discovery docs (7.2) are
 * SEPARATE context stores — 7.10 is the mistakes store only.
 */
export const story_7_10: SeedStory = {
  id: '7.10',
  title: 'Planning-mistakes store + learning loop (productized notes.html)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.10-mistakes-store',
  descriptionMd:
    'Turn the hand-kept `motir-meta/notes.html` planning-mistakes log into a ' +
    'real, first-class **lessons store** inside motir-ai, inject the relevant ' +
    'lessons into the planner at plan time, and close the **learning loop**: a ' +
    'correction made during planning becomes a NEW tenant-scoped lesson, so the ' +
    'planner improves instead of repeating itself.\n\n' +
    '**The third stateful-motir-ai store (locked architecture #5).** motir-ai ' +
    'owns its own Postgres for the three context classes with no home in an ' +
    'open PM tool — direction docs (7.2), the code graph (7.5/7.7), and the ' +
    'planning-mistakes knowledge **here**. `Lesson` is a motir-ai-side table on ' +
    'the 7.1.3 foundation, NOT a motir-core table — motir-core stays a complete ' +
    'exportable Jira clone with zero AI tables. The only motir-core surface is ' +
    'the admin VIEW, which reads the store over the 7.1 boundary.\n\n' +
    '**Two scopes (the verified Rovo-memory mirror).** A `Lesson` is ' +
    '`scope: global | tenant`. **`global`** = the curated BASE set ported from ' +
    'notes.html, injected for every tenant (Rovo *user memory*: applies to every ' +
    'session). **`tenant`** = lessons a specific workspace/project taught the ' +
    'planner by correcting it, injected only for that tenant (Rovo *project ' +
    'memory*). Capture is two-way — the curated base (7.10.2, the manual seed) + ' +
    'the correction-capture loop (7.10.4, Rovo `/memory reflect`: "analyze the ' +
    'session to identify mistakes/inefficiencies and write them back").\n\n' +
    '**TWO self-improving mechanisms (do not conflate them).** Capturing a lesson ' +
    'is only half a quality system; the loops that make Motir improve are two ' +
    'distinct mechanisms. **(1) INWARD (7.10.8):** when a mistake is captured ' +
    'DURING planning (7.10.4), motir-ai ALSO files a `kind: bug` work item into ' +
    'the PROJECT BEING PLANNED, turning the planning gap into a trackable backlog ' +
    'item — the planner files bugs about its OWN mistakes (Motir on Motir; the ' +
    'canonical first instance is the live `motir`/`PROD` project while building ' +
    'Motir). **(2) OUTWARD (7.10.9 + 7.10.10):** when a `kind: bug` is created in ' +
    'ANY OTHER project (NOT motir) — the trigger is a bug-created event on the ' +
    'shipped Story-1.6 Inngest cron/job pipeline (`work-item/created`, ' +
    '`kind: bug`) — motir-ai ANALYZES the bug and classifies its root cause as ' +
    '**planning mistake | coding-agent mistake | out-of-scope** (a genuine ' +
    'user/product bug, not Motir’s fault). If — and only if — the conclusion ' +
    'is a Motir planning- or coding-agent mistake, motir-ai logs a `kind: bug` in ' +
    'the **motir / PROD** project so Motir’s own team fixes the ROOT CAUSE in ' +
    'the planner/agent system, AND captures the lesson (7.10.4). This is how Motir ' +
    'improves its planner + agents from REAL failures aggregated across its whole ' +
    'user base — failure telemetry, productized.\n\n' +
    '**Privacy / cross-tenant sanitization (the open-core line holds).** The ' +
    'OUTWARD meta-bug filed into motir/PROD is cross-tenant telemetry, so it ' +
    'carries ONLY the abstracted ROOT-CAUSE signal (the planner/agent flaw as a ' +
    'transferable pattern), NEVER the user’s confidential code, project names, ' +
    'identifiers, or issue text — the same per-tenant-isolation + open-core ' +
    'posture every Epic-7 store holds (6.4 permissions + the 7.1 boundary). It is ' +
    'idempotent: one meta-bug per distinct abstracted root cause (no re-file for ' +
    'the same flaw across many users). The INWARD bug (7.10.8) stays IN-tenant and ' +
    'needs no sanitization. Both ride motir-core write authority — the AI never ' +
    'writes directly (architecture #1): the 7.8.5 MCP `create_work_item` tool ' +
    'and/or the 7.1.6 persist callback.\n\n' +
    '**This is an ENHANCEMENT — 7.3 does not hard-depend on it.** Generation ' +
    'runs with an empty lesson set; 7.10 makes it better, not possible. Every ' +
    'dep points BACKWARD at 7.1.3 (the motir-ai DB), 7.3.2 (the planner loop it ' +
    'injects into), 7.8.5 (the create-work-item write path the self-improving ' +
    'bugs ride — 7.8 < 7.10), the SHIPPED Story-1.6 event pipeline (the outward ' +
    'trigger), or same-story 7.10.x. No forward dep (Epic-9 hosted runs are an ' +
    'additive context source for the coding-agent-mistake classification, named ' +
    'in prose only, never depended on). Cross-story dep audit: PASSES.\n\n' +
    '**Scope:** the `Lesson` store schema + repo/service on motir-ai (7.10.1); ' +
    'the curated base set ported from notes.html (7.10.2, content); plan-time ' +
    'injection into the 7.3.2/7.4 loop (7.10.3); the correction → new tenant ' +
    'lesson capture loop (7.10.4); the lessons admin view design (7.10.5) + the ' +
    'motir-core admin UI (7.10.6); the test suite (7.10.7); the INWARD ' +
    'self-improving auto-file-a-bug-on-capture mechanism (7.10.8); the OUTWARD ' +
    'cross-project bug root-cause classifier (7.10.9) + the 1.6-event trigger ' +
    'that files the SANITIZED Motir-caused meta-bug into motir/PROD and captures ' +
    'the lesson (7.10.10).\n\n' +
    '**Out of scope (named so they land elsewhere, not here):** a vector store / ' +
    'embedding retrieval (architecture #3 — lessons are STRUCTURED records ' +
    'injected into system context, ranked by scope + relevance heuristics, not ' +
    'RAG); cross-tenant sharing or a "promote tenant lesson to global" curation ' +
    'workflow (a Motir-team tool, not a tenant feature); auto-editing the ' +
    'notes.html FILE (it is the one-time seed input in 7.10.2; thereafter the ' +
    'STORE is the source of truth); the prompt-generation moat (7.6) and the ' +
    'direction docs (7.2) — separate context stores.',
  verificationRecipeMd:
    '- **Store + base set.** With motir-ai running against its own Postgres ' +
    '(7.1.3) and the base lessons seeded (7.10.2): query the `Lesson` table → ' +
    'the curated global lessons ported from notes.html are present, each with ' +
    '`title` / `body` / `why` / `howToApply` populated and `scope = global`.\n' +
    '- **Injection (the moat).** Submit a `generate_tree` job for a fresh ' +
    'project whose intent would trip a known lesson (e.g. "build me a Spring Boot ' +
    'service" — the notes.html #1 "assumed Next.js" lesson, and "don\'t plan only ' +
    'the coding subtasks" #29). Inspect the planner\'s assembled system context ' +
    '(captured in the job record / a test hook): the relevant global lessons ' +
    'appear in it, scoped + ranked; irrelevant ones are pruned (we do NOT stuff ' +
    'all 30 every job). The produced tree reflects the lesson (it asks the ' +
    'discovery question / includes the non-code subtasks) rather than the ' +
    'pre-lesson default.\n' +
    '- **Capture loop.** During a planning run, register a correction (the ' +
    '7.10.4 path — e.g. the human edits/rejects a delta with a reason, or the ' +
    'planner self-reflects a suboptimal choice). A new `Lesson` row appears with ' +
    '`scope = tenant` bound to that workspace/project, with the correction as ' +
    '`why` and the derived rule as `howToApply`. Re-running a similar plan for ' +
    'the SAME tenant now injects that tenant lesson; a DIFFERENT tenant does NOT ' +
    'see it (scope isolation).\n' +
    '- **Admin view.** In motir-core, signed in as the project manager, open the ' +
    'lessons admin surface (7.10.6): the global base set renders read-leaning, ' +
    'the tenant lessons render editable; edit a tenant lesson → it persists ' +
    'through the 7.1 boundary into motir-ai; disable a lesson → it stops being ' +
    'injected (verify by re-running a plan). A non-PM workspace member is gated ' +
    'per the 6.4 permission the surface adopts.\n' +
    '- `pnpm test` (motir-ai) — 7.10.7 covers the store CRUD + scope isolation, ' +
    'the injection selection (relevant-in / irrelevant-out, scope precedence), ' +
    'and the capture path (a correction yields exactly one tenant lesson, bound ' +
    'to the right tenant, idempotent on a repeated identical correction).\n' +
    '- **The INWARD self-improving loop (the dogfood, 7.10.8).** Capture a ' +
    'mistake during a planning run (the 7.10.4 path) → a NEW `kind: bug` work ' +
    "item appears in the project's backlog describing the planning gap (filed " +
    'through motir-core write authority — the 7.8.5 `create_work_item` tool / ' +
    'the 7.1.6 persist callback, NOT a direct AI write), linked to the tenant ' +
    'lesson, reporter = the planner identity. Re-capturing the SAME mistake does ' +
    'NOT file a second bug (idempotent — one bug per distinct lesson). Run it ' +
    'against the live `motir` / `PROD` project itself: the planner files a bug ' +
    'about its own planning mistake into the tracker the team already watches ' +
    '(Motir on Motir, the canonical first instance).\n' +
    '- **The OUTWARD self-improving loop (cross-project failure telemetry, ' +
    '7.10.9 + 7.10.10).** In a NON-motir tenant project, create a `kind: bug` ' +
    'work item describing a failure whose root cause is a planning gap (e.g. "the ' +
    'endpoint shipped with no feature flag" — a missing-prerequisite planning ' +
    'fault). The Story-1.6 bug-created event fires → motir-ai analyzes it (7.10.9) ' +
    '→ classifies the root cause **planning mistake** → a SANITIZED `kind: bug` ' +
    'appears in the **motir / PROD** project (7.10.10) carrying ONLY the ' +
    'abstracted flaw, with NO trace of the user’s code / project name / issue ' +
    'text (inspect the meta-bug body — it is de-identified), AND a lesson is ' +
    'captured (7.10.4). File a SECOND user bug with the same abstracted root ' +
    'cause → NO second meta-bug in PROD (idempotent on the abstracted cause). ' +
    'File a bug whose root cause is a genuine USER/product defect → classified ' +
    '**out-of-scope**, NO meta-bug filed (Motir is not at fault). File a bug ' +
    'inside the `motir` project ITSELF → the outward analyzer SKIPS it (the ' +
    'inward loop owns motir’s own mistakes; no self-referential meta-bug).\n' +
    '- **Open-core + cross-tenant privacy check (the recurring Epic-7 posture).** ' +
    "Confirm the `Lesson` table exists ONLY in motir-ai (no lessons table in motir-core's " +
    'schema); the admin UI reaches it solely over the 7.1 boundary (no `motir-ai` ' +
    'import in motir-core, no shared DB). The learned-lessons knowledge is part ' +
    'of the closed planning brain. And confirm the OUTWARD meta-bug (7.10.10) is ' +
    'SANITIZED: nothing crosses from a user tenant into motir/PROD except the ' +
    'abstracted root-cause signal — no user code / project name / key / issue ' +
    'text (per-tenant isolation holds, the 6.4 + 7.1 posture).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    "comment with what didn't work and Motir will produce a follow-up Subtask " +
    'under the same Story.',
  items: [
    {
      id: '7.10.1',
      title: 'The mistakes store — `Lesson` schema + repo/service on the motir-ai DB',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Stand up the planning-mistakes store as the THIRD context store on ' +
        "motir-ai's own Postgres (the 7.1.3 Prisma foundation) — alongside " +
        'direction docs (7.2) and the code graph (7.5/7.7). This is a ' +
        'motir-ai-side table; motir-core never gets a lessons table (the ' +
        'open-core boundary stays clean).\n\n' +
        'Add the **`Lesson`** model:\n\n' +
        '```prisma\n' +
        '// motir-ai/prisma/schema.prisma\n' +
        'model Lesson {\n' +
        '  id           String       @id @default(cuid())\n' +
        '  scope        LessonScope  // global | tenant\n' +
        '  // null for global; set to the AiProject for a tenant lesson\n' +
        '  aiProjectId  String?\n' +
        '  aiProject    AiProject?   @relation(fields: [aiProjectId], references: [id], onDelete: Cascade)\n' +
        '  title        String       // one-line name ("Discovery before stack defaults")\n' +
        '  body         String       // the lesson itself (the notes.html "Lesson" prose)\n' +
        '  why          String       // what-happened / what-corrected-me — the rationale\n' +
        '  howToApply   String       // the actionable rule the planner follows (the notes.html "prompt-hint")\n' +
        '  sourceRef    String?      // provenance: "notes.html #1" for base lessons; a job/correction id for captured ones\n' +
        '  enabled      Boolean      @default(true)  // a disabled lesson is never injected (7.10.6 toggles this)\n' +
        '  createdAt    DateTime     @default(now())\n' +
        '  updatedAt    DateTime     @updatedAt\n' +
        '  @@index([scope, aiProjectId, enabled])\n' +
        '}\n' +
        '\n' +
        'enum LessonScope { global tenant }\n' +
        '```\n\n' +
        'The four content fields mirror the notes.html quadruple exactly so the ' +
        'port (7.10.2) is a clean field map: `title` ← mistake-title, `body` ← ' +
        'the Lesson prose, `why` ← what-happened + what-corrected-me, ' +
        '`howToApply` ← the prompt-hint. A **global** lesson has ' +
        '`aiProjectId = null` and is injected for every tenant; a **tenant** ' +
        'lesson is bound to an `AiProject` and injected only there (the ' +
        'Rovo user-memory vs project-memory split). `enabled` is the disable ' +
        'flag the admin view flips — a stale lesson is disabled, never hard ' +
        'deleted (we keep provenance + an audit trail).\n\n' +
        'Layer it the way 7.1.3 established on the closed side (mirror ' +
        "motir-core's Route→Service→Repository spirit lightly):\n\n" +
        '- **`lessonRepository`** — single-op Prisma access: `create` (write, ' +
        'takes `tx`), `update`, `setEnabled`, `findById`, ' +
        '`listForInjection(aiProjectId)` (global + this-tenant, enabled only, ' +
        'one query), `listForAdmin(aiProjectId, cursor, limit)` (cursor-' +
        'paginated — the base set alone is 30+ and tenant lessons grow ' +
        'unbounded; NO "load all rows", the planning-time scale check).\n' +
        '- **`lessonService`** — business logic: create-from-base (idempotent ' +
        'upsert keyed on `sourceRef` so re-seeding the base set does not ' +
        'duplicate), create-from-correction (7.10.4 calls this), the ' +
        'list-for-injection selection contract (7.10.3 consumes), enable/disable, ' +
        'edit. Returns DTOs, not raw Prisma rows.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains the `Lesson` model + ' +
        '`LessonScope` enum with a migration; `pnpm prisma generate` + ' +
        '`pnpm migrate` run clean against the local docker Postgres.\n' +
        '- A `global` lesson has `aiProjectId = null`; a `tenant` lesson ' +
        'references an `AiProject` and cascades on its delete.\n' +
        '- `lessonRepository` write methods require `tx`; ' +
        '`listForInjection(aiProjectId)` returns global + that-tenant enabled ' +
        'lessons in ONE query; `listForAdmin` is cursor-paginated (default 50, ' +
        'capped) — no unbounded load.\n' +
        '- `lessonService.createFromBase` is idempotent on `sourceRef` ' +
        '(re-seeding does not duplicate) and returns DTOs.\n' +
        '- The `Lesson` table exists ONLY in motir-ai — no lessons table in ' +
        "motir-core's schema; no motir-core DB connection in motir-ai.\n\n" +
        '## Context refs\n\n' +
        '- `motir-ai/prisma/schema.prisma` + the `AiProject` spine from 7.1.3 ' +
        '(the per-tenant identity a tenant lesson hangs off).\n' +
        '- story-7.1.ts header §4 (motir-ai is stateful; the three context ' +
        'stores; this is the third).\n' +
        '- `motir-meta/notes.html` — the field shape the four columns mirror ' +
        '(mistake-title / what-happened / what-corrected-me / lesson / ' +
        'prompt-hint).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer — the Route→Service→Repository ' +
        'pattern motir-ai mirrors lightly.',
      dependsOn: ['7.1.3'],
    },
    {
      id: '7.10.2',
      title: 'Curated BASE lesson set — port notes.html into seed data for the store',
      status: 'blocked',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** content (the curated knowledge that makes the store useful on ' +
        'day one — the Rovo *user-memory* base set, applied for every tenant). ' +
        'Port the 30+ planning mistakes from `motir-meta/notes.html` into ' +
        'structured `Lesson` seed rows, all `scope: global`.\n\n' +
        '`motir-meta/notes.html` is a log of *what-happened → what-corrected-me ' +
        '→ lesson → prompt-hint* quadruples — e.g. #1 "Assumed Next.js without ' +
        'asking" (lesson: stack is a discovery-phase question, not a planning ' +
        'default), #3 "Omitted the design system as a prerequisite", #4 "design ' +
        'Subtasks placed as peers, not prerequisites" (the design gate), #10 ' +
        '"Omitted subtask dependencies; ordering was implicit", #14 "Estimated ' +
        'in human-developer days, not coding-agent units", #28 "Ranked the ' +
        'Subtask card above ground truth", #29 "Planned only the CODING ' +
        'subtasks", #30 "generalized list-pagination onto the board without ' +
        'checking the mirror", #31 "name evaluation aesthetics-first without the ' +
        'legal gate", #32 "updated an entity without locking the row". Each maps ' +
        'cleanly onto the 7.10.1 fields.\n\n' +
        'Author `motir-ai/prisma/seed/lessons.base.ts` — a typed array of base ' +
        'lessons, one per notes.html mistake, each with:\n\n' +
        '- `title` ← the `mistake-title`.\n' +
        '- `body` ← the `Lesson:` prose (the durable rule).\n' +
        '- `why` ← a tight synthesis of *what-happened* + *what-corrected-me* ' +
        '(so the planner — and a human in the admin view — sees the rationale, ' +
        'not just the rule).\n' +
        '- `howToApply` ← the `prompt-hint` (the actionable instruction the ' +
        'planner follows).\n' +
        '- `sourceRef: "notes.html #<n>"` (provenance + the idempotency key for ' +
        '`createFromBase`).\n\n' +
        'Wire it into the motir-ai seed path so `pnpm db:seed` (or equivalent) ' +
        'upserts the base set via `lessonService.createFromBase` (idempotent on ' +
        '`sourceRef` — re-seeding refreshes copy without duplicating). **Edit ' +
        'for the planner audience, do NOT copy verbatim**: notes.html is written ' +
        'first-person retrospective ("I generated Stories assuming…"); the ' +
        '`howToApply` must be a second-person imperative the planner can act on ' +
        '("Detect whether the user has stack opinions in discovery; never emit a ' +
        'create-next-app story unless Next.js was confirmed"). Generalize ' +
        'Motir-internal references (file names, PR numbers) into transferable ' +
        "craft rules — a base lesson must make sense for ANY tenant's project, " +
        'not just building Motir itself.\n\n' +
        'Cross-cutting principles that recur in notes.html (the design gate, ' +
        'discovery-before-defaults, plan-the-non-code-subtasks, ' +
        "check-the-mirror-don't-assert, no-shortcuts/durable-shape, " +
        'lock-before-read-derived-update) get one strong, deduplicated lesson ' +
        'each rather than one per occurrence — the store is a curated set, not a ' +
        'raw dump.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/seed/lessons.base.ts` exists with one base `Lesson` ' +
        'per distinct notes.html mistake (30+), all `scope: global`, each with ' +
        '`title` / `body` / `why` / `howToApply` / `sourceRef` populated.\n' +
        '- `howToApply` is a second-person, planner-actionable imperative ' +
        '(NOT first-person retrospective); Motir-internal references are ' +
        'generalized into transferable rules.\n' +
        '- Seeding upserts via `lessonService.createFromBase` — idempotent on ' +
        '`sourceRef`; re-seeding does not duplicate.\n' +
        '- Recurring cross-cutting principles are deduplicated into one strong ' +
        'lesson each (not one row per occurrence).\n' +
        '- A smoke test asserts the seeded count + that a spot-checked lesson ' +
        '(e.g. notes.html #1, the Next.js-assumption lesson) round-trips with all ' +
        'four fields.\n\n' +
        '## Context refs\n\n' +
        '- `motir-meta/notes.html` — the source log (the `mistake-title` / ' +
        'sections / `lesson` / `prompt-hint` structure to map from).\n' +
        '- 7.10.1 — the `Lesson` field shape + `lessonService.createFromBase` ' +
        '(the idempotent upsert this calls).\n' +
        '- `motir-ai/prisma/seed/*` — the existing motir-ai seed convention ' +
        '(from 7.1.3) to extend.',
      dependsOn: ['7.10.1'],
    },
    {
      id: '7.10.3',
      title: 'Inject relevant lessons into the planner at plan time (the 7.3.2/7.4 loop)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Wire the lessons store into the planning agent so the planner ACTS on ' +
        'the accumulated lessons instead of repeating the mistakes they encode. ' +
        'This is the value of the whole story: the moat is not the store, it is ' +
        'the lessons reaching the model at generation time.\n\n' +
        'Inside motir-ai, when the `generate_tree` (7.3.2) and the 7.4 ' +
        'augment/expand/replan jobs assemble their system context, call ' +
        '`lessonService.selectForInjection(aiProjectId, jobContext)` and fold the ' +
        "selected lessons into the planner's system prompt as a structured " +
        '"Planning lessons to apply" section (each lesson rendered as ' +
        'title + howToApply, with `why` available on demand).\n\n' +
        '**Selection (NOT a vector dump — architecture #3).** Consistent with ' +
        'the graph/structured-not-RAG posture, lessons are selected as STRUCTURED ' +
        'records, not retrieved from an embedding index:\n\n' +
        '1. **Scope.** Always include enabled `global` lessons (the base craft ' +
        "set); include this tenant's enabled `tenant` lessons. Tenant lessons " +
        'rank ABOVE global on a tie (the local correction is more specific — the ' +
        'Rovo user-then-project precedence, applied in reverse for specificity: ' +
        'the tenant taught us this directly).\n' +
        '2. **Relevance + budget.** Do NOT stuff all 30+ every job — that burns ' +
        'context and dilutes signal. Rank by a cheap, auditable heuristic ' +
        "(keyword/section overlap between the lesson and the job's intent + " +
        'jobKind; e.g. a `generate_tree` for a backend service surfaces the ' +
        'stack-discovery + non-code-subtask + design-gate lessons) and cap at a ' +
        'budget. The ranker is behind the service interface so a future ' +
        'embedding-ranking upgrade is a drop-in (the store + injection seam stays ' +
        'stable — durable shape, no shortcut).\n' +
        '3. **Record what was injected** in the job record (for the 7.10.7 test ' +
        'and the verification recipe — injection must be inspectable, not a black ' +
        'box).\n\n' +
        'Define `LessonInjection` as the structured unit the planner consumes so ' +
        'both the 7.3.2 and 7.4 handlers fold it in the same way (one helper, two ' +
        'call sites — no divergence). This is additive to the planner loop: with ' +
        'an empty store it injects nothing and generation is unchanged (the ' +
        'enhancement property — 7.3 never hard-depends on 7.10).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `generate_tree` (7.3.2) and the 7.4 jobs call ' +
        '`selectForInjection(aiProjectId, jobContext)` and fold the result into ' +
        'the planner system context via ONE shared helper (no per-handler ' +
        'divergence).\n' +
        "- Selection always includes enabled `global` lessons + this tenant's " +
        'enabled `tenant` lessons; a disabled lesson is never injected; another ' +
        "tenant's lessons are never injected (scope isolation).\n" +
        '- Relevant lessons rank in and irrelevant ones are pruned to a budget ' +
        '(NOT all 30+ every job); tenant lessons rank above global on a tie; the ' +
        'ranker sits behind the service interface (swappable).\n' +
        '- The set of injected lesson ids is recorded on the job record ' +
        '(inspectable).\n' +
        '- With an EMPTY store, injection is a no-op and generation output is ' +
        'unchanged (the enhancement property).\n\n' +
        '## Context refs\n\n' +
        '- 7.10.1 — `lessonService` + `listForInjection` (the store this reads).\n' +
        '- Story 7.3 (stub) 7.3.2 — the `generate_tree` planner loop / system-' +
        'context assembly this injects into.\n' +
        '- Story 7.4 (stub) — the augment/expand/replan jobs that share the ' +
        'injection helper.\n' +
        '- story-7.1.ts header §2–3 — the tool-use session + ' +
        'graph/structured-not-RAG posture this selection respects.',
      dependsOn: ['7.10.1', '7.3.2'],
    },
    {
      id: '7.10.4',
      title: 'The capture loop — a correction during planning becomes a new tenant lesson',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Close the learning loop: when a planning run is CORRECTED, distill the ' +
        'correction into a new `scope: tenant` `Lesson` so the planner stops ' +
        'making that mistake for that tenant. This is the feedback path that ' +
        "makes the planner improve over time — the direct mirror of Rovo Dev's " +
        '`/memory reflect` ("analyze the session to identify mistakes, ' +
        'inefficiencies, or suboptimal choices" and write them back into project ' +
        "memory) and the agent-memory field's **session-level reflection** " +
        '(analyze an interaction → identify the lesson → persist it as procedural ' +
        'memory).\n\n' +
        '**What counts as a correction (the trigger).** A tenant correction is ' +
        'captured when, during a planning job, the human REJECTS or EDITS the ' +
        'proposed tree-delta with a stated reason at the review/approve step ' +
        '(the 7.3 generate→approve gate is where corrections naturally surface). ' +
        'The reason + the diff between proposed and approved is the raw material ' +
        'for the lesson. (A pure self-reflection variant — the planner noticing ' +
        'its own suboptimal choice mid-loop — uses the SAME capture entry point ' +
        'so there is one path, not two.)\n\n' +
        'Implement in motir-ai:\n\n' +
        '- `lessonService.captureFromCorrection({ aiProjectId, correctionReason, ' +
        'before, after, jobId })` — distill the correction into a `Lesson`: a ' +
        'short `title`, the `why` (the stated reason + what changed), and a ' +
        '`howToApply` (the generalized rule, e.g. "this tenant always ships a ' +
        'feature flag alongside a new endpoint"). Distillation uses the planner ' +
        'LLM (the same SDK 7.2.2 provisions) to turn a one-off correction into a ' +
        'transferable rule — NOT a verbatim copy of the diff. `scope: tenant`, ' +
        '`aiProjectId` set, `sourceRef: "correction:<jobId>"`.\n' +
        '- **Idempotency + dedup.** Keyed on `sourceRef` so re-processing the ' +
        'same correction does not duplicate; before writing, check for a ' +
        'near-duplicate existing tenant lesson (same `howToApply` intent) and ' +
        'UPDATE/reinforce rather than pile up redundant rows (the store stays ' +
        'curated, not a junk drawer — the 7.10.2 dedup discipline applied to the ' +
        'live path).\n' +
        '- **Human-in-the-loop, durable shape.** A captured tenant lesson lands ' +
        '`enabled: true` and immediately injectable, but it is VISIBLE and ' +
        'editable in the admin view (7.10.6) — the tenant can refine or disable a ' +
        'lesson the planner inferred (we capture aggressively but let the human ' +
        'curate; mirror Rovo, where reflected memories are written to a file the ' +
        'user can edit).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A correction at the review/approve step (reject/edit-with-reason) ' +
        'produces exactly ONE new `scope: tenant` `Lesson` bound to that ' +
        '`aiProjectId`, with `why` = the reason + diff and `howToApply` = the ' +
        'generalized rule.\n' +
        '- Capture is idempotent on `sourceRef` (re-processing the same ' +
        'correction does not duplicate) and dedups a near-identical existing ' +
        'tenant lesson (reinforce/update, not a new row).\n' +
        '- The captured lesson is `enabled` and immediately eligible for ' +
        'injection (7.10.3) for that tenant only; a different tenant never sees ' +
        'it.\n' +
        '- The captured lesson is visible + editable + disable-able in the admin ' +
        'view (7.10.6 consumes the same store).\n' +
        '- Self-reflection and human-correction use the SAME capture entry point ' +
        '(one path).\n\n' +
        '## Context refs\n\n' +
        '- 7.10.1 — `lessonService` (the `captureFromCorrection` method lives ' +
        'here).\n' +
        '- 7.10.8 — the self-improving mechanism that hooks this capture to also ' +
        'file a `kind: bug` work item in the project (the dogfood loop; this ' +
        'card stays focused on the lesson, 7.10.8 owns the bug-filing).\n' +
        '- Story 7.3 (stub) — the generate→approve review gate where a ' +
        'correction surfaces (the trigger).\n' +
        '- 7.2.2 (stub) — the planner LLM/SDK the distillation step uses.\n' +
        '- The Rovo `/memory reflect` mirror + the session-level-reflection ' +
        'pattern (module header) — the capture shape this follows.',
      dependsOn: ['7.10.1'],
    },
    {
      id: '7.10.5',
      title: 'Design — the lessons admin view (list / view / edit / disable)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** design (the planning-time design gate, notes.html #31 — the ' +
        'design-reference rule the store itself encodes as a lesson). The admin ' +
        'UI (7.10.6) depends on this and is blocked until it exists; without it ' +
        'the lessons screen would be improvised, which is forbidden.\n\n' +
        'Produce the design asset for the **lessons admin** surface under ' +
        '`motir-core/design/ai-admin/`. Author it as a **`*.mock.html` mockup** ' +
        'built from the real design system (the `components/ui/*` primitives + ' +
        'the `--el-*` tokens + the `[data-display-style]` shape tokens) — NOT a ' +
        '`.pen`. The HTML route is preferred when a coding agent produces the ' +
        'design (the reviewer sees the actual tokens; no Pencil→code gap).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-panel ' +
        'rule, notes.html #31):\n\n' +
        '- **Panel 1 — the lessons list.** Header ("Planning lessons" + a "What ' +
        'is this?" info popover explaining that lessons teach the planner and are ' +
        'injected at plan time). Below, a list of lesson cards GROUPED or FILTERED ' +
        'by scope: a **Global** section (the base set ported from notes.html — ' +
        'read-leaning, badged "Built-in") and a **This project** section (the ' +
        'tenant lessons the capture loop wrote — fully editable, badged ' +
        '"Learned"). Each row: `title`, a one-line `howToApply` preview, the ' +
        'scope `Pill` (global vs tenant tone — distinct `--el-*` roles, AA on a ' +
        'tint), an `enabled` toggle, and a provenance hint ("from notes.html #1" ' +
        'or "learned 2026-06-09 from a correction"). The list VIRTUALIZES / ' +
        'paginates (the base set is 30+ and tenant lessons grow — the ' +
        'planning-time scale check, no "load all rows").\n' +
        '- **Panel 2 — lesson detail / edit.** The expanded view of one lesson ' +
        'showing all four fields (`title`, `body`, `why`, `howToApply`) + ' +
        'provenance. A GLOBAL lesson is read-only here (with a "disable for this ' +
        'project" affordance, since a tenant can opt out of a built-in lesson but ' +
        'not edit the shared copy); a TENANT lesson is fully editable. Show the ' +
        'edit form state (textareas on the `--el-*` input tokens).\n' +
        '- **Panel 3 — the disable / opt-out confirmation.** Disabling a lesson ' +
        'stops it being injected; the confirmation explains the effect ("the ' +
        'planner will no longer apply this lesson when generating plans for this ' +
        'project") — reuse the shipped confirm/dialog primitive.\n' +
        '- **Panel 4 — empty / first-run state.** Before the capture loop has ' +
        'taught any tenant lesson: the Global section is populated, the "This ' +
        'project" section shows an `EmptyState` explaining that the planner will ' +
        'add lessons here as it learns from your corrections.\n\n' +
        'Also write **`design/ai-admin/design-notes.md`** naming the exact ' +
        'primitives composed per surface, the exact copy strings, the placement ' +
        'decisions, the per-`--el-*` colour role for each element (the ' +
        'global-vs-tenant scope tones, the enabled/disabled states), and a ' +
        '"primitives composed (no hand-rolling)" checklist (the design-notes.md ' +
        'convention).\n\n' +
        '**Branch.** `design/PROD-7.10.5-lessons-admin`. The `design/*` prefix ' +
        'gate skips CI E2E + the Vercel preview deploy — this PR only edits ' +
        '`design/ai-admin/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-admin/lessons.mock.html` exists, renders the ' +
        'four panels side-by-side, references ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` colour/shape rules).\n' +
        '- The global-vs-tenant scope distinction is visually clear (badge + ' +
        'tone), and the read-only-global vs editable-tenant affordances are drawn.\n' +
        '- `motir-core/design/ai-admin/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` role.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, toggle, `EmptyState`, the confirm dialog, textarea) — no new ' +
        'design-system entry invented inside this Story (if one is needed, that ' +
        'is a NEW `design/` subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ready/` (from 7.0.1) — the closest existing ' +
        'multi-panel `*.mock.html` + `design-notes.md` to mirror for layout.\n' +
        '- `motir-core/components/ui/Pill.tsx` — the scope badge + status tones.\n' +
        '- `motir-core/components/ui/EmptyState.tsx` — Panel 4.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens the mockup references.\n' +
        '- 7.10.1 — the `Lesson` field shape (title/body/why/howToApply/scope/' +
        'enabled) the panels render.',
      dependsOn: [],
    },
    {
      id: '7.10.6',
      title: 'The lessons admin UI (motir-core) — view / edit / disable over the 7.1 boundary',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Build the lessons admin surface in **motir-core** that renders exactly ' +
        'what 7.10.5 specifies, reading + writing the lessons store in motir-ai ' +
        'OVER THE 7.1 BOUNDARY (the `lib/ai/motirAiClient` from 7.1.5) — never a ' +
        'direct DB reach (the open-core invariant: motir-core holds no AI tables ' +
        'and no motir-ai DB connection; it talks to the store only over HTTP).\n\n' +
        '**The motir-ai read/write endpoints.** This subtask adds the small ' +
        'motir-ai HTTP surface the admin UI consumes — `GET /v1/lessons` ' +
        '(scoped list, cursor-paginated, service-credential + the project ' +
        'identity from the 7.1 contract), `PATCH /v1/lessons/:id` (edit a tenant ' +
        'lesson), `POST /v1/lessons/:id/disable` + `/enable` (the toggle / ' +
        'opt-out) — all delegating to `lessonService` (7.10.1). A GLOBAL lesson ' +
        'is not editable (only disable-for-this-project); a TENANT lesson is ' +
        'fully editable. (These ride the 7.1 service-credential channel like ' +
        'every other motir-core→motir-ai call.)\n\n' +
        '**The motir-core surface (4-layer).**\n\n' +
        '- A server-side `aiLessonsService` in motir-core that calls the 7.1.5 ' +
        'client (`listLessons` / `editLesson` / `setLessonEnabled`), maps the ' +
        'contract errors to motir-core typed errors, and is the ONLY thing the ' +
        'route/page calls — no client component touches the client directly.\n' +
        '- Routes under `app/api/ai/lessons/*` (list / patch / toggle) that ' +
        'parse + session-gate (the surface adopts a 6.4 project-admin permission ' +
        '— curating what teaches the planner is a manager action, not every ' +
        'member; gate it the way the other admin surfaces do, 404-not-403 on a ' +
        'cross-tenant project), call the one service method, map errors.\n' +
        '- The page `app/(authed)/settings/ai/lessons/page.tsx` (or the ' +
        'established admin/settings location) — a Server Component rendering the ' +
        'four panels from the mockup: the Global (built-in, read + ' +
        'disable-for-project) section and the This-project (learned, editable) ' +
        'section, the detail/edit form, the disable confirmation, the empty ' +
        'state. List VIRTUALIZES / paginates (reuse the existing windowing ' +
        'primitive — the base set is 30+; no "load all rows").\n' +
        '- **i18n** — page strings in a new `aiLessons` namespace; nav/settings ' +
        'entry label localized, the same locale set the app ships.\n' +
        '- **Tokens** — composes ONLY the shipped `components/ui/*` primitives + ' +
        '`--el-*` colour + `[data-display-style]` shape tokens per 7.10.5 (no ' +
        'Tier-0 `--color-*`, no hand-rolled spacing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The lessons admin page renders the four panels from 7.10.5, composed ' +
        'of the named primitives, referencing only `--el-*` + ' +
        '`[data-display-style]` tokens (the colour/shape rules).\n' +
        '- The list shows Global (built-in) lessons read-leaning with a ' +
        '"disable for this project" toggle, and This-project (learned) lessons ' +
        'fully editable; both via the 7.1 boundary (no motir-ai import, no shared ' +
        'DB in motir-core).\n' +
        '- Editing a tenant lesson persists through the boundary into motir-ai; ' +
        'disabling a lesson stops it being injected (verifiable by re-running a ' +
        'plan).\n' +
        '- The surface is gated to the project-admin permission (a non-admin ' +
        'member is blocked); a cross-tenant project is 404-not-403.\n' +
        '- 4-layer respected: route → `aiLessonsService` → 7.1.5 client; no ' +
        'client component touches the client; the list paginates (no unbounded ' +
        'load).\n' +
        '- Empty This-project state renders the panel-4 `EmptyState`.\n\n' +
        '## Context refs\n\n' +
        '- 7.10.5 — the design asset this implements (the four panels + ' +
        'design-notes.md).\n' +
        '- 7.10.1 — `lessonService` + the motir-ai endpoints this exposes/' +
        'consumes.\n' +
        '- 7.1.5 — `lib/ai/motirAiClient` (the server-to-server boundary the ' +
        'admin reads/writes over).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour / § shape.\n' +
        '- `motir-core/app/(authed)/ready/page.tsx` (7.0.6) — the Server-' +
        'Component + virtualized-list + settings-surface pattern to mirror.',
      dependsOn: ['7.10.5', '7.10.1', '7.1.5'],
    },
    {
      id: '7.10.7',
      title: 'Vitest — lesson store + injection selection + the capture loop',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Vitest suite (motir-ai side, real Postgres — the no-mocks convention ' +
        '7.1.3 established mirroring motir-core) covering the store + the two ' +
        'loops that give it value (injection + capture). NOT browser E2E (the ' +
        'admin-view flow is covered at the integration level; the value here is ' +
        'the selection + capture logic).\n\n' +
        '**Store + scope (`lessonRepository` / `lessonService`):**\n\n' +
        '- `createFromBase` is idempotent on `sourceRef` — seeding the base set ' +
        'twice yields one row per lesson, not duplicates.\n' +
        '- `listForInjection(aiProjectId)` returns enabled `global` + that ' +
        "tenant's enabled `tenant` lessons in one query; a `disabled` lesson is " +
        "excluded; ANOTHER tenant's lessons are excluded (scope isolation).\n" +
        '- `listForAdmin` is cursor-paginated and reseed-stable (the base set ' +
        'alone exceeds a page).\n\n' +
        '**Injection selection (7.10.3):**\n\n' +
        '- A job whose intent matches a known lesson SURFACES that lesson; an ' +
        'irrelevant lesson is pruned (relevant-in / irrelevant-out — we do NOT ' +
        'inject all 30+).\n' +
        '- A `tenant` lesson ranks above a `global` lesson on a tie (specificity ' +
        'precedence).\n' +
        '- With an EMPTY store, selection returns nothing and the planner system ' +
        'context is unchanged (the enhancement property — 7.3 never ' +
        'hard-depends on 7.10).\n' +
        '- The injected lesson-id set is recorded on the job record (inspectable).\n\n' +
        '**Capture loop (7.10.4):**\n\n' +
        '- A correction (reject/edit-with-reason) produces exactly ONE ' +
        '`scope: tenant` lesson bound to the right `aiProjectId`, with `why` and ' +
        '`howToApply` populated.\n' +
        '- Capture is idempotent on `sourceRef` (re-processing the same ' +
        'correction does not duplicate) and dedups a near-identical existing ' +
        'tenant lesson (reinforce, not pile up).\n' +
        '- A captured tenant lesson is then injected for that tenant only on a ' +
        'subsequent plan (end-to-end: capture → store → inject), and a different ' +
        'tenant does not see it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass over a real Postgres (no mocks beyond the ' +
        'job/LLM seam the suite stubs deterministically — the distillation LLM ' +
        'call is stubbed so capture is asserted on a fixed correction).\n' +
        '- Scope isolation is proven with at least two distinct tenants.\n' +
        '- The empty-store no-op (the enhancement property) is explicitly ' +
        'asserted.\n' +
        '- Coverage on `lessonService` / `lessonRepository` and the injection ' +
        'selector demonstrates no untested branch in the scope / relevance / ' +
        'dedup logic.\n\n' +
        '## Context refs\n\n' +
        '- 7.10.1 (store), 7.10.3 (injection selection), 7.10.4 (capture) — ' +
        'everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate (the ' +
        'convention motir-ai mirrors).\n' +
        '- 7.1.3 — the motir-ai test harness (real docker Postgres) this rides.',
      dependsOn: ['7.10.3', '7.10.4'],
    },
    {
      id: '7.10.8',
      title:
        'Auto-file a `kind: bug` work item on mistake-capture — the self-improving loop (Motir on Motir)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Close the OTHER half of the learning loop: when the capture loop ' +
        '(7.10.4) records a planning mistake, ALSO file a `kind: bug` work item ' +
        'into the project so the gap becomes trackable, fixable, and assignable ' +
        'in the very backlog the planner manages. A lesson the planner notes but ' +
        'nobody can act on is a private regret; a bug in the tracker is a ' +
        'commitment. **This is the first self-improving mechanism in the system** — ' +
        'the planner files bugs about its OWN planning mistakes, closing a ' +
        'quality loop by using Motir on Motir.\n\n' +
        '**General mechanism, canonical first instance.** The behavior is generic ' +
        '(it fires for ANY tenant whose planner captures a mistake), but the ' +
        'first and canonical instance is Motir’s OWN planner, while building ' +
        'Motir, filing bugs into the live `motir` / `PROD` project — the dogfood ' +
        'that proves the whole loop end-to-end: a mistake is captured → ' +
        '`create_work_item` → a bug appears in the tracker the team already ' +
        'watches. The demo IS the proof.\n\n' +
        '**The write path — the AI never writes directly (architecture #1).** Per ' +
        'the locked 7.1 boundary, motir-ai holds NO write credential to the plan ' +
        'tree; it REQUESTS the create through motir-core’s write authority. ' +
        'The bug is filed via the SAME core-side path every other write rides — ' +
        'the **7.8.5 MCP `create_work_item` tool** (the verified `kind: bug` ' +
        'bug-logging tool — the long-promised "agents log bugs via the Motir MCP" ' +
        'protocol) and/or the **7.1.6 persist callback** ' +
        '(`POST /api/internal/ai/plan-delta`, committed through ' +
        '`workItemsService` with every 6.4 permission + tenant guard applied as ' +
        'the requesting identity). motir-ai proposes; core persists. No direct AI ' +
        'write, no bypassed validation, no new write authority invented here.\n\n' +
        'Implement in motir-ai:\n\n' +
        '- Hook `lessonService.captureFromCorrection` (7.10.4): after the tenant ' +
        '`Lesson` is written, request a `kind: bug` work item whose `title` names ' +
        'the mistake ("Planning gap: assumed a stack default without discovery"), ' +
        'whose `descriptionMd` captures WHAT went wrong + the lesson’s ' +
        '`why` / `howToApply` (so the bug is actionable), and whose reporter is ' +
        'the planner identity. The bug is filed under a sensible parent (the ' +
        'project’s planning/meta epic or story when one is resolvable; ' +
        'otherwise project-root, honoring the kind-parent matrix the create ' +
        'service enforces).\n' +
        '- **Idempotency — one bug per distinct lesson, no dupes on re-capture.** ' +
        'Re-capturing the same mistake (the 7.10.4 `sourceRef` dedup) must NOT ' +
        'file a second bug. Record the filed work-item key on the `Lesson` (a ' +
        '`bugWorkItemKey` field, or a side mapping) and short-circuit when it is ' +
        'already set / the dedup matched a reinforced lesson — the store + the ' +
        'tracker stay 1:1 with distinct lessons, not a junk drawer.\n' +
        '- **Resilience.** Filing the bug is a follow-on side effect, NOT a gate ' +
        'on capture: if the create request fails (core unreachable, a transient ' +
        'error), the lesson is still captured and the bug-file is retried / ' +
        'surfaced — a failed bug-file never loses the lesson (the capture loop ' +
        'stays the source of truth; this is additive, like injection is).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Capturing a mistake (7.10.4) files exactly ONE `kind: bug` work item ' +
        'in that tenant’s project, via motir-core write authority (the 7.8.5 ' +
        '`create_work_item` tool / the 7.1.6 persist callback) — NEVER a direct ' +
        'motir-ai write to the plan tree; reporter = the planner identity; the ' +
        'bug body carries the mistake + the lesson’s `why` / `howToApply`.\n' +
        '- The bug is linked to its originating `Lesson` (the work-item key ' +
        'recorded on the lesson); re-capturing the SAME mistake files NO second ' +
        'bug (idempotent — one bug per distinct lesson, matching the 7.10.4 ' +
        '`sourceRef` dedup).\n' +
        '- The create honors the kind-parent matrix + 6.4 permission + ' +
        '404-not-403 tenant guard the create service enforces (no bypassed ' +
        'validation — it is the same path an agent uses).\n' +
        '- A bug-file failure does NOT lose the captured lesson (capture is the ' +
        'source of truth; the bug-file is a retried/surfaced side effect).\n' +
        '- Dogfood: exercised against the live `motir` / `PROD` project — a ' +
        'captured planning mistake yields a bug in PROD’s backlog (the ' +
        'self-improving first instance, asserted at the integration level).\n\n' +
        '## Context refs\n\n' +
        '- 7.10.4 — `lessonService.captureFromCorrection` (the capture this hooks ' +
        'onto; this card owns the bug-filing, 7.10.4 stays focused on the ' +
        'lesson).\n' +
        '- 7.8.5 — the MCP `create_work_item` tool (the `kind: bug` bug-logging ' +
        'write path; 7.8 < 7.10, a backward dep).\n' +
        '- 7.1.6 — the persist callback (`POST /api/internal/ai/plan-delta`, ' +
        'committed through `workItemsService`) — the OTHER core-side write path ' +
        'the AI already holds.\n' +
        '- story-7.1.ts header §1 — one-directional writes (the AI never writes ' +
        'the tree directly; core is the system of record).\n' +
        '- story-7.8.ts header — the "agents log bugs via the Motir MCP" protocol ' +
        '(notes.html #26 follow-ups) this mechanism fulfils for the planner ' +
        'itself.',
      dependsOn: ['7.10.4', '7.8.5'],
    },
    {
      id: '7.10.9',
      title:
        'Cross-project bug ROOT-CAUSE classifier — analyze a user-project `kind: bug`, classify planning | coding-agent | out-of-scope',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The analysis brain of the SECOND (outward) self-improving mechanism. ' +
        'Where the inward loop (7.10.8) fires when the planner CATCHES ITSELF ' +
        'mid-plan, the outward loop harvests the failures that surface LATER and ' +
        'ELSEWHERE: a `kind: bug` a USER (or their dispatched coding agent) files ' +
        'in their OWN project because something Motir planned or dispatched went ' +
        'wrong in the real world. This card is the CLASSIFIER that decides whether ' +
        'such a bug is Motir’s fault — and if so, which part of Motir.\n\n' +
        '**Input (the analysis unit).** Given a bug work item (the project + key + ' +
        'its description/comments, read over the 7.1.6 read-back as the requesting ' +
        'identity — never a direct cross-tenant DB reach), assemble the analysis ' +
        'context: the bug text, the plan-tree neighborhood around the bug (the ' +
        'owning story/epic + the subtasks that produced the implicated work — the ' +
        '7.1.6 skeleton breadth), and, when resolvable, the DISPATCH + PR-STATUS ' +
        'signal that tells a planning fault from an execution fault: the 7.6 ' +
        'dispatch prompt that was generated for the implicated subtask and the 7.7 ' +
        'PR/CI status the agent’s work produced (named in PROSE as additive ' +
        'context — this card does NOT hard-depend on 7.6/7.7; when they are absent ' +
        'the classifier degrades to plan-tree-only reasoning). Epic-9 hosted ' +
        'agent-run transcripts are a FURTHER additive context source named in ' +
        'prose only — NEVER a dependency (that would be a forward dep).\n\n' +
        '**Classification (the three buckets).** Implement ' +
        '`lessonService.classifyBugRootCause({ aiProjectId, bugKey, context })` ' +
        '— a planner-LLM call (the 7.2.2 SDK, the same one 7.10.4 distillation ' +
        'uses) that returns a typed verdict:\n\n' +
        '- **`planning_mistake`** — the PLAN was wrong: a missing subtask, an ' +
        'unconsidered prerequisite (no feature flag, no migration), a bad ' +
        'dependency / ordering, a design gate skipped. The fix belongs in Motir’s ' +
        'planner.\n' +
        '- **`coding_agent_mistake`** — the plan was sound but the DISPATCHED ' +
        'agent mis-executed (ignored a context ref, broke an unrelated surface, ' +
        'shipped without the asked-for test). The dispatch-prompt + PR-status ' +
        'signal is what separates this from a planning fault. The fix belongs in ' +
        'Motir’s agent/prompt system.\n' +
        '- **`out_of_scope`** — a GENUINE user/product bug: the user’s own ' +
        'business logic, a third-party outage, a data-entry error — NOT Motir’s ' +
        'fault. The default/conservative verdict when the signal does not clearly ' +
        'implicate Motir (we do NOT over-claim Motir authorship; a false ' +
        '`planning_mistake` pollutes PROD’s backlog).\n\n' +
        'The verdict carries a `rationale` and — critically — a SANITIZED, ' +
        'abstracted `rootCauseSignal`: the transferable flaw pattern with the ' +
        'user’s confidential specifics STRIPPED (see 7.10.10 for why this is the ' +
        'only thing allowed to cross tenants). The classifier is a PURE analysis ' +
        'step — it writes nothing to any tracker; 7.10.10 owns the trigger + the ' +
        'filing + the lesson capture. Keeping classification separate makes it ' +
        'unit-testable on fixed bug fixtures (deterministic with the LLM seam ' +
        'stubbed) and lets the verdict be inspected before any write.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lessonService.classifyBugRootCause(...)` returns one of ' +
        '`planning_mistake | coding_agent_mistake | out_of_scope` with a ' +
        '`rationale` and an abstracted `rootCauseSignal`, reading the bug + ' +
        'plan-tree context ONLY over the 7.1.6 read-back (no cross-tenant DB ' +
        'reach).\n' +
        '- When dispatch/PR-status signal (7.6/7.7) is available it is folded in ' +
        'to separate a coding-agent fault from a planning fault; when ABSENT the ' +
        'classifier still returns a verdict from plan-tree context alone (no hard ' +
        'dependency on 7.6/7.7/9.x).\n' +
        '- The verdict is conservative: an ambiguous / un-implicating signal ' +
        'classifies `out_of_scope` (Motir authorship is not over-claimed).\n' +
        '- `rootCauseSignal` is ABSTRACTED — it contains no verbatim user code, ' +
        'project name, key, or issue text (the sanitization 7.10.10 relies on ' +
        'begins here).\n' +
        '- The classifier writes to NO tracker — it is pure analysis; 7.10.10 ' +
        'owns the write.\n\n' +
        '## Context refs\n\n' +
        '- 7.10.1 — `lessonService` (the `classifyBugRootCause` method lives ' +
        'here).\n' +
        '- 7.1.6 — the read-back the analysis reads the bug + plan-tree ' +
        'neighborhood over (permission-checked as the requesting identity).\n' +
        '- 7.2.2 (stub) — the planner LLM/SDK the classification call uses.\n' +
        '- Story 7.6 (stub, dispatch prompt) + Story 7.7 (stub, PR/CI status ' +
        'sync) — the ADDITIVE coding-agent-vs-planning signal, named in prose, ' +
        'NOT a dependency; Epic-9 hosted-run transcripts likewise additive (prose ' +
        'only, never a forward dep).\n' +
        '- 7.10.4 — the lesson-capture this verdict ultimately feeds (via ' +
        '7.10.10).',
      dependsOn: ['7.10.1'],
    },
    {
      id: '7.10.10',
      title:
        'Outward trigger + SANITIZED meta-bug into motir/PROD + lesson capture — the cross-tenant failure-telemetry loop',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Close the SECOND (outward) self-improving mechanism: wire the 7.10.9 ' +
        'classifier to a real-world TRIGGER, and — when the verdict blames Motir — ' +
        'file a SANITIZED meta-bug into the **motir / PROD** project and capture ' +
        'the lesson. This is how Motir improves its planner + agents from REAL ' +
        'failures aggregated across its whole user base, not just from mistakes it ' +
        'catches mid-plan.\n\n' +
        '**The trigger (the shipped 1.6 pipeline).** Subscribe to the ' +
        'bug-created event on the Story-1.6 Inngest cron/job pipeline — the ' +
        '`work-item/created` event (emitted by the 6.6 automation path) FILTERED ' +
        'to `kind: bug`. On each such event: (a) SKIP it if the bug’s project IS ' +
        'the `motir` project itself — motir’s own mistakes are owned by the INWARD ' +
        'loop (7.10.8); the outward analyzer never files a self-referential ' +
        'meta-bug; (b) otherwise hand the bug to `classifyBugRootCause` (7.10.9). ' +
        'A bug-created event is the natural fan-in point (every channel that ' +
        'creates a bug — UI, the 7.8.5 MCP tool, the API — emits it once after the ' +
        'create transaction commits, mirror the 5.7 single-event / many-consumers ' +
        'shape), so this loop fires no matter HOW the user filed the bug.\n\n' +
        '**On a Motir-caused verdict (`planning_mistake | coding_agent_mistake`).**\n\n' +
        '1. **File the SANITIZED meta-bug into motir / PROD.** Request a ' +
        '`kind: bug` work item in the `motir` project (resolved by its stable ' +
        'project key, NOT the user’s project) whose `title` + `descriptionMd` ' +
        'carry ONLY the abstracted `rootCauseSignal` from 7.10.9 — the planner / ' +
        'agent flaw as a transferable pattern ("the planner omits a feature-flag ' +
        'prerequisite when planning a new endpoint") — and the verdict + ' +
        'rationale. **NEVER** the user’s code, project name/key, issue text, ' +
        'identifiers, or anything reconstructable: this bug LEAVES the user’s ' +
        'tenant, so it is cross-tenant telemetry and the open-core + ' +
        'per-tenant-isolation line (6.4 + the 7.1 boundary) MUST hold. A ' +
        'verification step asserts the body is de-identified. The bug is filed ' +
        'through motir-core WRITE AUTHORITY (architecture #1 — the AI never writes ' +
        'directly): the 7.8.5 `create_work_item` tool and/or the 7.1.6 persist ' +
        'callback, reporter = the planner/meta identity, under motir/PROD’s ' +
        'planning/meta parent (honoring the kind-parent matrix the create service ' +
        'enforces).\n' +
        '2. **Capture the lesson (7.10.4).** Feed the abstracted root cause into ' +
        '`captureFromCorrection` (the SAME capture entry point) so the planner ' +
        'itself LEARNS from the real-world failure — a `global`-candidate or ' +
        'tenant lesson per the cause (a Motir-system flaw is a craft lesson; the ' +
        'capture path decides scope), and the planner stops repeating it.\n\n' +
        '**Idempotency — one meta-bug per distinct abstracted root cause.** Many ' +
        'users hitting the SAME Motir flaw must NOT spam PROD with N identical ' +
        'meta-bugs. Key the meta-bug on a stable hash of the abstracted ' +
        '`rootCauseSignal` (NOT on the user bug id — that would let the same flaw ' +
        're-file): if a PROD meta-bug for that signal already exists, ' +
        'REINFORCE/annotate it (an occurrence count / "seen again") rather than ' +
        'file a duplicate — the 7.10.4 dedup discipline applied to the cross-tenant ' +
        'path. Record the PROD meta-bug key on the captured lesson so the ' +
        'store + PROD stay 1:1 with distinct root causes.\n\n' +
        '**Resilience + privacy by construction.** The file-into-PROD is a ' +
        'follow-on side effect, not a gate: a failed PROD write is retried / ' +
        'surfaced and never loses the analysis. The sanitization is enforced at ' +
        'THIS boundary (the abstracted signal is the ONLY field allowed into the ' +
        'PROD bug) — a test asserts a representative user-confidential token never ' +
        'appears in the filed meta-bug. `out_of_scope` verdicts file NOTHING and ' +
        'capture NO lesson (Motir is not at fault).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `work-item/created` (`kind: bug`) event in a NON-motir project drives ' +
        'the bug through 7.10.9; a `planning_mistake` / `coding_agent_mistake` ' +
        'verdict files exactly ONE `kind: bug` into the `motir` / `PROD` project ' +
        'via motir-core write authority (7.8.5 / 7.1.6 — NEVER a direct AI write) ' +
        'and captures a lesson (7.10.4); an `out_of_scope` verdict files nothing ' +
        'and captures nothing.\n' +
        '- A bug created in the `motir` project ITSELF is SKIPPED by the outward ' +
        'loop (the inward loop, 7.10.8, owns motir’s own mistakes — no ' +
        'self-referential meta-bug).\n' +
        '- **Sanitization:** the filed PROD meta-bug carries ONLY the abstracted ' +
        'root-cause signal + verdict/rationale — a test asserts no user code / ' +
        'project name / key / issue text appears in it (cross-tenant isolation ' +
        'holds; the open-core posture, 6.4 + the 7.1 boundary).\n' +
        '- **Idempotency:** a second user bug with the SAME abstracted root cause ' +
        'does NOT file a second PROD meta-bug (reinforces/annotates the existing ' +
        'one, keyed on the signal hash); the PROD key is recorded on the lesson.\n' +
        '- The trigger fans in from ANY bug-create channel (UI / 7.8.5 MCP / API) ' +
        'via the single 1.6-pipeline `work-item/created` event; a PROD-write ' +
        'failure is retried/surfaced and never loses the analysis.\n\n' +
        '## Context refs\n\n' +
        '- 7.10.9 — `classifyBugRootCause` (the verdict + the abstracted ' +
        '`rootCauseSignal` this files / sanitizes from).\n' +
        '- 7.10.4 — `captureFromCorrection` (the lesson-capture entry point this ' +
        'reuses for real-world failures).\n' +
        '- 7.8.5 — the MCP `create_work_item` tool (the `kind: bug` write path ' +
        'into motir/PROD; 7.8 < 7.10, a backward dep).\n' +
        '- Story 1.6 (SHIPPED) — the Inngest cron/job event pipeline; the ' +
        '`work-item/created` event (6.6 automation) filtered to `kind: bug` is the ' +
        'trigger; the 5.7 single-event / many-consumers shape is the fan-in ' +
        'precedent.\n' +
        '- 6.4 (SHIPPED) + story-7.1.ts header §1/§4 — the permission model + ' +
        'open-core / per-tenant-isolation posture the cross-tenant sanitization ' +
        'upholds.\n' +
        '- 7.10.8 — the INWARD counterpart (this is its OUTWARD sibling; together ' +
        'the two self-improving mechanisms cover own-mistakes + cross-project ' +
        'failures).',
      dependsOn: ['7.10.9', '7.10.4', '7.8.5'],
    },
  ],
};
