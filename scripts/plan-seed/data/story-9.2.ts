import type { PlanStory } from '../types';

/**
 * Story 9.2 — Design approval gate (hosted-run design review + revise loop).
 * The third story of **Epic 9 (Native AI coding)** — it builds ON Story 9.1
 * (the hosted-execution foundation; 9.1 < 9.2, so a dep on 9.1.x is a BACKWARD
 * dep) and ON Story 7.6 (the GIT WORKFLOW session-branch variant `motir auto`
 * uses; 7.6 < 9.2, backward). When the HOSTED coding agent (`motir auto`,
 * 9.1.7's unattended loop) executes a **design** subtask, the agent PRODUCES
 * the design — the `*.mock.html` mockup + `design-notes.md` — and this story
 * adds the **runtime DESIGN APPROVAL GATE** that requires USER approval before
 * the loop dispatches the work that depends on that design.
 *
 * **⚠️ THIS IS NOT THE MOTIR.md DESIGN GATE — read this first.** MOTIR.md /
 * the planner's design gate is a **PLANNING-TIME** rule: before the planner
 * plans or builds any UI-touching subtask, a design ASSET (`*.mock.html` +
 * `design-notes.md`) and an owning `type: design` subtask must already exist —
 * the planner never improvises UI, it pauses and adds a design subtask. That
 * gate governs how the PLAN is shaped. **Story 9.2's gate is a different
 * animal: an EXECUTION-TIME, human-in-the-loop APPROVAL inside the running
 * `motir auto` hosted loop.** It does not decide whether a design subtask
 * exists (the planner already did that); it decides whether the design the
 * hosted agent JUST PRODUCED is good enough to let the loop proceed to the
 * dependents — a human looks at the rendered preview and clicks Approve (or
 * asks for changes). One is a plan-shaping prerequisite check; the other is a
 * runtime quality/approval checkpoint on freshly-generated output. 9.2.2
 * states this distinction explicitly and authoritatively (it is the keystone
 * decision of this story). Do not conflate them in any card.
 *
 * **The behavior this story bakes in (Yue's spec, locked):**
 *
 * 1. **Where it fires — `motir auto` (the 9.1.7 hosted unattended loop).** The
 *    gate lives in the hosted, walk-away loop that drains a slice of the ready
 *    set onto ONE session branch (the 7.6 `session_branch` git-workflow
 *    variant) behind ONE session PR. It is **per-project, default ON (true)**.
 *    A user can set it **false** in **project settings**, and then the loop
 *    auto-continues past designs with no manual approval (the gate is a
 *    safety/quality default the user can opt out of, not a hard wall).
 *
 * 2. **On design-subtask completion — merge to the session PR, go "for
 *    review".** When the hosted agent finishes a `design` subtask, the design
 *    output (the `*.mock.html` + `design-notes.md`) is **merged to the
 *    SESSION PR** (the `motir auto` session branch) and the design subtask is
 *    set to a **"for review"** state — NOT `done`. "For review" is a real,
 *    persisted state on a review record linking the design subtask + the
 *    session PR + the hosted run (9.2.4) — it is the held checkpoint the user
 *    acts on.
 *
 * 3. **Gate ON → HOLD the dependents.** Subtasks **blocked by (depends_on)**
 *    the design subtask stay HELD — the loop does NOT dispatch them — until the
 *    user **manually approves**. On approval: the design subtask flips to
 *    `done`, its dependents unblock, and the loop RESUMES draining them. (Gate
 *    OFF → the loop continues to the dependents immediately; the design still
 *    goes through the merge-to-session-PR + "for review" record, but nothing
 *    waits on a human.)
 *
 * 4. **The approval SURFACE — a deployed preview in a sandboxed iframe.** The
 *    design `*.mock.html` (+ the rendered `design-notes.md`) is DEPLOYED to an
 *    **ephemeral preview URL** and shown in a **sandboxed iframe** (the mockup
 *    is generated HTML — it is rendered under iframe `sandbox` isolation, never
 *    same-origin-with-scripts) with an **Approve** button and a **chat box to
 *    request design changes**. Sending a change request RE-DISPATCHES the
 *    hosted agent on the SAME design subtask with the feedback → a new preview
 *    (the REVISE LOOP). Approve ends the loop for that design.
 *
 * 5. **Cost control — undeploy on approval (and on timeout).** Holding the
 *    ephemeral preview deployment costs money (an extra running service per
 *    pending design). So the preview is DEPLOYED when the design enters "for
 *    review" and **UNDEPLOYED when the design is approved** — and also torn
 *    down on a review TIMEOUT, so an abandoned review can't leak a paid
 *    preview indefinitely. The deploy/undeploy lifecycle mirrors the 9.1
 *    container-per-run teardown discipline (provision-on-need, guaranteed
 *    teardown on every terminal path).
 *
 * **The verified mirror — design review via an ephemeral preview deployment +
 * a conversational revise loop (cited, web-checked 2026-06-12).**
 *   - **Vercel Preview Deployments + Comments.** Every PR/branch gets an
 *     automatically-generated EPHEMERAL preview URL ("a live link with the
 *     actual user experience for every pull request"), and reviewers "comment
 *     directly on copy, components, interactions… in context as you review."
 *     This is exactly the deploy-the-design-to-a-preview-URL-and-review-it
 *     shape — a per-change preview a human looks at and approves/comments on,
 *     not a static screenshot. Motir's gate is the SAME shape scoped to a
 *     single design subtask inside the auto loop.
 *   - **v0 by Vercel (generative-UI iteration).** v0's loop is "describe →
 *     SEE the rendered component in a preview → adjust in plain English →
 *     repeat," and it is explicitly "not a one-shot generator" — you follow up
 *     with refinements ("make the sidebar collapsible," "add a loading
 *     skeleton") and each chat message refines the output. Motir's revise-chat
 *     box → re-dispatch → fresh preview is exactly this conversational
 *     refine-against-a-live-preview loop, here gating the auto loop's progress.
 *   - **Sandboxed-iframe isolation for rendered untrusted/generated HTML.**
 *     The consensus security posture for rendering generated HTML in-app is the
 *     HTML5 `sandbox` iframe (strict origin isolation; do NOT combine
 *     `allow-scripts` + `allow-same-origin`, which lets the framed doc escape
 *     the sandbox). The preview iframe follows that posture.
 *
 * **Backward deps only (the Epic-9 audit posture).** Every 9.2 leaf depends
 * only on same-story 9.2.x ids, the backward 9.1.x hosted-loop ids (9.1.7 the
 * `motir auto` orchestration this hooks into), and backward 7.6.x ids (the
 * session-branch/session-PR shape) — all ≤ 9.2. No dep points ABOVE 9.2 and
 * none points to an unplanned future Epic-9 story. Because every upstream is
 * not-yet-done, the status rule makes the design + decision cards
 * (`dependsOn: []`) `planned` and everything else `blocked`.
 *
 * **The (planning-time) design gate fires for THIS story's own UI.** 9.2 ships
 * a real user-facing surface — the design-review iframe + the Approve button +
 * the revise-chat + the "for review" indicator + the project-settings toggle —
 * so the FIRST subtask (9.2.1) is a `design` card producing
 * `design/hosted-design-review/*.mock.html` + `design-notes.md`, and the UI
 * code subtask (9.2.9) depends on it and is `blocked` behind it. (Yes: the
 * runtime design-approval gate's OWN surface is itself subject to the
 * planning-time design gate — the two gates are orthogonal, which is the whole
 * point of 9.2.2.)
 *
 * **Out of scope — named so they land in their own Epic-9 stories, not here
 * (visibly deferred, not forgotten):**
 *   - **A general PR-review/iteration loop for CODE subtasks** — review
 *     comments on a code PR → the hosted agent revises (the "request changes,
 *     agent revises" cycle for non-design work). 9.2's revise loop is scoped to
 *     DESIGN subtasks (re-dispatch the design subtask on feedback). The code
 *     review-loop is the deferred 9.1-header story.
 *   - **Approval gates on non-design subtask types** (e.g. a copy/content
 *     approval gate). 9.2 gates DESIGN only; generalizing the gate to other
 *     types is a later story.
 *   - **Multi-reviewer / approval-routing policy** (who may approve, multiple
 *     approvers, per-role routing). 9.2's approver is the dispatching user /
 *     project member; richer routing is later.
 */
