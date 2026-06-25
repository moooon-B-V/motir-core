import type { SeedStory } from '../types';

/**
 * Story 9.3 — Hosted execution layer: repo PROVISIONING + SCAFFOLD + the STARTER
 * LIBRARY + the GitHub HANDOFF. The capability that gives a HOSTED project a real
 * repo to build in. Where 9.1 ships the hosted run CONTAINER (clone → agent edits
 * → PR) and 9.2 the run plumbing, 9.3 answers the question 9.1 assumed away: WHICH
 * repo does the hosted agent clone, and where does it live? For a BYOK project the
 * answer is "the user's connected GitHub repo" (Epic 7 / 7.7). For a HOSTED
 * start-fresh project there is NO repo yet and the user may never touch GitHub at
 * all — so Motir PROVISIONS one. 9.3 is the repo lifecycle for hosted projects:
 * create a Motir-owned repo, scaffold (or fork a starter) into it, grow the
 * reusable starter library as a by-product of real builds, and hand the repo off
 * to the user's own GitHub on request.
 *
 * **The confirmed defaults this story bakes in (decided with Yue, 2026-06-12).**
 *
 * 1. **Motir-OWNED repo under Motir's GitHub org, by default.** A hosted
 *    start-fresh user may NEVER touch GitHub. So on hosted-project create, Motir
 *    creates the project's repo under MOTIR'S OWN GitHub org (the platform-owned-
 *    repo posture every hosted builder ships) — the hosted run container (9.1)
 *    clones + pushes + opens PRs against THIS repo via the Motir App installation,
 *    not the user's. GitHub is an implementation detail the user never has to see.
 *    This mirrors Lovable (connecting a project "creates a new GitHub repository";
 *    you own the code but the platform manages the repo), Bolt ("Export to GitHub"
 *    creates a repo on your behalf), v0 (export to a GitHub repo), and Replit
 *    (Git tab → Connect to GitHub creates the repo) — all platform-owned-by-
 *    default with an OPTIONAL export/transfer (web-verified 2026-06-12).
 *
 * 2. **Scaffold-then-BUILD (the locked hosted default "B"), NOT a fat template.**
 *    On provision, Motir gives the new repo a real foundation in ONE of two ways,
 *    in priority order: (a) if a STARTER in the library MATCHES the project's
 *    stack/type, FORK that starter into the new repo (a blessed, already-built
 *    foundation — the fast path); (b) ELSE run the per-stack ONE-LINE SCAFFOLD
 *    (`npx create-next-app` / `npx create-expo-app` / `spring init --dependencies=…`
 *    — web-verified the canonical one-liners) to lay down the framework skeleton,
 *    and **the PLAN builds the rest** — auth, design system, infra wiring are PLAN
 *    CONTENT (real planned stories the hosted agent executes), NOT baked into a
 *    template. The scaffold is the floor; the foundation is built, not copied. This
 *    is why 9.3 is "scaffold + starter library", not "ship 50 templates".
 *
 * 3. **The starter library is an OUTPUT of hosted builds (the flywheel), and
 *    promotion is CURATED.** The library is NOT a hand-maintained template gallery.
 *    A starter is a real foundation that a hosted build PRODUCED — once a built
 *    project's foundation (auth + design + infra, built by the plan) is good, a
 *    HUMAN blesses it and it is PROMOTED into the library as a reusable starter for
 *    the next matching project. The two starters that exist today are just the
 *    FIRST two entries; every future hosted build is a candidate to grow the
 *    library. Promotion is human-gated on purpose (a starter is load-bearing for
 *    every project that forks it — an un-reviewed promotion poisons the well), so
 *    9.3.6 is a CURATION flow, never an automatic "every build becomes a starter".
 *    This is the durable-asset flywheel: builds feed the library, the library
 *    accelerates builds.
 *
 * 4. **Handoff = GitHub repo TRANSFER + App RE-INSTALL.** When a user wants to own
 *    their repo on their OWN GitHub (or just walk away with the code), Motir
 *    TRANSFERS the Motir-owned repo to the user's account/org via the GitHub repo-
 *    transfer REST API (`POST /repos/{owner}/{repo}/transfer` with `new_owner` —
 *    web-verified; the transfer continues asynchronously and, for a personal-
 *    account target, the new owner must ACCEPT). Because a GitHub App installation
 *    is scoped to the ORIGINAL account/org, transferring the repo OUT of Motir's
 *    org takes it out of Motir's installation scope — so to KEEP the hosted loop
 *    working after handoff (dispatch + the code-graph index), the user RE-INSTALLS
 *    the Motir GitHub App on their account/org and selects the now-their repo (the
 *    exact 7.7.3 install grant). For a BYOK project the repo was already the user's
 *    and already App-installed, so handoff is a NO-OP. (Note the Lovable warning we
 *    web-verified: transferring a connected repo out-of-band BREAKS sync — so the
 *    handoff is a GUIDED, coordinated flow that re-establishes the App grant, not a
 *    raw "click transfer on GitHub and hope".)
 *
 * **The verified mirror (cited, not asserted — web-checked 2026-06-12).**
 *   - **Lovable** — connecting a project "creates a new GitHub repository"; the
 *     user owns the exported code; transferring the repo WHILE connected breaks
 *     sync (the coordinated-handoff lesson). Platform-owned-by-default + export.
 *   - **Bolt (StackBlitz)** — "Export to GitHub" creates a repo on your behalf
 *     containing the full-stack code; develop/deploy onward from there.
 *   - **v0 (Vercel)** — export your prototype to a GitHub repo + deploy to Vercel;
 *     the platform builds it, GitHub is the export target.
 *   - **Replit** — the Git tab → "Connect to GitHub" creates the repo + two-way
 *     sync; Connectors give one-click GitHub integration.
 *   - **GitHub repo-transfer REST API** — `POST /repos/{owner}/{repo}/transfer`
 *     (`new_owner`, optional `new_name`/`team_ids`); async; a personal-account
 *     target must accept the transfer (the handoff primitive).
 *   - **GitHub Apps** — an installation is scoped to an account/org; uninstalling
 *     (or moving a repo out of the install's account) loses access there, so a
 *     transferred repo needs a fresh install on the new owner (the re-install step).
 *   - **One-line scaffolds** — `npx create-next-app`, `npx create-expo-app`,
 *     `spring init --dependencies=…` are the canonical per-stack one-liners.
 *
 * **Where each side lives (the open-core boundary).** The hosted-repo lifecycle is
 * a HOSTED-product capability — it belongs to the closed/operated side (motir-ai /
 * the orchestrator), NOT to the exportable open core. motir-core stays a complete
 * Jira clone with zero hosted-repo tables: it only DISPLAYS the hosted-repo /
 * starter-library / handoff surfaces over the 7.1 boundary and proxies the
 * user-initiated handoff. The repo-create + scaffold + transfer all run under the
 * Motir GitHub App / org credentials, which live on the operated side; browsers
 * never call it directly. The GitHub App + installation MODEL is reused from 7.7.3
 * (the same two-grants shape) — 9.3 adds the Motir-org-owned-repo create + the
 * transfer, it does not re-invent the GitHub integration.
 *
 * **Design gate fires (AREA `design/hosted-repo/`).** 9.3 ships real user-facing
 * surfaces — the Motir-owned project-repo view, the starter library, and the
 * "connect / transfer to your GitHub" handoff — so 9.3.1 produces the design asset
 * FIRST and the UI code subtask (9.3.8) depends on it and is `blocked` until it
 * lands.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — backward/sideways only.**
 * Every `dependsOn` id's story number is ≤ 9.3: same-story 9.3.x, 9.1.7 (the
 * hosted-run orchestration this repo feeds — 9.1 < 9.3, backward), and 7.7.3 (the
 * GitHub App installation model the create/transfer reuse — 7.7 < 9.3, backward).
 * NO forward-pointing dep; nothing points at an unplanned future Epic-9 story (the
 * WF4/WF5/WF6 workflow stories 9.4/9.5/9.6 CONSUME 9.3.4, they are not depended on
 * here). By the status rule, the design + decision cards (`dependsOn: []`) are
 * `planned`; everything chained behind them or behind not-yet-done upstream ids is
 * `blocked`.
 */