export const story_9_2: PlanStory = {
  id: '9.2',
  title:
    'Design approval gate — hosted-run design review + revise loop (runtime human-in-the-loop, distinct from the planning-time design gate)',
  status: 'planned',
  gitBranch: 'feat/PROD-9.2-design-approval-gate',
  descriptionMd:
    'A **runtime DESIGN APPROVAL GATE** for the hosted unattended loop ' +
    '(`motir auto`, 9.1.7): when the hosted coding agent executes a **design** ' +
    'subtask, it produces the design (the `*.mock.html` mockup + ' +
    '`design-notes.md`), and this gate requires a USER to APPROVE that design ' +
    'before the loop dispatches the work that depends on it.\n\n' +
    '**⚠️ This is NOT the MOTIR.md / planner design gate.** That gate is a ' +
    '**PLANNING-TIME** rule (a design asset + a `type: design` subtask must ' +
    'EXIST before any UI subtask is planned/built — the planner never ' +
    'improvises UI). **THIS gate is an EXECUTION-TIME, human-in-the-loop ' +
    'APPROVAL** inside the running hosted loop — it does not decide whether a ' +
    'design subtask exists; it decides whether the design the agent JUST ' +
    'PRODUCED is good enough to let the loop proceed. One shapes the plan; the ' +
    'other approves freshly-generated output at run time. (9.2.2 fixes this ' +
    'distinction authoritatively.)\n\n' +
    '**The behavior (locked — see the module header for the full rationale + ' +
    'the cited mirror):**\n\n' +
    '- **Per-project, default ON (true).** The gate is on by default per ' +
    'project; a user can set it **false** in **project settings** → the loop ' +
    'auto-continues past designs without manual approval.\n' +
    '- **On design completion → merge to the SESSION PR + "for review".** When ' +
    'the hosted agent finishes a `design` subtask, its output is merged to the ' +
    '`motir auto` SESSION PR (the 7.6 session branch) and the design subtask ' +
    'goes to a **"for review"** state (NOT `done`) — a persisted review record ' +
    'linking the design subtask + the session PR + the hosted run.\n' +
    '- **Gate ON → HOLD the dependents.** Subtasks `depends_on` the design ' +
    'subtask stay HELD (the loop does not dispatch them) until the user ' +
    'manually **approves**; on approval the design → `done`, the dependents ' +
    'unblock, and the loop RESUMES. **Gate OFF → the loop continues** to the ' +
    'dependents without waiting (the review record is still written, but ' +
    'nothing blocks on a human).\n' +
    '- **The approval surface — a deployed preview in a sandboxed iframe.** ' +
    'The design `*.mock.html` (+ the rendered `design-notes.md`) is DEPLOYED ' +
    'to an **ephemeral preview URL** and shown in a **sandboxed iframe** with ' +
    'an **Approve** button and a **chat box to request design changes**. A ' +
    'change request RE-DISPATCHES the hosted agent on the SAME design subtask ' +
    'with the feedback → a fresh preview (the REVISE LOOP — the Vercel-preview ' +
    '/ v0 mirror).\n' +
    '- **Cost control — undeploy on approval (and on timeout).** The ephemeral ' +
    'preview costs money to hold, so it is UNDEPLOYED when the design is ' +
    'approved — and also on a review TIMEOUT, so an abandoned review cannot ' +
    'leak a paid preview.\n\n' +
    '**Scope:** the design-review surface design (9.2.1); the runtime ' +
    'design-approval-gate semantics decision, explicitly distinguished from ' +
    'the planning-time gate (9.2.2); the ephemeral preview DEPLOY target + ' +
    'automated teardown provisioning (9.2.3); the schema/settings — ' +
    '`Project.designApprovalGate` + the "for review"/pending-approval review ' +
    'record (9.2.4); the hosted-loop gate hook in 9.1.7 (9.2.5); the preview ' +
    'deploy/undeploy lifecycle (9.2.6); the revise loop (9.2.7); the approval ' +
    'action (9.2.8); the review UI (9.2.9); vitest (9.2.10).\n\n' +
    '**Out of scope (named so they land in their own Epic-9 stories):** a ' +
    'general PR-review/iteration loop for CODE subtasks (9.2 gates DESIGN ' +
    'only); approval gates on non-design subtask types; multi-reviewer / ' +
    'approval-routing policy (9.2 approver = the dispatching user / a project ' +
    'member).',
  verificationRecipeMd:
    '- Pull the Story branch; with both services up (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other) and the hosted-run ' +
    'infra reachable (9.1.3) plus the ephemeral preview deploy target ' +
    'provisioned (9.2.3 — a local preview host is enough for the smoke), start ' +
    'a **`motir auto`** run on a slice of the ready set that contains a ' +
    '`design` subtask with at least one subtask `depends_on` it.\n' +
    '- **Gate ON (the default).** When the hosted agent finishes the design ' +
    'subtask: its `*.mock.html` + `design-notes.md` are merged to the SESSION ' +
    'PR, the design subtask shows **"for review"** (NOT done), and the loop ' +
    'HOLDS — the dependent subtasks are NOT dispatched. A design-review ' +
    'surface appears: the design renders in a **sandboxed iframe** off an ' +
    'EPHEMERAL preview URL, with the rendered design-notes, an **Approve** ' +
    'button, and a **revise-chat** box.\n' +
    '- **The revise loop.** Type a change request in the chat ("tighten the ' +
    'card padding"); the hosted agent is RE-DISPATCHED on the SAME design ' +
    'subtask with the feedback, produces a new mockup, and a FRESH preview ' +
    'replaces the old one (the prior preview is torn down). Confirm the loop ' +
    'is still HELD (dependents still not dispatched).\n' +
    '- **Approve.** Click **Approve** → the design subtask flips to `done`, ' +
    'its dependents UNBLOCK and the `motir auto` loop RESUMES dispatching ' +
    'them, and the ephemeral preview is UNDEPLOYED (confirm no preview service ' +
    'is left running — the cost-control teardown). The design output stays on ' +
    'the session PR.\n' +
    '- **Timeout teardown (cost control).** Force a review TIMEOUT (or wait ' +
    'the configured window) on a pending design → the ephemeral preview is ' +
    'UNDEPLOYED even without an approval (no leaked paid preview); the review ' +
    'record reflects the timeout.\n' +
    '- **Gate OFF.** In project settings set `designApprovalGate` to false; ' +
    'run `motir auto` again over the same shape → the loop CONTINUES to the ' +
    'dependents immediately after the design completes, with NO manual ' +
    'approval held (the review record is still written for the audit trail, ' +
    'but nothing blocks).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 9.2.10 covers gate ON ' +
    'holds-dependents / OFF continues, the deploy→undeploy lifecycle, the ' +
    'revise loop producing a new preview, and approval unblocking + ' +
    'undeploying.\n' +
    '- **The two-gates check (the 9.2.2 distinction, verified at run time).** ' +
    'Confirm the planning-time gate is UNCHANGED (a UI subtask still needs its ' +
    'design asset + design subtask at plan time) and that THIS runtime gate is ' +
    'a SEPARATE, additional checkpoint on the agent-produced design — disabling ' +
    'one does not disable the other.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** No ' +
    '`motir-ai` import in `motir-core` (HTTP only); the ephemeral preview is ' +
    'rendered in a SANDBOXED iframe (no `allow-scripts` + `allow-same-origin` ' +
    'together); browsers never call motir-ai or the preview host’s control ' +
    'plane directly.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '9.2.1',
      title:
        'Design — the hosted-design-review surface (deployed-preview sandboxed iframe + rendered design-notes + Approve + revise-chat + the "for review" indicator + the project-settings toggle)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the PLANNING-TIME design gate, Principle #13 + the ' +
        'design-reference rule — MOTIR.md). The review UI (9.2.9) depends on ' +
        'this card; without it the surface would be improvised, which is ' +
        'forbidden (notes.html #31). (Note the recursion this story makes ' +
        'explicit: the surface OF the runtime design-approval gate is itself ' +
        'gated by the planning-time design gate — orthogonal gates, see ' +
        '9.2.2.)\n\n' +
        'Produce the design asset for the **hosted-design-review** surface ' +
        'under `motir-core/design/hosted-design-review/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the ' +
        'shipped `components/ui/*` primitives + the `--el-*` colour tokens + ' +
        'the `[data-display-style]` shape tokens) — NOT a `.pen` (the ' +
        'coding-agent-produced-design route, MOTIR.md § Design-reference rule; ' +
        'a PNG export is optional, the `.mock.html` is the source of truth).\n\n' +
        '**Mirror (cited — design review via an ephemeral preview deployment + ' +
        'a conversational revise loop, web-verified 2026-06-12).** Vercel ' +
        'Preview Deployments + Comments give every change a live ephemeral ' +
        'preview URL a reviewer looks at and comments on in context; v0’s ' +
        'generative-UI loop is "see the rendered preview → ask for changes in ' +
        'plain English → repeat" (not a one-shot generator). Draw THAT, scoped ' +
        'to one design subtask inside a `motir auto` run: a deployed preview ' +
        'the human eyeballs, an Approve action, and a revise-chat that ' +
        're-runs the agent.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the review surface (the held checkpoint).** The design ' +
        'rendered in a **sandboxed iframe** off the ephemeral preview URL ' +
        '(show the iframe chrome + a "preview" affordance: open-in-new-tab, ' +
        'the preview URL), BESIDE the rendered `design-notes.md` (a readable ' +
        'markdown panel naming the primitives/copy/roles). A prominent ' +
        '**Approve** button (the primary action) and a **revise-chat** box ' +
        '(a message composer: "Request design changes…") with the running ' +
        'thread of prior change requests + the agent’s responses. Show which ' +
        'design subtask + which session PR this review is for (the link to the ' +
        'PR).\n' +
        '- **Panel 2 — the "for review" indicator (in the run + on the ' +
        'subtask).** How a design subtask in the **"for review"** state reads ' +
        'in the `motir auto` run view (9.1.8’s live run) and on the work-item ' +
        '— a distinct `Pill` tone (NOT done, NOT in-progress; per-status tint, ' +
        'finding #54) that signals "held, awaiting your approval," plus how ' +
        'the HELD dependents read ("waiting on design approval"). This is the ' +
        'visible state of the gate holding the loop.\n' +
        '- **Panel 3 — the revise loop (mid-revision).** The state while a ' +
        'change request is RE-DISPATCHING the hosted agent: the chat shows the ' +
        'request sent, the iframe shows a "regenerating preview…" state (the ' +
        'old preview being replaced), and an `aria-live` region announces ' +
        'progress. On completion the iframe swaps to the FRESH preview. Make ' +
        'clear the loop is STILL held (Approve is the only exit).\n' +
        '- **Panel 4 — the approved / undeployed terminal state + the timeout ' +
        'state.** After Approve: a confirmation that the design is approved, ' +
        'the subtask is `done`, the dependents are resuming, and the preview ' +
        'has been UNDEPLOYED (a quiet "preview torn down" affordance — the ' +
        'cost-control payoff). Also the TIMEOUT state (the review window ' +
        'lapsed → preview undeployed, the design still "for review" / re-' +
        'openable) with NO leaked-preview implication. An empty state (no ' +
        'pending design reviews) + a loading skeleton.\n' +
        '- **Panel 5 — the project-settings toggle.** The ' +
        '**`Design approval gate`** switch in project settings (default ON), ' +
        'with one line of explainer copy ("When on, `motir auto` pauses for ' +
        'your approval after it produces a design, before building what ' +
        'depends on it"). Draw it in the settings layout the project already ' +
        'uses; compose the shipped toggle/switch primitive.\n\n' +
        'Also write **`design/hosted-design-review/design-notes.md`** naming ' +
        'the exact primitives used per surface, the exact copy strings (the ' +
        'Approve label, the revise-chat placeholder + send affordance, the ' +
        '"for review"/"waiting on design approval"/"preview torn down"/timeout ' +
        'copy, the settings-toggle label + explainer), the placement ' +
        'decisions, the per-`--el-*` colour role for each element (incl. the ' +
        '"for review" `Pill` tone + any `--el-warning`/`--el-info` role for ' +
        'the timeout/held states), and a "primitives composed (no ' +
        'hand-rolling)" checklist (the design-notes.md convention 1.3.3 / ' +
        '1.5.1 / 7.0.1). It MUST state, in writing, the iframe SANDBOX posture ' +
        '(the preview is generated HTML → rendered under `sandbox`, never ' +
        '`allow-scripts` + `allow-same-origin` together) and that this runtime ' +
        'gate is DISTINCT from the planning-time design gate (the 9.2.2 ' +
        'distinction, restated for the implementer).\n\n' +
        '**Branch.** `design/PROD-9.2.1-hosted-design-review`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits ' +
        '`design/hosted-design-review/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/hosted-design-review/hosted-design-review.' +
        'mock.html` exists, renders the five panels above, and references ' +
        'ONLY `--el-*` tokens + `[data-display-style]` shape tokens (no ' +
        'Tier-0 `--color-*`, no hand-rolled spacing — the `motir-core/' +
        'CLAUDE.md` § colour / shape rules).\n' +
        '- `motir-core/design/hosted-design-review/design-notes.md` exists, ' +
        'names every primitive composed + every copy string + the per-element ' +
        '`--el-*` role, STATES the iframe sandbox posture, and STATES the ' +
        'runtime-vs-planning-time gate distinction.\n' +
        '- The review panel shows the sandboxed-iframe preview + the rendered ' +
        'design-notes + the Approve button + the revise-chat; the "for review" ' +
        'indicator + the held-dependents state are drawn; the revise + ' +
        'approved/undeployed + timeout states are drawn; the project-settings ' +
        'toggle (default ON) is drawn.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, the switch/toggle, the chat/message-composer pattern, the ' +
        'skeleton/loader, an `EmptyState`) — if a genuinely new primitive is ' +
        'needed, that is a NEW `design/` subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/hosted-agent/` (9.1.1) — the closest existing ' +
        'design area (the `motir auto` hosted-run surface this review plugs ' +
        'into); mirror its layout + `design-notes.md` shape, and the "for ' +
        'review" indicator reads inside its run view.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, the ' +
        'switch/toggle + chat/composer primitives — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-warning`/`--el-info`) + `[data-display-style]` shape tokens.\n' +
        '- The design-review-via-preview mirror (web-verified 2026-06-12): ' +
        'Vercel Preview Deployments + Comments (ephemeral preview URL, comment ' +
        'in context), v0 by Vercel (see-preview → revise-in-chat → repeat), ' +
        'the HTML5 sandbox-iframe posture for rendered generated HTML.\n' +
        '- MOTIR.md § the planning-time design gate — the gate this surface ' +
        'is DISTINCT from (9.2.2).',
      dependsOn: [],
    },
    {
      id: '9.2.2',
      title:
        'Decision — the runtime design-approval-gate semantics (default ON, "for review" state, merge-to-session-PR, hold-vs-continue, revise/approve, per-project toggle), EXPLICITLY distinguished from the planning-time design gate',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR every other 9.2 card builds ' +
        'against). Produce a living architecture document; no app behavior ' +
        'ships here, but the shapes it fixes are load-bearing for the rest of ' +
        '9.2.\n\n' +
        'Write `motir-ai/docs/design-approval-gate.md` (or the equivalent ' +
        'motir-core doc if the gate logic is core-side — fix the owning side ' +
        'here; the hosted-loop orchestration is the 9.1.7 home) with a short ' +
        'pointer from the other repo. It MUST fix:\n\n' +
        '**0. THE DISTINCTION (state this FIRST, authoritatively).** This ' +
        'runtime gate is **NOT** the MOTIR.md / planner design gate. Spell out ' +
        'the two, side by side:\n' +
        '   - **The PLANNING-TIME design gate** (MOTIR.md § the design gate / ' +
        'design-reference rule): a rule the PLANNER obeys — before it ' +
        'plans/builds any UI-touching subtask, a design ASSET (`*.mock.html` + ' +
        '`design-notes.md`) AND an owning `type: design` subtask must already ' +
        'EXIST; the planner never improvises UI, it pauses and adds a design ' +
        'subtask. It governs the SHAPE OF THE PLAN. It is enforced at plan ' +
        'time, before any code/design is built.\n' +
        '   - **The RUNTIME design-approval gate (THIS story)**: an ' +
        'EXECUTION-TIME, human-in-the-loop APPROVAL inside the running ' +
        '`motir auto` hosted loop. It does NOT decide whether a design subtask ' +
        'exists (the planner already did). It decides whether the design the ' +
        'hosted agent JUST PRODUCED is good enough to let the loop proceed to ' +
        'the dependents — a human looks at the rendered preview and Approves ' +
        '(or asks for changes). It governs RUNTIME PROGRESS on ' +
        'freshly-generated output.\n' +
        '   - They are ORTHOGONAL and can BOTH apply to the same design ' +
        'subtask: the planner made the design subtask exist (planning-time ' +
        'gate), and at run time the human approves its produced output ' +
        '(runtime gate). Disabling the runtime gate (the per-project toggle) ' +
        'does NOT relax the planning-time gate, and vice-versa. The doc must ' +
        'make a future reader unable to conflate them.\n\n' +
        '**1. The per-project default + toggle.** The gate is ' +
        '**per-project, default ON (`true`)**, settable to `false` in PROJECT ' +
        'SETTINGS. Fix the setting’s home (`Project.designApprovalGate`, ' +
        '9.2.4) and the semantics of each state (ON = hold dependents for ' +
        'approval; OFF = auto-continue, still write the review record for the ' +
        'audit trail).\n' +
        '**2. The "for review" state + the review record.** When the hosted ' +
        'agent finishes a `design` subtask, the design goes to a **"for ' +
        'review"** state — NOT `done`. Fix it as a real persisted REVIEW ' +
        'RECORD linking the design subtask + the `motir auto` SESSION PR + the ' +
        '9.1 hosted run (the shape 9.2.4 models), with its lifecycle ' +
        '(`for_review → approved | timed_out | superseded-by-revision`).\n' +
        '**3. Merge-to-session-PR.** On design completion the output ' +
        '(`*.mock.html` + `design-notes.md`) is MERGED to the `motir auto` ' +
        'SESSION PR (the 7.6 `session_branch` variant the auto run uses — the ' +
        'design lands on the same branch the slice accumulates onto, so the ' +
        'reviewer sees it in the one PR). Fix how the merge relates to the ' +
        'session branch + how the preview is sourced FROM that merged design ' +
        '(9.2.6 deploys it).\n' +
        '**4. Hold-vs-continue (the core semantics).** Gate ON → the subtasks ' +
        '`depends_on` the design subtask are HELD: the 9.1.7 loop does NOT ' +
        'dispatch them until approval (the loop keeps draining OTHER ready ' +
        'items not blocked by this design, or idles if none — fix which). On ' +
        'approval: design → `done`, dependents unblock, loop resumes. Gate OFF ' +
        '→ on design completion the loop CONTINUES to the dependents (the ' +
        'design is auto-treated as approved for progress; the review record is ' +
        'still written). Fix the exact loop interaction with 9.1.7.\n' +
        '**5. The revise/approve flow.** The revise-chat → a design-change ' +
        'request → RE-DISPATCH the hosted agent on the SAME design subtask ' +
        'with the feedback → a fresh preview replaces the prior (which is torn ' +
        'down). Approve → undeploy + unblock. Fix that a revision SUPERSEDES ' +
        'the prior preview/review-iteration (one live preview at a time per ' +
        'design) and that the loop stays HELD across revisions until Approve.\n' +
        '**6. The preview deploy/undeploy + cost-control + timeout.** The ' +
        'ephemeral preview is DEPLOYED on entering "for review" and UNDEPLOYED ' +
        'on approval AND on a review TIMEOUT (the cost-control invariant: a ' +
        'paid preview never outlives its review). Fix the timeout window + ' +
        'what a timeout does to the gate (preview down; design stays "for ' +
        'review", re-openable; the loop stays held — it does NOT silently ' +
        'auto-approve). Name the infra inputs 9.2.3 must provision (the ' +
        'preview deploy target + its teardown hook).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The doc opens with the runtime-vs-planning-time DISTINCTION stated ' +
        'authoritatively (both gates defined, declared orthogonal, with the ' +
        '"disabling one does not relax the other" invariant) — a future ' +
        'reader cannot conflate them.\n' +
        '- It fixes: the per-project default-ON toggle + each state’s ' +
        'semantics; the "for review" review record + its lifecycle; the ' +
        'merge-to-session-PR; the hold-vs-continue loop interaction with ' +
        '9.1.7; the revise/approve flow (re-dispatch the same design subtask, ' +
        'one live preview, held until Approve); the deploy/undeploy + ' +
        'cost-control + timeout invariant.\n' +
        '- It names the infra inputs 9.2.3 provisions (the ephemeral preview ' +
        'deploy target + the automated teardown) and the ' +
        '`Project.designApprovalGate` + review-record schema 9.2.4 models.\n' +
        '- The design-review surface + the revise loop cite the verified ' +
        'mirror (Vercel preview deployments/comments + v0’s ' +
        'see-preview-then-revise loop) rather than asserting it.\n' +
        '- The other repo carries a short pointer doc; the deferrals (code ' +
        'PR-review loop, non-design approval gates, multi-reviewer routing) ' +
        'are restated as out-of-9.2.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked behavior + the cited mirror).\n' +
        '- **MOTIR.md § the planning-time design gate / the design-reference ' +
        'rule (mistake #31)** — the gate THIS one is explicitly distinguished ' +
        'FROM (section 0 of the doc).\n' +
        '- 9.1.7 (`motir auto` hosted-run orchestration) — the loop this gate ' +
        'hooks into (hold/continue/resume).\n' +
        '- 7.6 — the `session_branch` git-workflow variant + the session PR ' +
        'the design merges to (the auto run’s shape).\n' +
        '- Vercel Preview Deployments + Comments / v0 by Vercel (web-verified ' +
        '2026-06-12) — the design-review-via-ephemeral-preview + ' +
        'revise-in-chat mirror.',
      dependsOn: [],
    },
    {
      id: '9.2.3',
      title:
        'Provision the ephemeral design-preview DEPLOY target + automated teardown (the cost-incurring preview host; deploy-on-review, undeploy-on-approval) — manual',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        '**Type:** manual/human (no PR — infra / dashboard / secret work, ' +
        'mirror 1.6.7; marked done on Yue’s confirmation). A coding agent ' +
        'cannot stand up a preview deploy target, create its credential, or ' +
        'mint production infra secrets. Wired here via `dependsOn` so the ' +
        'prerequisite is visible at PLAN time (notes.html #30), not discovered ' +
        'at run time.\n\n' +
        'Using the infra inventory fixed by 9.2.2:\n\n' +
        '1. **The ephemeral preview DEPLOY target** — provision where a ' +
        'design’s `*.mock.html` (+ the rendered `design-notes.md`) is deployed ' +
        'to a short-lived, publicly-reachable-but-unguessable preview URL the ' +
        'review iframe loads (a static-site / preview host — the Vercel-' +
        'preview-deployment analog; a single static bundle per pending ' +
        'design). It serves STATIC generated HTML only — no server execution ' +
        'in the preview (the iframe is sandboxed; the preview itself is inert ' +
        'static files).\n' +
        '2. **The automated TEARDOWN hook** — the credential/API the 9.2.6 ' +
        'lifecycle calls to UNDEPLOY a preview on approval / timeout (the ' +
        'cost-control invariant: a paid preview never outlives its review). ' +
        'This is the COST-INCURRING piece — confirm the teardown path works ' +
        '(a deployed preview can be programmatically removed), so an abandoned ' +
        'review cannot accrue cost.\n' +
        '3. **Secrets + wiring** — the deploy/undeploy credential set on the ' +
        'orchestrating side (motir-ai or motir-core per the 9.2.2 owning ' +
        'decision), and any base-domain / URL-signing secret for the ' +
        'unguessable preview URLs. Wire the env keys 9.2.2 named on each ' +
        'side.\n\n' +
        '## Acceptance criteria\n\n' +
        '- An ephemeral preview deploy target exists that serves a static ' +
        '`*.mock.html` + rendered design-notes at a short-lived unguessable ' +
        'URL, reachable by the review iframe.\n' +
        '- The automated TEARDOWN path is confirmed working (a deployed ' +
        'preview can be programmatically undeployed) — the cost-control ' +
        'prerequisite.\n' +
        '- The deploy/undeploy credential + any URL-signing secret are set, ' +
        'and all infra env keys from 9.2.2’s inventory are present in each ' +
        'environment.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 9.2.2’s infra/env inventory + the deploy/undeploy + cost-control ' +
        'decision.\n' +
        '- 7.1.2 / 9.1.3 (the motir-ai + hosted-run provisioning manual cards) ' +
        '— the precedent shape for provisioning + secret wiring.\n' +
        '- Vercel Preview Deployments (the ephemeral-preview-URL mirror this ' +
        'target is the analog of).',
      dependsOn: ['9.2.2'],
    },
    {
      id: '9.2.4',
      title:
        'Schema / settings — `Project.designApprovalGate` (default true) + the design-subtask "for review"/pending-approval review record (linking the design subtask + the session PR + the hosted run), with a migration',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Model the gate’s persistent state — the per-project toggle and the ' +
        '"for review" review record — so 9.2.5 (the loop hook), 9.2.6 (the ' +
        'preview lifecycle), 9.2.7 (revise), 9.2.8 (approve), and 9.2.9 (the ' +
        'UI) have a durable schema to build on.\n\n' +
        '**`Project.designApprovalGate` (motir-core, default `true`).** Add the ' +
        'boolean to the project (a 4-layer settings field — the open PM ' +
        'substrate owns project settings; this is NOT an AI table). It is the ' +
        'per-project default-ON toggle 9.2.5 reads to decide hold-vs-continue ' +
        'and 9.2.9’s settings UI flips. Default `true` via a NON-breaking ' +
        'migration (existing projects backfill to `true` — the gate is on for ' +
        'everyone by default).\n\n' +
        '**The design-review record (the "for review"/pending-approval ' +
        'state).** Model the held-checkpoint state. Per the 9.2.2 owning-side ' +
        'decision, the review record (whichever side operates the hosted loop — ' +
        'the `AgentRun`/hosted-run state lives in motir-ai from 9.1, so the ' +
        'review record most likely hangs off the hosted run there, with ' +
        'motir-core reading it over 7.1; fix per 9.2.2) carries: the design ' +
        'SUBTASK key, the `motir auto` SESSION PR (the 7.6 session branch/PR), ' +
        'the 9.1 HOSTED RUN id, the current ephemeral PREVIEW URL (when ' +
        'deployed; null when undeployed), a `state` ' +
        '(`for_review | approved | timed_out`), a revise-thread (the ordered ' +
        'change requests + the agent responses — 9.2.7 appends), timestamps ' +
        '(entered-review, approved/timed-out), and the approver. Every FK is ' +
        'modelled as a Prisma `@relation` (CLAUDE.md § FK-as-`@relation`), not ' +
        'raw-SQL-only.\n\n' +
        '**4-layer.** A repository per entity (single-op) + a service ' +
        '(`designReviewService` / the project-settings service for the ' +
        'toggle) owning the transactions + the DTOs; routes are 9.2.5/9.2.8’s. ' +
        'No business logic here beyond the find-or-create / state-read the ' +
        'record needs — the hold/continue/approve LOGIC is 9.2.5/9.2.8. This ' +
        'card is the schema + the settings field + the thin repo/service + the ' +
        'migration.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `Project.designApprovalGate: Boolean @default(true)` exists with a ' +
        'NON-breaking migration (existing projects backfill to `true`); a ' +
        'repo/service read+update pair for the toggle, with a unit test.\n' +
        '- The design-review record is modelled (design subtask + session PR + ' +
        'hosted run + preview URL + `state` + revise-thread + timestamps + ' +
        'approver), every FK as a Prisma `@relation`; `prisma migrate dev` ' +
        'reports no drift (no spurious `DROP CONSTRAINT`).\n' +
        '- A repository + service pair for the review record ' +
        '(create-on-enter-review, read-by-run/subtask, state-transition ' +
        'helpers) with unit tests; reads used inside the approve transaction ' +
        'take `tx` (the lock-before-read-derived-update posture for the ' +
        'state flip).\n' +
        '- The owning-side placement matches the 9.2.2 decision; the open-core ' +
        'boundary holds (motir-core holds the project toggle; the hosted-run-' +
        'linked review record lives where the hosted run does, read over ' +
        '7.1).\n\n' +
        '## Context refs\n\n' +
        '- 9.2.2 — the "for review" state + record shape + the owning-side ' +
        'decision this models.\n' +
        '- 9.1.6 — the `AgentRun` / hosted-run record the review record links ' +
        'to (the hosted run that produced the design).\n' +
        '- 7.6.3 — the `session_branch`/session-PR shape the record references.\n' +
        '- `motir-core/prisma/schema.prisma` + `motir-core/CLAUDE.md` ' +
        '§ 4-layer + § FK-as-`@relation` + § migrations.',
      dependsOn: ['9.2.2'],
    },
    {
      id: '9.2.5',
      title:
        'The hosted-loop GATE HOOK in the 9.1.7 `motir auto` orchestration — on design-subtask completion: merge to the session PR + set "for review"; gate ON → HOLD the depends_on dependents; OFF → continue',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Hook the gate into the 9.1.7 `motir auto` hosted loop — the core ' +
        'hold-vs-continue logic. This is where the runtime gate actually ' +
        'governs the loop’s progress.\n\n' +
        '**On a `design` subtask completing in the loop.** When the hosted ' +
        'agent finishes a `design` subtask in a `motir auto` run: (1) MERGE ' +
        'its output (`*.mock.html` + `design-notes.md`) to the run’s SESSION ' +
        'PR (the 7.6 `session_branch` — the design lands on the same branch the ' +
        'slice accumulates onto, so the reviewer sees it in the one PR); ' +
        '(2) create/transition the 9.2.4 review record to **"for review"** ' +
        '(linking the design subtask + the session PR + the hosted run); the ' +
        'design subtask is NOT set `done`.\n\n' +
        '**Gate ON → HOLD the dependents.** Read `Project.designApprovalGate` ' +
        '(9.2.4). If ON: the subtasks `depends_on` the design subtask are HELD ' +
        '— the loop does NOT dispatch them. The loop keeps draining OTHER ' +
        'ready items in the slice that are NOT (transitively) blocked by this ' +
        'design; if none remain, it IDLES awaiting approval (per the 9.2.2 ' +
        'decision — it does not end the run, it parks). The held dependents ' +
        'stay blocked on the design subtask (which is "for review", not done), ' +
        'so the existing dependency mechanics already keep them out of the ' +
        'ready set — this hook ensures the loop respects "for review" as ' +
        'NOT-done.\n\n' +
        '**Gate OFF → continue.** If the toggle is OFF: still merge + write the ' +
        'review record (for the audit trail), but treat the design as approved ' +
        'FOR PROGRESS — set the design subtask `done` so its dependents ' +
        'unblock and the loop continues to them immediately, with no preview ' +
        'deploy and no human hold. (The deploy/undeploy lifecycle 9.2.6 is ' +
        'gate-ON-only; OFF never deploys a preview — no cost.)\n\n' +
        '**Trigger the preview deploy (gate ON).** On entering "for review" ' +
        'with the gate ON, invoke 9.2.6 to DEPLOY the ephemeral preview (the ' +
        'review surface needs it). This card OWNS the loop-hook decision + the ' +
        'merge + the state transition; 9.2.6 owns the deploy/undeploy ' +
        'mechanics it calls.\n\n' +
        '**4-layer + the boundary.** The hook lives in the hosted-loop ' +
        'orchestration (the 9.1.7 home — motir-ai operates the run; the ' +
        'review-record write goes through its service; the design-merge to the ' +
        'session PR rides the run-scoped token / the 7.7 GitHub surface as ' +
        '9.1.7 already does for the session PR). motir-core never holds the ' +
        'loop logic; browsers never drive the loop directly.\n\n' +
        '## Acceptance criteria\n\n' +
        '- On a `design` subtask completing in a `motir auto` run, its output ' +
        'is merged to the SESSION PR and the 9.2.4 review record goes to "for ' +
        'review" (the design subtask is NOT `done`).\n' +
        '- Gate ON: the subtasks `depends_on` the design are HELD (not ' +
        'dispatched); the loop drains other non-blocked ready items and IDLES ' +
        'awaiting approval if none remain (it parks, does not end); the ' +
        'preview deploy (9.2.6) is triggered.\n' +
        '- Gate OFF: the design is set `done` (review record still written), ' +
        'the dependents unblock, the loop CONTINUES immediately, and NO ' +
        'preview is deployed (no cost).\n' +
        '- The hook treats "for review" as NOT-done for ready-set purposes ' +
        '(dependents stay out of the ready set until approval / the ' +
        'OFF-path done).\n' +
        '- The loop logic lives in the 9.1.7 orchestration (motir-ai operates ' +
        'the run); no `motir-ai` import in motir-core; the design-merge rides ' +
        'the existing session-PR mechanism.\n\n' +
        '## Context refs\n\n' +
        '- 9.1.7 — the `motir auto` hosted-run orchestration this hooks into ' +
        '(the loop’s dispatch/hold/resume; the session PR).\n' +
        '- 9.2.4 — `Project.designApprovalGate` (read here) + the review ' +
        'record (created/transitioned here).\n' +
        '- 9.2.6 — the preview deploy this triggers on entering "for review" ' +
        '(gate ON).\n' +
        '- 7.6.3 — the `session_branch`/session-PR the design merges to.\n' +
        '- 9.2.2 — the hold-vs-continue + idle-vs-end-the-run semantics this ' +
        'implements.',
      dependsOn: ['9.2.4', '9.1.7'],
    },
    {
      id: '9.2.6',
      title:
        'The design-preview DEPLOY/UNDEPLOY lifecycle — deploy the `*.mock.html` (+ rendered design-notes) to an ephemeral URL for the iframe; undeploy on approval/timeout (cost control)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Implement the ephemeral-preview lifecycle the review surface loads ' +
        'and the cost-control teardown — the deploy/undeploy mechanics 9.2.5 ' +
        '(enter-review), 9.2.7 (revise), and 9.2.8 (approve) call.\n\n' +
        '**DEPLOY (on entering "for review", gate ON).** Take the design ' +
        'output from the SESSION PR (the merged `*.mock.html` + ' +
        '`design-notes.md`), RENDER the `design-notes.md` to HTML (a markdown ' +
        'render — the review surface shows it beside the mockup), and DEPLOY ' +
        'the static bundle to the 9.2.3 ephemeral preview target → a ' +
        'short-lived, UNGUESSABLE preview URL. Record the URL on the 9.2.4 ' +
        'review record (so the iframe can load it). The preview serves STATIC ' +
        'generated HTML only (no server execution) and is loaded under iframe ' +
        '`sandbox` (the 9.2.1 posture — never `allow-scripts` + ' +
        '`allow-same-origin` together).\n\n' +
        '**UNDEPLOY (the cost-control invariant).** UNDEPLOY the preview (call ' +
        'the 9.2.3 teardown hook, clear the URL on the review record) on BOTH ' +
        'terminal edges: (a) APPROVAL (9.2.8) — the design is done, the ' +
        'preview is no longer needed; (b) a review TIMEOUT — the configured ' +
        'review window lapsed with no approval, so the paid preview is torn ' +
        'down even though the design stays "for review" (re-openable; the loop ' +
        'stays held — no silent auto-approve, per 9.2.2). A REVISION (9.2.7) ' +
        'also undeploys the PRIOR preview before the fresh one deploys (one ' +
        'live preview per design). **The invariant: a deployed preview never ' +
        'outlives its review** — guaranteed teardown on approval/timeout/' +
        'revision/run-teardown (mirror the 9.1 container teardown discipline; ' +
        'an idempotent undeploy so a double-call is safe).\n\n' +
        '**The timeout mechanism.** A durable timeout (a scheduled/lifecycle ' +
        'check, not an in-memory timer that dies with a process) fires the ' +
        'undeploy after the 9.2.2 window. Reuse the hosted-run lifecycle ' +
        'timeout discipline (9.1.7) — a review timeout is the same shape as a ' +
        'run timeout: a guaranteed cleanup on overrun.\n\n' +
        '**4-layer + the boundary.** A `designPreviewService` orchestrates a ' +
        'thin preview-host client (deploy/undeploy over HTTP — motir-core/-ai ' +
        'never import the preview host) + the 9.2.4 review-record service (URL ' +
        'write/clear). The lifecycle lives where the hosted run + review record ' +
        'do (motir-ai per 9.2.2); motir-core reads the preview URL over 7.1 to ' +
        'render the iframe.\n\n' +
        '## Acceptance criteria\n\n' +
        '- On entering "for review" (gate ON), the merged `*.mock.html` + the ' +
        'RENDERED design-notes are deployed to an ephemeral unguessable URL ' +
        'recorded on the review record; the preview is static-only.\n' +
        '- The preview is UNDEPLOYED on approval AND on timeout AND before a ' +
        'revision’s fresh deploy (one live preview per design); undeploy is ' +
        'idempotent + the URL is cleared on the review record.\n' +
        '- The timeout is durable (survives a process restart — a ' +
        'scheduled/lifecycle check, not an in-memory timer) and fires the ' +
        'undeploy after the 9.2.2 window WITHOUT auto-approving (the design ' +
        'stays "for review", the loop stays held).\n' +
        '- **The cost-control invariant holds:** no deployed preview outlives ' +
        'its review (asserted with a fixture: approve → undeployed; timeout → ' +
        'undeployed; run torn down → undeployed).\n' +
        '- 4-layer respected (service → preview-host client + review-record ' +
        'service); deploy/undeploy cross to the preview host over HTTP; no ' +
        'preview-host import in motir-core/-ai.\n\n' +
        '## Context refs\n\n' +
        '- 9.2.3 — the ephemeral preview deploy target + the teardown hook ' +
        'this drives.\n' +
        '- 9.2.4 — the review record this writes/clears the preview URL on.\n' +
        '- 9.2.5 (enter-review → deploy) / 9.2.7 (revise → re-deploy) / 9.2.8 ' +
        '(approve → undeploy) — the callers.\n' +
        '- 9.1.7 — the hosted-run lifecycle-timeout discipline the review ' +
        'timeout mirrors (guaranteed teardown on overrun).\n' +
        '- 9.2.1 — the iframe sandbox posture the preview is loaded under.',
      dependsOn: ['9.2.3', '9.2.4'],
    },
    {
      id: '9.2.7',
      title:
        'The REVISE loop — the revise-chat box → a design-change request → re-dispatch the hosted agent on the SAME design subtask with the feedback → a fresh preview',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Implement the conversational REVISE loop — the v0-style ' +
        '"see-preview → ask-for-changes → fresh-preview" cycle (web-verified ' +
        'mirror), here gating a `motir auto` design while the loop stays ' +
        'HELD.\n\n' +
        '**A change request → re-dispatch the SAME design subtask.** A ' +
        'design-change message from the revise-chat (9.2.9) is appended to the ' +
        'review record’s revise-thread (9.2.4) and RE-DISPATCHES the hosted ' +
        'agent on the SAME `design` subtask (a 7.6 dispatch of the design ' +
        'subtask into a hosted run, per 9.1.7), carrying the FEEDBACK + the ' +
        'prior design + the thread as context — so the agent revises the ' +
        'existing mockup rather than starting cold. The design subtask stays ' +
        '"for review" (a revision does NOT approve or complete it); the loop ' +
        'stays HELD across the revision (the dependents are still not ' +
        'dispatched — only Approve exits).\n\n' +
        '**The fresh preview supersedes the prior.** When the re-dispatched ' +
        'run finishes, the new `*.mock.html` + `design-notes.md` are merged to ' +
        'the SESSION PR (replacing/adding onto the design on the branch, the ' +
        '9.2.5 merge mechanism), the PRIOR preview is UNDEPLOYED, and a FRESH ' +
        'preview is deployed (9.2.6) → one live preview per design. The review ' +
        'record reflects the new iteration (the thread grows; the preview URL ' +
        'updates). Stream the regeneration progress (the 9.2.1 ' +
        '"regenerating preview…" state) over the existing run-stream (9.1.7 ' +
        'SSE) so the UI shows it live.\n\n' +
        '**Bounded + safe.** Each revision is one re-dispatch (one hosted run); ' +
        'concurrent change requests on the same design are serialized (the ' +
        'lock-before-read-derived-update posture — a revision reads the ' +
        'current review state under `tx` before transitioning). A revision ' +
        'spends credits like any hosted run (the 9.1.6 gateway metering — a ' +
        'revise is a coding/design run; the same `AgentRun`/ledger debit ' +
        'applies; the out-of-credits pre-flight gate, 9.1.7, applies to a ' +
        'revision too).\n\n' +
        '**4-layer + the boundary.** A route (9.2.9’s revise action) → the ' +
        '`designReviewService.requestChange(...)` → appends the thread + ' +
        're-dispatches via the 9.1.7 orchestration + drives the 9.2.6 ' +
        're-deploy. The re-dispatch + the run live where the hosted loop does ' +
        '(motir-ai); motir-core only POSTs the change request + reads the ' +
        'updated preview/thread over 7.1.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A change request appends to the revise-thread and RE-DISPATCHES the ' +
        'hosted agent on the SAME design subtask with the feedback + prior ' +
        'design as context (it revises, not restarts); the design stays "for ' +
        'review" and the loop stays HELD across the revision.\n' +
        '- On the re-dispatched run finishing: the new output is merged to the ' +
        'SESSION PR, the PRIOR preview is undeployed, a FRESH preview is ' +
        'deployed, and the review record’s thread + preview URL update (one ' +
        'live preview per design).\n' +
        '- Regeneration progress streams over the 9.1.7 run-stream (the UI ' +
        'shows the "regenerating preview…" state); concurrent change requests ' +
        'are serialized (read-under-`tx` before transition).\n' +
        '- A revision is metered like a hosted run (the 9.1.6 gateway debit ' +
        'applies; the out-of-credits pre-flight applies) — no un-metered ' +
        'agent run.\n' +
        '- 4-layer respected (route → review service → 9.1.7 orchestration + ' +
        '9.2.6 lifecycle); the re-dispatch lives in the hosted loop (motir-ai); ' +
        'no `motir-ai` import in motir-core.\n\n' +
        '## Context refs\n\n' +
        '- 9.2.5 — the loop hook + the session-PR merge this re-runs through.\n' +
        '- 9.2.6 — the undeploy-prior + deploy-fresh preview lifecycle a ' +
        'revision drives.\n' +
        '- 9.1.7 — the hosted-run dispatch/stream this re-dispatches the design ' +
        'subtask through; 9.1.6 — the gateway metering a revision spends ' +
        'through.\n' +
        '- 9.2.4 — the revise-thread + preview URL on the review record.\n' +
        '- v0 by Vercel (web-verified 2026-06-12) — the ' +
        'see-preview → revise-in-chat → fresh-preview mirror this implements.',
      dependsOn: ['9.2.5', '9.2.6'],
    },
    {
      id: '9.2.8',
      title:
        'The APPROVAL action — Approve → design subtask `done`, unblock dependents (the `motir auto` loop resumes), undeploy the preview',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Implement the Approve action — the gate’s exit. This is the human ' +
        'green-light that turns a held design into progress.\n\n' +
        '**On Approve.** In ONE transaction (the lock-before-read-derived-' +
        'update posture — read the review record under `tx`, verify it is "for ' +
        'review", then transition): (1) set the review record `state = ' +
        'approved` (record the approver + timestamp); (2) flip the DESIGN ' +
        'SUBTASK to `done`; (3) its dependents UNBLOCK (the design subtask is ' +
        'now done, so the existing dependency mechanics return them to the ' +
        'ready set) and the 9.1.7 `motir auto` loop RESUMES dispatching them ' +
        '(if the loop parked/idled awaiting approval, approval wakes it); ' +
        '(4) UNDEPLOY the ephemeral preview (9.2.6 — the cost-control ' +
        'teardown). The design output stays on the SESSION PR (approval does ' +
        'not revert it).\n\n' +
        '**Idempotent + guarded.** Approving an already-approved / ' +
        'timed-out / superseded review is a safe no-op (or a clear typed ' +
        'error — fix per 9.2.2), not a double-flip; only an authorized ' +
        'approver (the dispatching user / a project member — the 9.2-scope ' +
        'approver; richer routing is deferred) may approve; the action is ' +
        'tenant-scoped (404-not-403 cross-tenant). The undeploy is best-effort-' +
        'guaranteed: if the teardown call fails, the approval still commits ' +
        'and the undeploy is retried by the lifecycle (a leaked preview is ' +
        'caught by the timeout sweep — the invariant holds either way).\n\n' +
        '**4-layer + the boundary.** A route (9.2.9’s Approve) → ' +
        '`designReviewService.approve(...)` owning the transaction + the ' +
        'loop-resume signal (to the 9.1.7 orchestration) + the 9.2.6 undeploy. ' +
        'The loop-resume + the review-record write live where the hosted run ' +
        'does (motir-ai); the work-item `done` flip goes through ' +
        '`workItemsService` (the core write authority — the AI never writes ' +
        'the tree directly; an approval is a user-initiated transition through ' +
        'core). No `motir-ai` import in motir-core.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Approve, in one transaction: sets the review record `approved` ' +
        '(approver + timestamp), flips the design subtask to `done` (via ' +
        '`workItemsService`), and triggers the 9.2.6 preview UNDEPLOY.\n' +
        '- The dependents unblock and the `motir auto` loop RESUMES dispatching ' +
        'them (a parked/idled loop wakes on approval); the design output stays ' +
        'on the session PR.\n' +
        '- Approval is idempotent/guarded (an already-terminal review is a ' +
        'safe no-op or a clear typed error), authorized (only an approver), ' +
        'and tenant-scoped (404-not-403 cross-tenant).\n' +
        '- The undeploy is guaranteed-eventually (approval commits even if the ' +
        'immediate teardown call fails; the timeout sweep catches a leak) — ' +
        'the no-preview-outlives-its-review invariant holds.\n' +
        '- 4-layer respected; the `done` flip rides `workItemsService` (core ' +
        'write authority); the loop-resume lives in the 9.1.7 orchestration; ' +
        'no `motir-ai` import in motir-core.\n\n' +
        '## Context refs\n\n' +
        '- 9.2.4 — the review record this transitions (read-under-`tx`).\n' +
        '- 9.2.5 — the held loop this resumes (the gate-ON hold); 9.1.7 — the ' +
        'orchestration that resumes dispatching the unblocked dependents.\n' +
        '- 9.2.6 — the preview undeploy this triggers (the cost-control ' +
        'teardown).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the `done` flip ' +
        'authority (the AI never writes the tree directly).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer; the lock-before-read-derived-' +
        'update posture for the state transition.',
      dependsOn: ['9.2.5', '9.2.6'],
    },
    {
      id: '9.2.9',
      title:
        'The review UI — sandboxed-iframe preview + rendered design-notes + Approve + revise-chat + the project-settings toggle (renders the 9.2.1 design)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the motir-core review UI exactly as 9.2.1 specifies — the ' +
        'surface where the user reviews a hosted-produced design, approves it, ' +
        'or asks for changes, and where they flip the per-project gate.\n\n' +
        '**Renders the 9.2.1 panels verbatim:**\n\n' +
        '- **The review surface.** The design rendered in a **SANDBOXED ' +
        'iframe** off the ephemeral preview URL (read from the 9.2.4 review ' +
        'record over 7.1) — the iframe uses `sandbox` with NO ' +
        '`allow-scripts`+`allow-same-origin` together (the 9.2.1 / web-' +
        'verified posture for rendered generated HTML), with an ' +
        'open-in-new-tab affordance. BESIDE it, the rendered `design-notes.md`. ' +
        'A prominent **Approve** button (calls 9.2.8) and a **revise-chat** ' +
        'box (the message composer + the running thread; sending calls 9.2.7), ' +
        'with the link to the SESSION PR + which design subtask this is for.\n' +
        '- **The "for review" indicator + held state.** A design subtask in ' +
        '"for review" reads with a distinct `Pill` tone in the 9.1.8 run view ' +
        '+ on the work-item ("held, awaiting your approval"); the HELD ' +
        'dependents read "waiting on design approval" (per-status tint, not ' +
        'grey-only — finding #54).\n' +
        '- **The revise + approved/undeployed + timeout states.** The ' +
        '"regenerating preview…" state while a change request re-dispatches ' +
        '(subscribe to the 9.1.7 run-stream; an `aria-live` region); the ' +
        'fresh-preview swap on completion; the approved-and-undeployed ' +
        'confirmation ("design approved, building dependents, preview torn ' +
        'down"); the timeout state (preview down, design re-openable); empty + ' +
        'loading + error (incl. preview-unreachable — a retry, not a blank ' +
        'iframe).\n' +
        '- **The project-settings toggle.** The **`Design approval gate`** ' +
        'switch (default ON) in project settings, with the explainer copy, ' +
        'flipping `Project.designApprovalGate` (9.2.4) via the settings ' +
        'service.\n\n' +
        '**4-layer + tokens.** Routes parse + call ONE service method ' +
        '(`designReviewService` for approve/revise/read; the settings service ' +
        'for the toggle); session-gated (401) + tenant-scoped (404-not-403 ' +
        'cross-tenant). The review view is a client component for the ' +
        'streaming/iframe/chat interaction — it calls the routes, never a ' +
        'service or Prisma directly. References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens; uses the palette (the "for ' +
        'review" `Pill` tone, any `--el-warning`/`--el-info` for held/timeout ' +
        '— not grey-only, finding #54); i18n via a new `designReview` ' +
        'namespace (the app’s locale set).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The review surface renders the design in a SANDBOXED iframe (no ' +
        '`allow-scripts`+`allow-same-origin` together — asserted) off the ' +
        'ephemeral preview URL, beside the rendered design-notes, with Approve ' +
        '(→ 9.2.8) + the revise-chat (→ 9.2.7) + the session-PR link.\n' +
        '- The "for review" indicator + the held-dependents state render with ' +
        'a distinct palette tone; the revise/regenerating, approved-' +
        'undeployed, and timeout states render; empty/loading/preview-' +
        'unreachable states are handled (retry, not a blank iframe).\n' +
        '- The project-settings toggle (default ON) flips ' +
        '`Project.designApprovalGate` via the settings service.\n' +
        '- Renders the 9.2.1 design with `--el-*` tokens only (no Tier-0 ' +
        '`--color-*`, no hand-rolled spacing); Approve is keyboard-reachable ' +
        'with an aria-label; the regeneration uses an `aria-live` region.\n' +
        '- 4-layer respected (route → service; no Prisma in routes; no client ' +
        'component touches a service directly); session-gated + tenant-scoped; ' +
        'no `motir-ai` import in motir-core (the preview URL + run-stream are ' +
        'read over 7.1).\n\n' +
        '## Context refs\n\n' +
        '- 9.2.1 — the design asset (the five panels this implements ' +
        'verbatim).\n' +
        '- 9.2.6 — the preview URL the iframe loads; 9.2.7 — the revise action ' +
        'the chat calls; 9.2.8 — the Approve action the button calls.\n' +
        '- 9.1.8 — the `motir auto` run view the "for review" indicator reads ' +
        'inside; 9.1.7 — the run-stream the regenerating state subscribes to.\n' +
        '- 9.2.4 — `Project.designApprovalGate` the settings toggle flips.\n' +
        '- `motir-core/components/ui/` (Pill, Button, switch/toggle, the ' +
        'chat/composer) + `motir-core/app/globals.css` (the `--el-*` + shape ' +
        'tokens) + `motir-core/CLAUDE.md` § 4-layer + § colour/shape.',
      dependsOn: ['9.2.1', '9.2.6', '9.2.7', '9.2.8'],
    },
    {
      id: '9.2.10',
      title:
        'Vitest — gate ON holds dependents / OFF continues; the deploy→undeploy lifecycle; the revise loop produces a new preview; approval unblocks + undeploys',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the design-approval gate against drift. Cover both sides at the ' +
        'unit/integration level. motir-core tests run over a real Postgres ' +
        '(the project convention; the only allowed `vi.mock` is ' +
        '`getSession()`); the motir-ai tests run over its own real Postgres ' +
        '(7.1.3) with the hosted-agent/LLM + the preview-host boundary stubbed ' +
        '(a FAKE agent that emits a fixture mockup; a STUB preview-host client ' +
        'recording deploy/undeploy calls — no real LLM, no real container, no ' +
        'real preview deploy in CI), but the gate logic, the review record, ' +
        'the deploy/undeploy bookkeeping, and the loop hold/resume are ' +
        'exercised for real.\n\n' +
        '**Gate semantics (9.2.5):**\n\n' +
        '- **Gate ON holds dependents.** Over a fixture `motir auto` slice ' +
        'with a `design` subtask + a dependent: on design completion the ' +
        'review record goes "for review", the design is NOT `done`, the ' +
        'dependent is NOT dispatched (stays out of the ready set), and a ' +
        'preview deploy is requested (the stub client saw a deploy).\n' +
        '- **Gate OFF continues.** With `Project.designApprovalGate = false`: ' +
        'on design completion the design is set `done`, the dependent ' +
        'unblocks, the loop continues, and NO preview is deployed (the stub ' +
        'client saw no deploy — no cost).\n\n' +
        '**Deploy→undeploy lifecycle + cost control (9.2.6):**\n\n' +
        '- A "for review" entry deploys a preview (URL recorded on the review ' +
        'record); approval undeploys it; a TIMEOUT undeploys it WITHOUT ' +
        'auto-approving (design stays "for review", loop stays held); undeploy ' +
        'is idempotent. **The invariant** (asserted): after every terminal ' +
        'edge (approve / timeout / run-teardown) the stub client shows the ' +
        'preview undeployed and the review-record URL cleared — no preview ' +
        'outlives its review.\n\n' +
        '**The revise loop (9.2.7):**\n\n' +
        '- A change request appends to the thread and re-dispatches the SAME ' +
        'design subtask with the feedback; on the re-run finishing, the PRIOR ' +
        'preview is undeployed and a FRESH preview is deployed (one live ' +
        'preview per design — the stub client shows undeploy-then-deploy), the ' +
        'thread grew, the design stayed "for review", and the loop stayed HELD ' +
        '(the dependent still not dispatched).\n\n' +
        '**Approval (9.2.8):**\n\n' +
        '- Approve flips the design subtask to `done` (via `workItemsService`),' +
        ' sets the review record `approved` (approver + timestamp), unblocks ' +
        'the dependents (back in the ready set / the loop resumes), and ' +
        'undeploys the preview — all in one transaction; an already-terminal ' +
        'review is a safe no-op; a cross-tenant / unauthorized approve is ' +
        'rejected (404-not-403 / 403).\n\n' +
        '**The two-gates guard (the 9.2.2 distinction):**\n\n' +
        '- A regression assert that toggling the RUNTIME gate (OFF) does NOT ' +
        'touch the PLANNING-TIME gate behavior, and that the runtime gate ' +
        'fires on a hosted-AGENT-produced design (not on a planner ' +
        'plan-shaping check) — so the two stay distinct mechanisms.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; motir-core over real Postgres ' +
        '(only `getSession()` mocked), motir-ai over its real Postgres with ' +
        'only the agent/LLM + preview-host boundary stubbed (a fake agent + a ' +
        'stub preview client — no real LLM/container/deploy in CI).\n' +
        '- The cost-control invariant is asserted (no preview outlives its ' +
        'review across approve/timeout/revision/teardown); the gate-ON-holds / ' +
        'gate-OFF-continues fork is asserted; the revise loop’s ' +
        'undeploy-then-deploy (one live preview) is asserted.\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the approve guard branches ' +
        '(already-terminal / cross-tenant / unauthorized) each have a direct ' +
        'test.\n\n' +
        '## Context refs\n\n' +
        '- 9.2.5 / 9.2.6 / 9.2.7 / 9.2.8 (everything under test).\n' +
        '- 9.1.9 — the hosted-run test patterns (fake agent, stubbed ' +
        'boundary, real metering/ledger) this composes with.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage ' +
        'gate; `tests/helpers/db.ts`, `vitest.config.ts` — the harness + the ' +
        'gate list.\n' +
        '- 7.1.3 — the motir-ai test DB the review-record/lifecycle tests run ' +
        'over.',
      dependsOn: ['9.2.5', '9.2.8'],
    },
  ],
};