export const story_9_3: SeedStory = {
  id: '9.3',
  title: 'Hosted execution layer — repo provisioning + scaffold + starter library + GitHub handoff',
  status: 'planned',
  gitBranch: 'feat/PROD-9.3-hosted-repo',
  descriptionMd:
    'The repo lifecycle for HOSTED projects — the capability that gives a ' +
    'hosted build a real repository to work in, without the user ever having ' +
    'to touch GitHub. 9.1 ships the hosted run container (clone → agent edits ' +
    '→ PR); 9.3 answers the question 9.1 assumed: WHICH repo, owned by whom. ' +
    'For a hosted start-fresh project there is no repo yet, so **Motir ' +
    'provisions a Motir-OWNED repo under Motir’s GitHub org**, scaffolds a ' +
    'real foundation into it, and (on request) hands it off to the user’s own ' +
    'GitHub.\n\n' +
    '**The confirmed defaults (locked — see the module header for the full ' +
    'rationale + the cited mirror):**\n\n' +
    '- **Motir-owned repo under Motir’s GitHub org, by default.** A hosted ' +
    'user may never touch GitHub; Motir creates + operates the project repo ' +
    'under its OWN org (the platform-owned-repo posture Lovable / Bolt / v0 / ' +
    'Replit all ship — web-verified). The 9.1 run container clones/pushes/PRs ' +
    'against THIS repo via the Motir App installation.\n' +
    '- **Scaffold-then-BUILD (the locked default “B”).** On provision, ' +
    'EITHER fork a matching STARTER from the library (the fast path, when one ' +
    'exists) OR run the per-stack ONE-LINE scaffold (`create-next-app` / ' +
    '`create-expo-app` / `spring init` — web-verified one-liners) and let the ' +
    'PLAN build the foundation. Auth / design / infra are PLAN CONTENT (real ' +
    'planned stories), NOT a fat template — the scaffold is the floor, the ' +
    'foundation is built.\n' +
    '- **The starter library is an OUTPUT of hosted builds (the flywheel); ' +
    'promotion is CURATED.** A starter is a real built foundation a HUMAN has ' +
    'blessed and promoted into the library for the next matching project — ' +
    'not a hand-kept template gallery. The two starters that exist today are ' +
    'just the first entries; every hosted build is a candidate. Promotion is ' +
    'human-gated (an un-reviewed starter poisons every project that forks it).\n' +
    '- **Handoff = GitHub repo TRANSFER + App re-install.** On request, ' +
    'transfer the Motir-owned repo to the user’s account/org via the GitHub ' +
    'repo-transfer REST API (web-verified `POST /repos/{owner}/{repo}/' +
    'transfer`; async; a personal target must accept), then the user ' +
    're-installs the Motir App on their account/org + selects the now-their ' +
    'repo (a GitHub App installation is account-scoped, so the transferred ' +
    'repo leaves Motir’s install scope) to KEEP dispatch + the code-graph ' +
    'index working. For a BYOK project (the repo was already the user’s, ' +
    'already installed) handoff is a NO-OP.\n\n' +
    '**Scope:** the hosted-repo surfaces design (9.3.1); the repo-ownership / ' +
    'scaffold-registry / starter-library / handoff DECISION (9.3.2); the ' +
    'Motir-org + App-scope + scaffold-runner PROVISIONING (9.3.3); repo ' +
    'PROVISIONING + per-stack one-line SCAFFOLD on hosted-project create ' +
    '(9.3.4); the STARTER LIBRARY registry + fork-a-matching-starter (9.3.5); ' +
    'CURATED promote-to-starter — the flywheel (9.3.6); the GitHub HANDOFF / ' +
    'transfer + App re-install (9.3.7); the hosted-repo + library + handoff UI ' +
    '(9.3.8); the vitest suite (9.3.9).\n\n' +
    '**Out of scope (named so they land elsewhere, not here):** the hosted ' +
    'run CONTAINER + dispatch + metering (9.1 — 9.3 only provisions the repo ' +
    'it runs against); the WF4 / WF5 / WF6 workflow ORCHESTRATION that ' +
    'composes provisioning with hosted builds (9.4 / 9.5 / 9.6 — they consume ' +
    '9.3.4, they are not built here); the GitHub App registration + the ' +
    'OAuth-identity / installation model itself (7.7 — 9.3 REUSES it, adding ' +
    'only the org-owned-repo create + the transfer); GitLab/Bitbucket ' +
    'providers (the 7.7.3 provider seam — additive later); per-stack ' +
    'auth/design/infra FOUNDATION content (it is PLAN content the hosted build ' +
    'executes, owned by Epic-7 planning, not a 9.3 template).',
  verificationRecipeMd:
    '- **Provisioning (9.3.3) first.** The Motir GitHub org exists, the Motir ' +
    'App has the repo-CREATE + repo-TRANSFER (administration) scopes it needs ' +
    'on that org, the scaffold runner (a sandboxed `npx`/`spring` executor) is ' +
    'reachable, and the env keys 9.3.2 named are wired on the operated side — ' +
    'Yue confirms (no PR).\n' +
    '- Pull the Story branch; with motir-core (`:3000`) + the operated side ' +
    'up and pointed at each other, and the hosted-repo infra reachable, create ' +
    'a HOSTED start-fresh project.\n' +
    '- **Provision + scaffold (9.3.4 / 9.3.5).** On create, a new repo appears ' +
    'under MOTIR’S org (not the user’s); because no matching starter exists ' +
    'yet for a novel stack, the per-stack ONE-LINE scaffold ran into it (a ' +
    'Next.js project shows a `create-next-app` skeleton commit; an Expo one a ' +
    '`create-expo-app` skeleton; a Spring one a `spring init` skeleton). ' +
    'Create a SECOND project whose stack MATCHES a library starter → the repo ' +
    'is FORKED from that starter instead (the foundation is already present, ' +
    'no bare scaffold). The hosted-repo view (9.3.8) shows the repo as ' +
    'Motir-owned with its provenance (scaffolded vs forked-from-starter).\n' +
    '- **The flywheel (9.3.6).** Take a hosted project whose foundation the ' +
    'plan BUILT (auth + design + infra), open the curate/promote flow, and ' +
    'promote its foundation into the library as a new starter (stack/type ' +
    'metadata captured). It now appears in the library and is offered to the ' +
    'NEXT matching project — confirm a subsequent matching create forks the ' +
    'newly-promoted starter. Confirm promotion is HUMAN-gated (no build auto-' +
    'promotes).\n' +
    '- **Handoff (9.3.7).** From the hosted-repo view, run “connect / transfer ' +
    'to your GitHub”: the guided flow has the user authorize + (for a personal ' +
    'target) ACCEPT, Motir calls the repo-transfer API, the repo moves to the ' +
    'user’s account/org, and the user RE-INSTALLS the Motir App on their ' +
    'account selecting the now-their repo — after which a fresh hosted dispatch ' +
    'still works (the loop survives handoff). Confirm a BYOK project’s handoff ' +
    'is a clean NO-OP (already the user’s repo, already installed).\n' +
    '- `pnpm test` — 9.3.9 covers repo-create-under-Motir-org, the scaffold ' +
    'registry per stack, the starter-fork path + the scaffold fallback, the ' +
    'curated promotion, and the transfer-then-reinstall handoff (GitHub stubbed ' +
    'at the HTTP boundary).\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** No ' +
    'hosted-repo table in motir-core (it only DISPLAYS over 7.1 + proxies the ' +
    'user-initiated handoff); the repo-create / scaffold / transfer run under ' +
    'the Motir App/org credentials on the operated side; browsers never reach ' +
    'it; motir-ai holds no connection to core’s DB. The GitHub App + ' +
    'installation MODEL is the SAME 7.7.3 entities (not a fork).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '9.3.1',
      title:
        'Design — the hosted-repo surfaces (the Motir-owned project-repo view, the starter library, the “connect/transfer to your GitHub” handoff)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The hosted-repo UI (9.3.8) depends on this ' +
        'card; without it the surfaces would be improvised, which is forbidden ' +
        '(notes.html #31).\n\n' +
        'Produce the design asset for the **hosted-repo** surfaces under ' +
        '`motir-core/design/hosted-repo/`. Author it as a **`*.mock.html` ' +
        'mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation gap; ' +
        'the reviewer sees the actual tokens). A PNG export is optional; the ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule).\n\n' +
        '**Mirror (cited — the platform-owned-repo + export surface).** ' +
        'Lovable / Bolt / v0 / Replit all present the same shape: a project ' +
        'whose repo the PLATFORM owns and manages (the user never has to open ' +
        'GitHub), plus an OPTIONAL “connect / export / transfer to your own ' +
        'GitHub” affordance for when they want to take ownership (web-verified ' +
        '2026-06-12). Draw THAT — plus Motir’s starter library as a first-class ' +
        'surface (the flywheel made visible).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the hosted project-repo view (Motir-owned, default).** ' +
        'For a hosted project: the repo card showing it is **managed by Motir** ' +
        '(under Motir’s GitHub org), its provenance (a `Pill` for ' +
        '`scaffolded` vs `forked from <starter>`), the stack/type, recent ' +
        'commits/PRs from hosted runs (link out), and the primary “Transfer to ' +
        'your GitHub” affordance. The copy must make “Motir owns this repo so ' +
        'you don’t have to touch GitHub” legible (the platform-owned default).\n' +
        '- **Panel 2 — the starter library.** A browsable list of reusable ' +
        'starters (the 2 existing + promoted ones), each with stack/type ' +
        'metadata, provenance (“promoted from a real build”), and a per-status ' +
        'tone via `Pill`. Plan for SCALE — paginate/lazy; the library grows ' +
        'with every promoted build, never “load all rows” (the at-scale rule).\n' +
        '- **Panel 3 — provision/scaffold provenance (on create).** The ' +
        'moment a hosted project gets its repo: the “forking starter X” fast ' +
        'path vs the “running `create-next-app` …” scaffold fallback, shown as ' +
        'a clear lifecycle note + the resulting skeleton — so a user (or ' +
        'reviewer) sees WHICH path was taken and why (a matching starter vs a ' +
        'one-line scaffold).\n' +
        '- **Panel 4 — the curate / promote-to-starter flow (human-gated).** ' +
        'For a built foundation: the “promote this foundation to a starter” ' +
        'review surface — capture stack/type metadata, a name/description, and ' +
        'a CLEAR human-approval step (this is curated, never automatic). State ' +
        'in the copy that promotion is a deliberate human blessing.\n' +
        '- **Panel 5 — the GitHub handoff / transfer flow.** The guided ' +
        'multi-step: (a) connect/authorize the user’s GitHub identity, (b) pick ' +
        'the target account/org, (c) the transfer + (for a personal target) the ' +
        '“accept the transfer on GitHub” step, (d) the “re-install the Motir ' +
        'App on your account + select this repo” step that keeps the hosted ' +
        'loop working. Make the “this moves the repo OUT of Motir’s ' +
        'management; re-install keeps dispatch + indexing” consequence explicit ' +
        '(the coordinated-handoff lesson — a raw transfer breaks sync).\n' +
        '- **Panel 6 — empty / in-progress / error states.** A BYOK project ' +
        '(no Motir-owned repo — handoff is a no-op; show the already-yours ' +
        'state); provisioning IN PROGRESS (scaffold/fork running, a skeleton/' +
        'loader); the transfer-pending state (awaiting the user’s GitHub ' +
        'accept); a transfer-FAILED / install-revoked error via `--el-danger`.\n\n' +
        'Also write **`design/hosted-repo/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings (especially the ' +
        '“Motir owns this repo”, the scaffold-vs-fork provenance, and the ' +
        'handoff-consequence copy), the placement decisions, the per-`--el-*` ' +
        'colour role for each element (the provenance `Pill` tones; the ' +
        '`--el-danger` transfer-failed role), and a “primitives composed (no ' +
        'hand-rolling)” checklist (the design-notes.md convention 1.3.3 / ' +
        '1.5.1 / 7.0.1 / 7.7.1 established). It MUST state, in writing, that ' +
        'promotion is human-curated (not automatic) and that the handoff ' +
        're-establishes the App grant (transfer + re-install), not a raw ' +
        'GitHub transfer.\n\n' +
        '**Branch.** `design/PROD-9.3.1-hosted-repo-surfaces`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/hosted-repo/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/hosted-repo/hosted-repo.mock.html` exists, ' +
        'renders the six panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/hosted-repo/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` ' +
        'role, and STATES that promote-to-starter is human-curated and the ' +
        'handoff = transfer + App re-install (coordinated, not a raw transfer).\n' +
        '- The Motir-owned repo view shows the managed-by-Motir framing + the ' +
        'scaffold-vs-fork provenance pill + the “Transfer to your GitHub” ' +
        'affordance; the starter library is paginated/lazy (at-scale); the ' +
        'handoff flow draws the transfer + accept + re-install steps.\n' +
        '- The BYOK no-op state + the provisioning/transfer-pending + the ' +
        'transfer-failed states are drawn.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, a list/table pattern, the skeleton/loader) — ' +
        'if a genuinely new primitive is needed, that is a NEW `design/` ' +
        'subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/github/` (7.7.1) + `motir-core/design/' +
        'hosted-agent/` (9.1.1) — the closest existing design areas (the ' +
        'GitHub connect/settings surface + the hosted-run surface); mirror ' +
        'their layout + `design-notes.md` shape.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-danger`) + `[data-display-style]` shape tokens.\n' +
        '- The platform-owned-repo + export mirror (web-verified 2026-06-12): ' +
        'Lovable (connect creates a repo; transfer-while-connected breaks ' +
        'sync), Bolt (“Export to GitHub” creates a repo on your behalf), v0 ' +
        '(export to a GitHub repo), Replit (Git tab → Connect to GitHub).',
      dependsOn: [],
    },
    {
      id: '9.3.2',
      title:
        'Decision — Motir-owned repo under Motir’s org (default), the per-stack one-line scaffold registry, the curated starter library, handoff = transfer + App re-install',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** decision (the keystone ADR the provisioning / scaffold / ' +
        'library / handoff code cards all build against). Produce a living ' +
        'architecture document; no app behavior ships here, but the shapes it ' +
        'fixes are load-bearing for the rest of 9.3 and the WF4/5/6 stories.\n\n' +
        'Write `motir-ai/docs/hosted-repo.md` (owned by the side that operates ' +
        'the repos; `motir-core` links it from a short pointer). It MUST fix ' +
        'four things:\n\n' +
        '1. **Repo ownership (the platform-owned default).** A hosted ' +
        'start-fresh project’s repo is created MOTIR-OWNED, under MOTIR’S ' +
        'GitHub org, by default — the user may never touch GitHub. Fix: which ' +
        'org, the repo-NAMING scheme (collision-safe, per workspace+project), ' +
        'visibility (private), and that the 9.1 run container ' +
        'clones/pushes/PRs against THIS repo via the Motir App installation ' +
        '(reusing 7.7.3’s installation model, NOT a new GitHub integration). ' +
        'Cite the mirror (Lovable/Bolt/v0/Replit all platform-owned-by-default ' +
        '+ optional export — web-verified) rather than asserting it. State the ' +
        'BYOK contrast: a BYOK project’s repo is the user’s connected repo ' +
        '(7.7), so provisioning + handoff are no-ops for it.\n' +
        '2. **The per-stack one-line SCAFFOLD registry (scaffold-then-build).** ' +
        'A registry mapping `{ stack, type } → the one-line scaffold command` ' +
        '(`npx create-next-app …`, `npx create-expo-app …`, `spring init ' +
        '--dependencies=… …` — web-verified the canonical one-liners), run in ' +
        'a SANDBOXED runner into the fresh repo. Fix that the scaffold is the ' +
        'FLOOR only: auth / design / infra are PLAN CONTENT (real planned ' +
        'stories the hosted build executes), NOT baked into a fat template — ' +
        'the locked default “B”. Fix the runner’s isolation posture (no ' +
        'secrets, network for the package fetch only, the 7.9.7/9.1 sandbox ' +
        'spirit) and that an unknown stack fails cleanly rather than guessing.\n' +
        '3. **The starter library (an OUTPUT of builds; promotion CURATED).** ' +
        'Fix the library as a REGISTRY of reusable starters — each a real ' +
        'built foundation with `{ stack, type, sourceRepo, provenance }` ' +
        'metadata — that PROVISIONING consults: if a starter MATCHES the new ' +
        'project’s stack/type, FORK it (the fast path); else fall back to the ' +
        'scaffold registry. Fix that the library GROWS from hosted builds (the ' +
        'flywheel) and that promotion is HUMAN-GATED (a human blesses a built ' +
        'foundation before it becomes a starter — an un-reviewed starter ' +
        'poisons every project that forks it). The 2 existing starters are the ' +
        'first entries, not a fixed gallery.\n' +
        '4. **The handoff (TRANSFER + App re-install).** Fix handoff as: ' +
        'transfer the Motir-owned repo to the user’s account/org via the ' +
        'GitHub repo-transfer REST API (`POST /repos/{owner}/{repo}/transfer`, ' +
        '`new_owner` — web-verified; async; a personal-account target must ' +
        'ACCEPT), THEN the user re-installs the Motir App on their account/org ' +
        'and selects the now-their repo (a GitHub App installation is ' +
        'account-scoped, so transferring the repo out of Motir’s org takes it ' +
        'out of Motir’s install scope — the re-install keeps dispatch + the ' +
        'code-graph index working). Fix that it is a GUIDED, COORDINATED flow ' +
        '(a raw out-of-band transfer breaks sync — the Lovable lesson, ' +
        'web-verified), and that for a BYOK project handoff is a no-op.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/hosted-repo.md` exists and fixes repo ownership ' +
        '(Motir-org-owned default + the naming/visibility + the 7.7.3 ' +
        'installation reuse), the per-stack one-line scaffold registry ' +
        '(scaffold-then-build, the runner isolation), the starter library ' +
        '(fork-a-match-else-scaffold + the curated flywheel), and the handoff ' +
        '(transfer + App re-install, coordinated; BYOK no-op).\n' +
        '- Every external claim (platform-owned-by-default, the one-line ' +
        'scaffolds, the transfer API + its accept semantics, the ' +
        'account-scoped App installation) CITES the web-verified mirror rather ' +
        'than asserting it.\n' +
        '- It names the org/App-scope/runner inputs 9.3.3 must provision (the ' +
        'Motir GitHub org, the App’s repo-create + repo-transfer ' +
        '[administration] scopes, the scaffold runner, the env keys) — the ' +
        'explicit input to the 9.3.3 manual card.\n' +
        '- `motir-core` carries a short pointer doc to it; the deferrals ' +
        '(GitLab/Bitbucket providers, per-stack foundation CONTENT as plan ' +
        'work, the WF4/5/6 orchestration) are restated as out-of-9.3.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked defaults + the cited mirror).\n' +
        '- Story 7.7.3 — the GitHub App OAuth-identity + INSTALLATION model + ' +
        'the on-demand installation-token mint this REUSES (adding the ' +
        'org-owned-repo create + the transfer; not a new integration).\n' +
        '- Story 9.1 (9.1.7) — the hosted-run orchestration that clones/builds ' +
        'in the repo this provisions (the consumer of 9.3.4).\n' +
        '- The platform-owned-repo + export mirror (web-verified 2026-06-12): ' +
        'Lovable (connect creates a repo; transfer-while-connected breaks ' +
        'sync), Bolt (Export to GitHub), v0 (export to a repo), Replit (Connect ' +
        'to GitHub).\n' +
        '- GitHub docs: the repo-transfer REST API ' +
        '(`POST /repos/{owner}/{repo}/transfer`, async, personal-target must ' +
        'accept) + “Differences between GitHub Apps and OAuth apps” (an ' +
        'installation is account-scoped → re-install after transfer).\n' +
        '- The one-line scaffolds: `create-next-app`, `create-expo-app`, ' +
        '`spring init --dependencies=…` (web-verified canonical one-liners).',
      dependsOn: [],
    },
    {
      id: '9.3.3',
      title:
        'Provision the Motir GitHub org + the App’s repo-create/transfer scopes + the scaffold runners (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** manual/human (no PR — GitHub dashboard / org / secret / ' +
        'infra work, mirror 1.6.7 + the 7.7.2 / 9.1.3 provisioning shape; ' +
        'marked done on Yue’s confirmation). A coding agent cannot create a ' +
        'GitHub org, widen a GitHub App’s permission scopes, or stand up a ' +
        'sandboxed scaffold-runner host + mint its secrets. Wired here via ' +
        '`dependsOn` so the prerequisite is visible at PLAN time (notes.html ' +
        '#30), not discovered at run time.\n\n' +
        'Using the org/scope/runner inventory fixed by 9.3.2:\n\n' +
        '1. **The Motir GitHub org** — create (or designate) the org under ' +
        'which hosted-project repos are created + owned (the platform-owned ' +
        'default). Confirm the Motir GitHub App (registered in 7.7.2) is ' +
        'installed on THIS org with access to create repos in it.\n' +
        '2. **The App’s repo-CREATE + repo-TRANSFER scopes.** Widen the Motir ' +
        'App’s permissions to what create + transfer need beyond 7.7.2’s ' +
        'read-loop set: repository **Administration: Read & write** (the scope ' +
        'the create-repo + transfer-repo REST calls require) on the Motir org ' +
        'install. (7.7.2 deliberately took only `contents:read` + the loop ' +
        'scopes for BYOK repos; hosted-owned repos need the create/transfer ' +
        'admin scope on Motir’s own org — keep it scoped to the Motir org ' +
        'install, not the users’ BYOK installs.)\n' +
        '3. **The scaffold runner(s)** — provision the sandboxed executor host ' +
        'that runs the per-stack one-line scaffolds (`npx create-next-app` / ' +
        '`create-expo-app` / `spring init`) into a fresh repo: a container ' +
        'host with the toolchains (Node for the `npx` scaffolds, a JDK + the ' +
        'Spring CLI for `spring init`) and network egress for the package ' +
        'fetch only, NO long-lived secrets (the 9.1/7.9.7 isolation spirit). ' +
        'Wire the env keys 9.3.2 named (the Motir-org slug, the runner ' +
        'endpoint) on the operated side.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A Motir GitHub org exists with the Motir App installed + able to ' +
        'create repos in it.\n' +
        '- The Motir App has repository Administration: Read & write on the ' +
        'Motir-org install (the create + transfer scope), WITHOUT widening the ' +
        'users’ BYOK installs.\n' +
        '- A sandboxed scaffold runner exists with the Node + Spring ' +
        'toolchains, package-fetch egress, and no baked long-lived secret; the ' +
        'env keys from 9.3.2’s inventory are present on the operated side.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 9.3.2’s org/scope/runner inventory + the ownership/handoff ' +
        'decision.\n' +
        '- 7.7.2 (the Motir GitHub App registration this widens) + 9.1.3 (the ' +
        'hosted-run infra) — the precedent shapes for dashboard + secret + ' +
        'sandbox-host provisioning.\n' +
        '- GitHub docs “Choosing permissions for a GitHub App” (Administration ' +
        'for repo create/transfer) + the repo-create / repo-transfer REST ' +
        'endpoints (the scopes these need).',
      dependsOn: ['9.3.2'],
    },
    {
      id: '9.3.4',
      title:
        'Repo PROVISIONING + per-stack one-line SCAFFOLD — on hosted-project create, create a Motir-owned repo under the org + run the scaffold-command registry into it',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'The provisioning engine (the operated side — motir-ai / the ' +
        'orchestrator, reusing the 7.7.3 GitHub App auth). On HOSTED-project ' +
        'create, give the project a real repo to build in: create a ' +
        'Motir-owned repo under Motir’s org, then lay a real foundation into ' +
        'it via the per-stack one-line SCAFFOLD (the starter-FORK fast path is ' +
        '9.3.5, which falls back to THIS card when no starter matches). This is ' +
        'the unit 9.1.7’s hosted-run orchestration + the WF4/5/6 stories ' +
        'consume.\n\n' +
        '**Create the Motir-owned repo.** Using the Motir App installation on ' +
        'Motir’s org (7.7.3’s on-demand installation token; the ' +
        'Administration scope from 9.3.3), create a PRIVATE repo under the org ' +
        'with the 9.3.2 naming scheme (collision-safe per workspace+project), ' +
        'and persist a `HostedRepo` record `{ id, aiProjectId, owner ' +
        '(Motir org), name, provider (github), provenance ' +
        '(scaffolded | forked_from_starter), starterId?, ownership ' +
        '(motir_owned | transferred), createdAt }` (on the operated side — ' +
        'NOT in motir-core; the open core holds no hosted-repo table). A BYOK ' +
        'project does NOT provision (its repo is the user’s connected 7.7 ' +
        'repo) — guard on the project being hosted.\n\n' +
        '**The per-stack one-line SCAFFOLD registry (scaffold-then-build).** A ' +
        'registry `{ stack, type } → the one-line scaffold command` driving ' +
        'the SANDBOXED 9.3.3 runner: `npx create-next-app …` (web), ' +
        '`npx create-expo-app …` (mobile), `spring init --dependencies=… …` ' +
        '(JVM backend) — the web-verified canonical one-liners — committed + ' +
        'pushed into the fresh repo as the initial skeleton. The scaffold is ' +
        'the FLOOR only; auth/design/infra are PLAN content the hosted build ' +
        'executes later (NOT a fat template — the locked default “B”). An ' +
        'unknown/unsupported stack fails the provision CLEANLY (a typed error ' +
        'the caller surfaces), never a guessed default.\n\n' +
        '**Durable + idempotent (no shortcut).** Provisioning is an async, ' +
        'retryable step (it rides the 9.1/7.1.4 job substrate — a network blip ' +
        'mid-scaffold must not orphan a half-made repo): the operation is ' +
        'idempotent on `aiProjectId` (re-running finds the existing ' +
        '`HostedRepo`, does not double-create), and a failed scaffold leaves ' +
        'the record in a clear `provision_failed` state with the runner log, ' +
        'not a silent half-repo. Per-tenant isolation: one project’s scaffold ' +
        'runner never touches another tenant’s repo.\n\n' +
        '**Open-core boundary.** The repo-create + scaffold run under the Motir ' +
        'App/org credentials on the operated side; motir-core only DISPLAYS the ' +
        '`HostedRepo` over the 7.1 boundary (no GitHub credential, no ' +
        'hosted-repo table in the open core).\n\n' +
        '## Acceptance criteria\n\n' +
        '- On hosted-project create, a PRIVATE repo is created under MOTIR’S ' +
        'org (the 9.3.2 naming scheme) via the Motir App installation token, ' +
        'and a `HostedRepo` record is persisted on the operated side (not in ' +
        'motir-core).\n' +
        '- The per-stack scaffold registry runs the correct one-line command ' +
        '(`create-next-app` / `create-expo-app` / `spring init`) in the ' +
        'sandboxed runner and commits the skeleton into the repo; an ' +
        'unsupported stack fails cleanly with a typed error.\n' +
        '- A BYOK project does NOT provision (guarded on hosted); its repo ' +
        'stays the user’s connected 7.7 repo.\n' +
        '- Provisioning is idempotent on `aiProjectId` (re-run does not ' +
        'double-create) and a failed scaffold yields a `provision_failed` ' +
        'state + the runner log, never a silent half-repo; per-tenant ' +
        'isolation holds.\n' +
        '- Open-core boundary: the create + scaffold run under Motir’s App/org ' +
        'credentials on the operated side; motir-core holds no hosted-repo ' +
        'table and only displays over 7.1.\n\n' +
        '## Context refs\n\n' +
        '- 9.3.2 — the ownership + scaffold-registry decision this implements.\n' +
        '- 9.3.3 — the Motir org + the Administration scope + the scaffold ' +
        'runner this calls.\n' +
        '- 7.7.3 — the GitHub App installation model + the on-demand ' +
        'installation-token mint reused for the repo-create (not a new ' +
        'integration).\n' +
        '- 9.1.7 — the hosted-run orchestration that clones + builds in the ' +
        'repo this provisions (the consumer); 7.1.4 — the job substrate the ' +
        'async provision rides.\n' +
        '- The one-line scaffolds (web-verified): `create-next-app`, ' +
        '`create-expo-app`, `spring init --dependencies=…`.',
      dependsOn: ['9.3.2', '9.1.7'],
    },
    {
      id: '9.3.5',
      title:
        'The STARTER LIBRARY — a registry of reusable starters (the 2 existing + promoted ones); fork a matching starter into the new repo, else fall back to the 9.3.4 scaffold',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'The starter library + the FORK-a-matching-starter fast path that ' +
        'sits in FRONT of 9.3.4’s scaffold (the operated side). A starter is a ' +
        'real, already-built foundation (auth + design + infra) that a hosted ' +
        'build produced and a human blessed (promotion is 9.3.6) — forking one ' +
        'gives the new project a working foundation INSTANTLY, instead of a ' +
        'bare scaffold the plan must build up from zero.\n\n' +
        '**The registry.** A `Starter` record `{ id, name, description, stack, ' +
        'type, sourceRepo (the Motir-org repo the starter lives in), ' +
        'provenance (promoted_from <hostedRepoId>), createdAt }` on the ' +
        'operated side. Seed it with the TWO existing starters as the first ' +
        'entries (their stack/type metadata) — they are the seed of the ' +
        'flywheel, not a fixed gallery; every promotion (9.3.6) adds a row.\n\n' +
        '**The fork-or-scaffold decision (in provisioning).** When 9.3.4 ' +
        'provisions a repo, FIRST consult the library: if a `Starter` MATCHES ' +
        'the project’s `{ stack, type }` (and, where several match, a clear ' +
        'tie-break — most-recently-promoted / best-fit, fixed here), FORK that ' +
        'starter’s repo into the new Motir-owned repo (copy the foundation, ' +
        'set the `HostedRepo.provenance = forked_from_starter` + `starterId`); ' +
        'ELSE fall back to 9.3.4’s per-stack one-line scaffold ' +
        '(`provenance = scaffolded`). Forking gives the project the blessed ' +
        'foundation; scaffolding gives it the bare floor for the plan to build ' +
        'on — the two halves of scaffold-then-build.\n\n' +
        '**Scale + isolation (no shortcut).** The library LIST is paginated/' +
        'lazy (it grows with every promoted build — never “load all rows”). ' +
        'The match lookup is indexed on `{ stack, type }`. A fork is ' +
        'per-tenant isolated (the new repo is the tenant’s; the starter source ' +
        'is read-only). A starter whose source repo is missing/unforkable ' +
        'fails the FORK cleanly and falls back to the scaffold (never a broken ' +
        'half-fork).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `Starter` registry exists on the operated side, seeded with the ' +
        'two existing starters (stack/type metadata), and provisioning ' +
        'consults it BEFORE scaffolding.\n' +
        '- When a starter matches the project’s stack/type, the new repo is ' +
        'FORKED from it (`provenance = forked_from_starter`, `starterId` set); ' +
        'when none matches, provisioning falls back to 9.3.4’s one-line ' +
        'scaffold (`provenance = scaffolded`).\n' +
        '- The match is deterministic (a fixed tie-break when several ' +
        'starters match); an unforkable/missing starter source falls back to ' +
        'the scaffold cleanly (no broken half-fork).\n' +
        '- The library list is paginated/lazy (at-scale) and the match lookup ' +
        'is indexed; per-tenant isolation holds (the fork target is the ' +
        'tenant’s repo; the starter source is read-only).\n' +
        '- Open-core boundary: the library + fork run on the operated side; ' +
        'motir-core only displays the library over 7.1.\n\n' +
        '## Context refs\n\n' +
        '- 9.3.4 — the provisioning engine this fast-path sits in front of ' +
        '(the scaffold is the fallback when no starter matches).\n' +
        '- 9.3.6 — the curated promotion that GROWS this library (the ' +
        'flywheel; the two seeded starters are just the first entries).\n' +
        '- 9.3.2 — the starter-library decision (fork-a-match-else-scaffold + ' +
        'the metadata shape).\n' +
        '- 7.7.3 — the App installation token used to fork into the Motir-org ' +
        'repo.',
      dependsOn: ['9.3.4'],
    },
    {
      id: '9.3.6',
      title:
        'PROMOTE-TO-STARTER (curated) — a built project’s foundation → human-reviewed → promoted into the library (the flywheel)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The flywheel mechanism: turn a real built foundation into a reusable ' +
        'starter, gated on a HUMAN blessing. This is what makes the starter ' +
        'library an OUTPUT of hosted builds rather than a hand-kept gallery — ' +
        'every good foundation a hosted build produces is a candidate to ' +
        'accelerate the next matching project. Promotion is CURATED on purpose: ' +
        'a starter is forked by every matching future project, so an ' +
        'un-reviewed promotion poisons the well — a human MUST bless it.\n\n' +
        '**The promotion flow (the operated side, proxied by motir-core for ' +
        'the human action).** From a hosted project whose foundation the plan ' +
        'built, a curator (a human — a Motir operator, not the build itself) ' +
        'invokes “promote to starter”: the flow captures the candidate’s ' +
        '`{ stack, type }`, a name + description, and the source (the ' +
        'project’s `HostedRepo` at a chosen ref / the foundation-only subset), ' +
        'and requires an explicit human APPROVAL step before it writes a new ' +
        '`Starter` row (9.3.5). No build path auto-promotes — promotion is ' +
        'only ever a deliberate human action.\n\n' +
        '**What gets promoted.** A starter should be the FOUNDATION, not the ' +
        'whole product — capture the auth/design/infra base (a clean ref or a ' +
        'curated subset the curator confirms), so the next project forks a ' +
        'foundation, not someone else’s feature code. Record the provenance ' +
        '(`promoted_from <hostedRepoId>` + the curator + the timestamp) so the ' +
        'library is auditable (which build seeded which starter).\n\n' +
        '**Durability + idempotency.** Promotion is idempotent (re-invoking on ' +
        'an already-promoted ref updates the existing starter rather than ' +
        'duplicating); a starter can be RETIRED (a disabled flag) so a stale ' +
        'starter stops being offered to new projects without deleting its ' +
        'history. The promoted starter immediately becomes available to 9.3.5’s ' +
        'fork match for the NEXT matching create.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A human-invoked promote flow captures `{ stack, type }` + name/' +
        'description + the source ref and writes a new `Starter` row ONLY ' +
        'after an explicit human approval (no auto-promotion from any build ' +
        'path — asserted).\n' +
        '- The promoted starter records its provenance (`promoted_from` the ' +
        'hosted repo + curator + timestamp) and becomes available to 9.3.5’s ' +
        'fork match for subsequent matching projects.\n' +
        '- Promotion is idempotent (re-promoting a ref updates, not ' +
        'duplicates); a starter can be retired (disabled) so it stops being ' +
        'offered without losing history.\n' +
        '- The promoted artifact is the FOUNDATION (a clean ref / curated ' +
        'subset the curator confirms), not arbitrary feature code.\n' +
        '- Open-core boundary: the promotion + library writes live on the ' +
        'operated side; motir-core only proxies the human action + displays ' +
        'over 7.1.\n\n' +
        '## Context refs\n\n' +
        '- 9.3.5 — the starter library this GROWS (a promotion adds a ' +
        '`Starter` row the fork match consults).\n' +
        '- 9.3.2 — the curated-promotion decision (human-gated, the flywheel ' +
        'posture).\n' +
        '- 9.3.4 — the `HostedRepo` a promotion sources from.',
      dependsOn: ['9.3.5'],
    },
    {
      id: '9.3.7',
      title:
        'The GitHub HANDOFF / TRANSFER — guided flow: user connects/creates their GitHub → transfer the Motir repo to their account → the Motir App re-installs (keeps dispatch + index access)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'The handoff: let a user take OWNERSHIP of their hosted repo on their ' +
        'OWN GitHub, without breaking the hosted loop. A user who started ' +
        'hosted (Motir owns the repo) can, on request, have it TRANSFERRED to ' +
        'their account/org — the platform-owned-repo + optional-export shape ' +
        'every hosted builder ships (web-verified). The load-bearing detail: a ' +
        'GitHub App installation is ACCOUNT-scoped, so transferring the repo ' +
        'out of Motir’s org takes it out of Motir’s install scope — so the ' +
        'handoff must RE-ESTABLISH the App grant on the new owner, or dispatch ' +
        '+ the code-graph index stop working (the Lovable “transfer-while-' +
        'connected breaks sync” lesson, web-verified). Builds on 7.7.3 (the ' +
        'OAuth-identity + installation model it re-establishes).\n\n' +
        '**The guided flow (motir-core proxies the user action; the operated ' +
        'side runs the transfer).**\n\n' +
        '1. **Connect the user’s GitHub identity.** Reuse 7.7.3’s OAuth grant ' +
        'so Motir knows the user’s GitHub account, and let them pick the TARGET ' +
        'account/org (their personal account or one of their orgs).\n' +
        '2. **Transfer the repo.** The operated side calls the GitHub ' +
        'repo-transfer REST API (`POST /repos/{Motir-org}/{repo}/transfer` ' +
        'with `new_owner = <the user’s account/org>` — web-verified) under the ' +
        'Motir-org App’s Administration scope (9.3.3). The transfer continues ' +
        'ASYNCHRONOUSLY and, for a PERSONAL-account target, the new owner must ' +
        'ACCEPT it on GitHub (web-verified) — so the flow has a ' +
        '`transfer_pending` state that resolves when the transfer completes ' +
        '(detected via the `repository` transferred webhook / a poll).\n' +
        '3. **Re-install the Motir App on the new owner.** Guide the user to ' +
        'install the Motir App on their account/org and select the now-their ' +
        'repo — landing as a NEW `GithubInstallation` (7.7.3) under the user’s ' +
        'account, so dispatch (the hosted run clones via the user’s install ' +
        'now) + the 7.7.5 code-graph feed keep working. Flip ' +
        '`HostedRepo.ownership = transferred` + record the new owner.\n\n' +
        '**BYOK is a NO-OP.** A BYOK project’s repo was already the user’s and ' +
        'already App-installed (7.7) — handoff short-circuits to a no-op (the ' +
        'UI shows the already-yours state). The transfer path is ONLY for ' +
        'Motir-owned hosted repos.\n\n' +
        '**Durability (no shortcut).** The transfer is a multi-step, ' +
        'partially-async saga: model the states ' +
        '(`requested → transfer_pending → awaiting_reinstall → done`, with a ' +
        '`failed` branch) explicitly so a transfer that the user never accepts ' +
        ', or a re-install they never complete, is RECOVERABLE / re-promptable, ' +
        'not a wedged repo. Idempotent under webhook redelivery.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The guided flow connects the user’s GitHub identity (reusing ' +
        '7.7.3), transfers the Motir-owned repo to the chosen account/org via ' +
        'the repo-transfer REST API under the Motir-org Administration scope, ' +
        'and surfaces the `transfer_pending` / accept step for a personal ' +
        'target.\n' +
        '- After transfer, the user re-installs the Motir App on their ' +
        'account + selects the repo → a new `GithubInstallation` (7.7.3) lands ' +
        'under the user’s account and a subsequent hosted dispatch + the ' +
        'code-graph feed still work (the loop survives handoff); ' +
        '`HostedRepo.ownership = transferred`.\n' +
        '- A BYOK project’s handoff is a clean NO-OP (already the user’s repo, ' +
        'already installed — the already-yours state).\n' +
        '- The transfer saga is state-modelled + recoverable (an unaccepted ' +
        'transfer / incomplete re-install is re-promptable, not wedged) and ' +
        'idempotent under webhook redelivery.\n' +
        '- Open-core boundary: the transfer runs under Motir’s App/org ' +
        'credentials on the operated side; motir-core proxies the user action ' +
        '+ displays over 7.1; no GitHub credential in the open core.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.3 — the OAuth-identity + App INSTALLATION model the handoff ' +
        'reuses (the user-identity grant + the new install on the new owner).\n' +
        '- 7.7.4 / 7.7.5 — the webhook dispatch (the `repository` transferred + ' +
        'the new `installation` events the saga listens for) + the code-graph ' +
        'feed that must keep working post-handoff.\n' +
        '- 9.3.4 — the `HostedRepo` whose `ownership` this flips.\n' +
        '- 9.3.2 — the handoff decision (transfer + App re-install, ' +
        'coordinated; BYOK no-op).\n' +
        '- GitHub docs: the repo-transfer REST API ' +
        '(`POST /repos/{owner}/{repo}/transfer`, `new_owner`, async, ' +
        'personal-target must accept — web-verified) + “Differences between ' +
        'GitHub Apps and OAuth apps” (an installation is account-scoped → ' +
        're-install after transfer). The Lovable lesson: a raw transfer of a ' +
        'connected repo breaks sync (web-verified) — this flow re-establishes ' +
        'the grant.',
      dependsOn: ['9.3.4', '7.7.3'],
    },
    {
      id: '9.3.8',
      title: 'The hosted-repo + starter-library + handoff UI',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the user-facing hosted-repo surfaces EXACTLY as 9.3.1 ' +
        'specifies. This is the UI subtask the design gate guards — it depends ' +
        'on 9.3.1 (design) + 9.3.4 (the provisioned `HostedRepo` it renders) + ' +
        '9.3.7 (the handoff it drives) and is `blocked` until all land. ' +
        '4-layer; it reads/proxies the hosted-repo state over the 7.1 boundary ' +
        '(motir-core holds NO hosted-repo table — it DISPLAYS the operated ' +
        'side’s state + proxies the user-initiated handoff).\n\n' +
        '**The hosted project-repo view** — the Motir-owned repo card ' +
        '(managed-by-Motir framing, the scaffold-vs-fork provenance `Pill`, ' +
        'the stack/type, recent hosted-run commits/PRs link-out, the ' +
        '“Transfer to your GitHub” primary affordance). For a BYOK project, ' +
        'the already-yours state (no Motir-owned repo; handoff is a no-op).\n\n' +
        '**The starter library** — the paginated/lazy browsable list of ' +
        'starters (stack/type metadata, the “promoted from a real build” ' +
        'provenance, per-status `Pill` tones), plus the curate / ' +
        'promote-to-starter surface (the human-gated review + approve step from ' +
        '9.3.6 — a Motir-operator surface, clearly a deliberate human ' +
        'blessing).\n\n' +
        '**The handoff flow** — the guided multi-step (connect GitHub identity ' +
        '→ pick target account/org → transfer → the `transfer_pending` / ' +
        '“accept on GitHub” step → the “re-install the Motir App” step), with ' +
        'the consequence copy explicit (“this moves the repo out of Motir’s ' +
        'management; re-install keeps dispatch + indexing working”).\n\n' +
        '**Tokens + i18n.** References ONLY `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens — no Tier-0 utilities (the ' +
        '`motir-core/CLAUDE.md` colour/shape rules). The provenance + status ' +
        'pills take their tones from the `Pill` grammar (AA on a tint; ' +
        'transfer-failed = `--el-danger` family). Add a `hostedRepo` i18n ' +
        'namespace for all strings (the managed-by-Motir framing, the ' +
        'provenance labels, the handoff steps, the errors) across the locale ' +
        'set the app ships. The list is paginated/lazy (at-scale), never ' +
        'load-all.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The hosted project-repo view renders the Motir-owned repo card per ' +
        'the 9.3.1 mockup (managed-by-Motir framing + the provenance pill + the ' +
        '“Transfer to your GitHub” affordance), composed of the named ' +
        'primitives, ONLY `--el-*` + shape tokens (no Tier-0 utilities); a ' +
        'BYOK project shows the already-yours no-op state.\n' +
        '- The starter library renders paginated/lazy with stack/type + ' +
        'provenance; the curate/promote surface drives 9.3.6 with its explicit ' +
        'human-approval step.\n' +
        '- The handoff flow walks the connect → transfer → ' +
        'transfer-pending/accept → re-install steps with the consequence copy; ' +
        'the transfer-failed / install-revoked error state renders via ' +
        '`--el-danger`.\n' +
        '- A client component never touches the service layer directly; the ' +
        'page is a Server Component reading via a service over the 7.1 ' +
        'boundary (4-layer); motir-core holds no hosted-repo table.\n' +
        '- Mobile + a11y parity with the rest of the app; strings are in the ' +
        '`hostedRepo` i18n namespace.\n\n' +
        '## Context refs\n\n' +
        '- 9.3.1 (the design asset this implements), 9.3.4 (the `HostedRepo` ' +
        'it renders), 9.3.5/9.3.6 (the library + the promote flow), 9.3.7 (the ' +
        'handoff it drives).\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `EmptyState.tsx` — ' +
        'the provenance/status pills + the empty/no-op states.\n' +
        '- `motir-core/app/(authed)/settings/github/` (7.7.7) — the existing ' +
        'GitHub-area layout to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` + `[data-display-style]` ' +
        'tokens.',
      dependsOn: ['9.3.1', '9.3.4', '9.3.7'],
    },
    {
      id: '9.3.9',
      title: 'Vitest — provisioning + scaffold + starter-fork + transfer-and-reinstall',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Vitest suite over real Postgres (the test convention — the operated ' +
        'side mirrors motir-core’s truncate-between-tests harness). Covers ' +
        'provisioning, the scaffold registry, the starter-library fork/' +
        'fallback, the curated promotion, and the transfer-then-reinstall ' +
        'handoff at the unit/integration level. GitHub + the scaffold runner ' +
        'are stubbed at the HTTP/process boundary (recorded API responses + a ' +
        'fake scaffold that writes a skeleton) — the external calls are ' +
        'mocked, but the provisioning/fork/promotion/handoff LOGIC runs the ' +
        'real path.\n\n' +
        '**Provisioning + scaffold** (`9.3.4`): a hosted-project create ' +
        'creates a Motir-org repo (mocked GitHub) + persists a `HostedRepo`; ' +
        'the per-stack registry runs the right one-line command (asserted via ' +
        'the fake runner — Next vs Expo vs Spring); an unsupported stack fails ' +
        'with a typed error; a BYOK project does NOT provision; re-run is ' +
        'idempotent on `aiProjectId` and a failed scaffold yields ' +
        '`provision_failed` + the log (not a half-repo).\n\n' +
        '**Starter library fork/fallback** (`9.3.5`): with a seeded matching ' +
        'starter, provisioning FORKS it (`provenance = forked_from_starter`, ' +
        '`starterId` set); with none, it falls back to the scaffold ' +
        '(`provenance = scaffolded`); the match is deterministic under a ' +
        'multi-match tie-break; an unforkable starter source falls back ' +
        'cleanly; the library list paginates.\n\n' +
        '**Curated promotion** (`9.3.6`): a human-approved promote writes a ' +
        '`Starter` (provenance `promoted_from` + curator + timestamp) that the ' +
        'next matching create forks; NO build path auto-promotes (asserted: ' +
        'promotion requires the explicit human approval); re-promote is ' +
        'idempotent; a retired starter stops being offered.\n\n' +
        '**Transfer + reinstall handoff** (`9.3.7`): the transfer saga calls ' +
        'the repo-transfer API (mocked) with `new_owner`, models the ' +
        '`transfer_pending` → `awaiting_reinstall` → `done` states, and after ' +
        'a new `GithubInstallation` (7.7.3) lands on the user’s account flips ' +
        '`HostedRepo.ownership = transferred`; a BYOK handoff is a no-op; the ' +
        'saga is recoverable (unaccepted transfer re-promptable) + idempotent ' +
        'under webhook redelivery.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` runs the new specs green over a real Postgres; the only ' +
        'mocks are the GitHub HTTP boundary (repo create/transfer, ' +
        'installation) + the scaffold runner process (+ the standing ' +
        '`getSession()` exception) — every DB/internal call goes the real path ' +
        '(`motir-core/CLAUDE.md`).\n' +
        '- A deliberately unsupported stack FAILS the typed-error test (proves ' +
        'the guard); a build attempting to auto-promote FAILS the ' +
        'human-approval-required test.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — no untested branch in the ' +
        'fork/scaffold decision or the transfer saga.\n\n' +
        '## Context refs\n\n' +
        '- 9.3.4 / 9.3.5 / 9.3.6 / 9.3.7 (everything under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the truncate-between-tests ' +
        'harness (mirrored on the operated side).',
      dependsOn: ['9.3.4', '9.3.7'],
    },
  ],
};
