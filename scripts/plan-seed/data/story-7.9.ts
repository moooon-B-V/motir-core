import type { PlanStory } from '../types';

/**
 * Story 7.9 — the Motir CLI (`motir`): terminal dispatch of the work loop.
 *
 * **Why (Yue's direction, 2026-06-10).** The user-facing form of the loop the
 * planner runs by hand today: `motir next` dispatches the next ready work
 * item to the user's own coding agent; `motir auto` keeps dispatching, one
 * by one, until the ready set drains. This productizes `motir run` /
 * `motir next` for every Motir user — the BYOK execution path the plan
 * has promised since story 7.0 shipped `/api/ready/next` naming "the BYOK
 * `motir run` CLI" as its consumer.
 *
 * **Mirror status: justified deviation, same escape clause as 7.0.** Jira and
 * Linear ship no "run the next work item with your coding agent" CLI — this
 * is Motir's AI-coding-native differentiator, not a mirrorable surface.
 * The concrete use case is recorded (the dogfood loop Yue runs daily, then
 * every BYOK user); the precedent is story 7.0's recorded deviation for the
 * same surface family.
 *
 * **Architecture: the CLI is an MCP CLIENT of the 7.8 server. One agent
 * surface, one auth path.** Every command speaks to the tenant through the
 * `/api/mcp` streamable-HTTP endpoint with a 7.8.1 PAT (`Authorization:
 * Bearer`) — `list_ready`, `next_ready`, `get_work_item`,
 * `transition_status`, `list_sprints`, `search_work_items` are exactly the
 * tools the CLI needs, already permission-scoped per token. NO parallel REST
 * client, NO second auth wiring on the session-authed routes: if the CLI
 * needs a capability, it lands as an MCP tool first (where every other agent
 * gets it too), then the CLI consumes it. This also makes the CLI a living
 * integration test of the MCP surface.
 *
 * **Prompt generation is SERVER-side (stub 7.6), consumed here.** The
 * dispatch payload's `descriptionMd` + `contextRefs` is not the full
 * canonical agent prompt (MOTIR.md § Prompt structure: CONTEXT / WHAT TO
 * DO / ACCEPTANCE CRITERIA / GIT WORKFLOW, per-type variants). 7.6 owns
 * generating that server-side — one source of truth for every dispatch
 * surface (web "copy prompt", CLI, the future native AI-coding layer). The
 * CLI's dispatch commands therefore carry a story-level dep on 7.6 (the
 * 2.6.x / 6.7 precedent for unexpanded siblings; retarget to the concrete
 * subtask when 7.6 expands). Listing/auth/linking commands don't need 7.6.
 *
 * **Multi-repo projects are the NORM — and the link binds a FOLDER to a
 * PROJECT, not repos (Yue, 2026-06-10, two refinements).** A Motir project
 * usually spans several repos (Motir itself is `motir-core` +
 * `motir-ai`), AND a brand-new project starts from an EMPTY folder — the
 * plan's first work items are what CREATE the repos (Motir's own 1.0.1
 * scaffolded motir-core into an empty directory). So `motir link` does
 * exactly one thing: bind the **workspace root** directory to a server +
 * workspace + project. **Repo paths are CONVENTION, not configuration:**
 * the item's `targetRepo` resolves to `<root>/<repoName>` by default — the
 * plan knows its repo names before the repos exist (planning names them,
 * e.g. "motir-core", at plan time), so convention covers the new-project
 * flow from item one with NOTHING to link. `.motir.json` carries
 * `{ serverUrl, workspace, project }` plus an OPTIONAL `repos` override map
 * for the exceptions (a checkout living elsewhere / under a different
 * name): `motir link add <repo> <path>` / `remove` manage overrides only.
 * Running `link` in an empty folder is therefore first-class — bind and
 * go. Commands resolve `.motir.json` by walking UPWARD from cwd, so
 * invoking from inside `motir-core/` still sees the whole root — ONE
 * `motir auto` loop serves the whole project, dispatching each item INTO
 * its target repo's checkout (cwd of the agent process). The item→repo
 * association comes from the dispatch payload's structured `targetRepo`
 * field — sourced by 7.6's prompt/dispatch generation (the card prose
 * already names "Repo:" per subtask; 7.6 makes it structured) and upgraded
 * to the real repo entity when 7.7's GitHub/repo model lands; rides the
 * existing 7.6 dep, no new edge.
 *
 * **Missing-checkout semantics (the bootstrap rule).** When the resolved
 * path does not exist, the only sane reading is "this item bootstraps the
 * repo" — the agent runs with cwd = the workspace root, and the generated
 * prompt's GIT WORKFLOW for a scaffold item already instructs creating the
 * checkout (clone the fresh remote / scaffold into `./<repoName>`). After
 * the agent exits 0, the CLI VERIFIES the conventional path now exists:
 * present → routing for every later item of that repo just works (nothing
 * was ever "linked"); absent → the dispatch is reported as suspect (the
 * item claimed repo X but produced no `./X` — named in the output/summary
 * with a `motir link add` hint for the off-convention case). The CLI never
 * guesses an item into a DIFFERENT existing checkout.
 *
 * **Agent execution model.** The CLI does NOT bundle an agent. `motir next`
 * default-prints the prompt (explicit BYOK copy-paste); `--agent "<cmd>"`
 * (or the config's `agentCommand`) executes the user's own CLI agent
 * headlessly (e.g. `claude -p`), feeding the prompt via stdin or a temp
 * file, surfacing the exit code. Per-item worktree/branch/commit mechanics
 * stay INSIDE the generated prompt's GIT WORKFLOW section — the agent does
 * the item's git work. The CLI touches git ONLY for `motir auto`'s
 * session-level bookkeeping (create the session branch at loop start, push
 * it + open the final PR at loop end — below); it never edits or commits
 * code itself.
 *
 * **Integration modes (Yue, 2026-06-10) — how finished work reaches main,
 * and what unlocks the next item.** Dispatch always flips the item to
 * `in_progress` first; what happens at agent-success differs by mode:
 *
 *   1. **`motir next` (single item):** if the item's deps are all done (on
 *      main), the prompt's GIT WORKFLOW is today's manual flow — branch
 *      from origin/main, open ONE PR for the item, stop; the human
 *      reviews/merges, then `motir done <key>`. **If any dep is
 *      integrated-awaiting-review** (its recorded `session_branch` is what
 *      made this item ready — 7.8.11), the item JOINS that lineage: the
 *      dispatch payload carries the inherited `sessionBranch`, the prompt
 *      instructs branching from / integrating into THAT branch (the dep's
 *      code isn't on main, so a per-item PR to main would not even build),
 *      and on success the item is `mark_integrated` on the same branch.
 *   2. **`motir auto` (always the SESSION-BRANCH mode — no alternative):**
 *      a WHILE loop, never a batch drain (Yue, 2026-06-10): the CLI never
 *      fetches the ready list up front — the set CHANGES during the run —
 *      it asks `next_ready` for ONE item per iteration, runs it, and loops
 *      until nothing is ready. A ready UNEXPANDED epic/story (childless =
 *      ready per 7.0.10) is a planning item: skipped + reported by default;
 *      `--include-planning` (7.9.8) instead fires its async server-side
 *      expansion (7.4) WITHOUT waiting and moves on — the expansion's new
 *      children join the ready set mid-run and later iterations pick them
 *      up. At loop start the CLI creates a session branch off the LATEST
 *      origin/main in each repo it dispatches into (e.g.
 *      `motir/auto-<run-id>`). Every item's prompt instructs the agent to
 *      integrate its work into THAT branch (branch-from + merge-back
 *      inside the session line, no per-item PR). On agent success the CLI
 *      calls `mark_integrated(key, sessionBranch)` (7.8.11): the item
 *      moves to **`in_review`** — NOT done; the work isn't on main yet —
 *      with the session branch RECORDED on the work item. The 7.8.11
 *      integrated-dep readiness rule (a dep with a recorded session
 *      branch satisfies its dependents) is what lets `next_ready` unlock
 *      the item's dependents WITHIN the run, so the loop cascades through
 *      the dependency graph instead of draining only the initially-ready
 *      set — and the recorded branch is what the dependents' prompts are
 *      built against. At loop end (drained, --max, halt, or Ctrl-C) the
 *      CLI pushes each touched repo's session branch and opens ONE PR per
 *      touched repo (session branch → main) listing every carried item —
 *      the human reviews the whole run as one unit. **Close-out:** after
 *      merging the session PR, `motir done --session <branch>` (the
 *      `complete_session` tool) flips every item recorded on that branch
 *      to done and clears the field; rejecting the PR instead leaves the
 *      items honestly in `in_review` — flip them back to in_progress (or
 *      re-dispatch) and the field clears with the new outcome. Statuses
 *      never claim main has work it doesn't have.
 *   3. **`motir batch` (snapshot mode — per-item PRs to main, NO session
 *      branch; Yue, 2026-06-10):** the complement of `auto`. Freeze a
 *      SNAPSHOT of the ready set NOW and implement exactly those items,
 *      one at a time; items that become ready DURING the run are
 *      deliberately NOT picked up (re-run, or use `auto`). No session
 *      branch is needed because a strictly-ready snapshot is MUTUALLY
 *      INDEPENDENT by construction — every item's deps are already done
 *      on main, so no snapshot item can depend on another (it would not
 *      be ready otherwise). Each item therefore rides mode 1's per-item
 *      flow: its own branch off origin/main, its own PR targeting main,
 *      item stays in_progress until the human merges and runs
 *      `motir done <key>`. The snapshot takes STRICT main-readiness only
 *      — an item ready via a 7.8.11 integrated-awaiting-review dep is
 *      excluded (its dep's code is not on main; that lineage belongs to
 *      `auto`'s session mode). 7.9.10.
 * **REJECTED: `--auto-merge` (Yue, 2026-06-10 — same day, retracted).** A
 * mode where the agent merges its own per-item PRs straight to main was
 * considered and REJECTED as dangerous: an unattended loop must never
 * advance main without a human review. Main only ever moves through a
 * human-merged PR — `motir next`'s per-item PR or `motir auto`'s
 * end-of-run session PR. Do NOT re-add an auto-merge-to-main flag in a
 * future expansion; the session branch IS the unattended mode, and its
 * human gate is the point.
 *
 * The GIT WORKFLOW section is therefore a DISPATCH-TIME PARAMETER of the
 * server-side prompt generation: the dispatch request carries the mode +
 * session-branch name, and 7.6 renders the matching workflow block (one
 * template, two variants: per-item PR for `next`, session-branch for
 * `auto` — recorded here as a requirement on 7.6's expansion; the
 * story-level dep already exists).
 *
 * **The sandbox container (unattended runs need walls, not vibes).**
 * `motir auto --agent "claude --dangerously-skip-permissions"` is the
 * natural unattended form — and it must NOT run on the user's host. 7.9.7
 * ships a reference container (the shape of the dev sandbox Motir itself
 * is built in): an image with node/git/gh + a mounted workspace root +
 * mount points for the user's agent credentials, so the
 * skip-permissions agent is confined to the project checkouts. Running
 * `motir auto` on the host with a permission-prompting agent (manual
 * approval in a normal console) stays fully supported — the container is
 * the recommended path for the unattended mode, not a requirement.
 *
 * **Packaging: `packages/cli` workspace package, binary `motir`.** The repo
 * already carries `pnpm-workspace.yaml`; the CLI lands as the first real
 * workspace package (own package.json, `bin: { motir }`, bundled with a
 * standard TS CLI build — evaluate commander vs yargs + tsup vs esbuild at
 * build time and record the pick; node >= 22). It ships from the repo first
 * (installable via the checkout / `pnpm --filter cli`); **publishing the
 * `@motir/cli` npm package is Epic-8 work** (8.7 — gated on the Motir
 * name-securing prerequisite), NOT a 7.9 dep: a forward-pointing 7.9 → 8.7
 * dep would fail the cross-epic audit, and in-repo install needs no
 * publish.
 */
export const story_7_9: PlanStory = {
  id: '7.9',
  title: 'Motir CLI — terminal dispatch of the work loop (`motir next` / `motir auto`)',
  status: 'planned',
  gitBranch: 'story/PROD-7.9-motir-cli',
  descriptionMd:
    "The command-line tool that runs Motir's execution loop from the terminal: `motir next` " +
    "dispatches the next ready work item to the user's own coding agent, `motir auto` keeps " +
    'dispatching one item at a time until the ready set drains. Full command set: `motir auth ' +
    'login|status|logout` (PAT), `motir link` (bind a WORKSPACE ROOT directory — possibly ' +
    'EMPTY for a new project — to a project; repo checkouts resolve by CONVENTION ' +
    '`<root>/<repoName>`, with an optional override map for exceptions), ' +
    '`motir ready` (the ready set), `motir status` (project pulse), `motir next` / `motir run ' +
    '<key>` (dispatch one), `motir done <key>` / `motir done --session <branch>` (close-out ' +
    'after the human merges — per item, or every item a session branch carries), `motir auto` ' +
    '(the loop — a WHILE loop asking `next_ready` for ONE item per iteration, never a ' +
    'pre-fetched list (the ready set changes mid-run), until nothing is ready; a ready ' +
    'unexpanded epic/story is skipped + reported by default, or `--include-planning` (7.9.8) ' +
    'fires its async 7.4 expansion without waiting and moves on; ' +
    'ALWAYS session-branch mode: one branch off latest main per touched repo, ' +
    'items integrate into it and move to IN_REVIEW with the branch recorded on the work item ' +
    '(7.8.11) so dependents cascade mid-run and their prompts build against that branch; ONE ' +
    'end-of-run PR per repo; auto-merging to main was rejected as dangerous — main only moves ' +
    'through a human-merged PR), ' +
    '`motir batch` (the snapshot complement of auto — freeze the ready set NOW and implement ' +
    'exactly those items one by one, each as its OWN per-item PR to main with NO session ' +
    'branch: a strictly-ready snapshot is mutually independent by construction, every dep ' +
    'already done on main; mid-run unlocks wait for the next run — 7.9.10), ' +
    '`motir open <key>` (jump to the browser), and `motir plan "<description>"` / `motir plan ' +
    '<KEY>` (terminal planning — generate/augment the tree or expand a stub via the async ' +
    '7.3/7.4 engine, pushing a consent-gated local code-context bundle so the planner sees the ' +
    "user's code — 7.9.9; the web chat's server-side counterpart is the 7.7 GitHub App read " +
    'path per the 7.5 code-access decision). A reference SANDBOX container ships for the ' +
    'unattended form (`--agent "claude --dangerously-skip-permissions"` confined to the ' +
    'mounted workspace; manual-approval console runs stay supported). Built as an MCP client ' +
    'of the 7.8 ' +
    'server (one agent surface, one auth path — PAT bearer), consuming 7.6 server-side prompt ' +
    'generation; the agent itself is the user\'s own (`--agent "claude -p"` or copy-paste). ' +
    'Lives in `packages/cli` (first workspace package), package `@motir/cli` with the binary ' +
    'named `motir` per the 8.7 name decision (finding #83 — the bare npm name is ' +
    'registry-blocked); npm publishing belongs to Epic 8 (name securing gates it).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev`, `pnpm db:seed`, ' +
    '`pnpm dev` (the MCP endpoint must be live).\n' +
    '- Create a PAT in Settings → Account → API tokens. **Start from an EMPTY scratch ' +
    'folder** (the new-project flow): `motir auth login` (paste the token; `motir auth ' +
    'status` shows the resolved user), then `motir link` — bind workspace/project; ' +
    '`.motir.json` lands with NO repo entries (no secrets in it).\n' +
    "- Dispatch the project's scaffold item with the fake agent: the agent runs at the " +
    'root, creates `./<repoName>` (per its prompt), and the CLI confirms the checkout now ' +
    'exists; the NEXT item targeting that repo dispatches with cwd INSIDE `./<repoName>` — ' +
    'nothing was ever linked by hand.\n' +
    '- With two checkouts present (the motir-core + motir-ai shape), run `motir ready` ' +
    'from INSIDE one repo — the upward `.motir.json` resolution finds the binding; dispatch ' +
    "an item that targets the OTHER repo and verify the agent runs in that repo's " +
    'directory.\n' +
    '- `motir ready` lists the same set the /ready page shows; `motir status` shows the ' +
    'project pulse (ready / in-progress / sprint).\n' +
    '- `motir next --print` flips the picked item to **In progress** on the live board and ' +
    'prints the full canonical prompt (CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / GIT ' +
    'WORKFLOW).\n' +
    '- `motir next --agent "./fake-agent.sh"` (a script that records its stdin and exits 0) ' +
    'executes the agent with the prompt and reports success; exit 1 from the agent surfaces ' +
    'as a dispatch failure with the item left in_progress and named in the output.\n' +
    '- Merge the (pretend) PR, run `motir done <key>` — the item flips to Done on the board.\n' +
    '- `motir auto --agent "./fake-agent.sh"` on a fixture with a dependency CHAIN: a session ' +
    'branch appears off latest main, items dispatch one-by-one and move to **In review** with ' +
    'the branch recorded on each card (visible on the issue detail) as they integrate — ' +
    'dependents unlock MID-RUN off that recorded branch — and the run ends with the session ' +
    'branch pushed + ONE PR per touched repo listing every carried item; the summary table ' +
    'lists every item with its outcome; a mid-loop agent failure halts by default and ' +
    '`--keep-going` skips past it (the failed item stays in_progress, excluded from ' +
    're-dispatch) — the end-of-run PR still opens with what integrated cleanly.\n' +
    '- Verify main NEVER moved during the run — every change sits on the session branch ' +
    'behind the un-merged end-of-run PR (the no-auto-merge-to-main invariant), and NO item ' +
    'claims done.\n' +
    '- Merge the session PR, run `motir done --session <branch>` — every carried item flips ' +
    'to Done on the board in one shot and the recorded branches clear.\n' +
    '- (Once the 7.3/7.4 engine is live) `motir plan <KEY>` on a stub story expands it and ' +
    'prints the new children; `motir plan "<description>"` first prints the code-context ' +
    'bundle manifest and uploads NOTHING until you confirm — decline and verify no code left ' +
    'the machine, confirm and verify the tree lands in the live project.\n' +
    '- `motir batch --agent "./fake-agent.sh"` on a fixture where finishing item A unlocks ' +
    'item B: the snapshot is printed up front, every snapshot item lands its OWN PR ' +
    'targeting main (no session branch exists anywhere), and B is NOT dispatched — the ' +
    'summary counts it as "became ready during the run".\n' +
    '- Revoke the PAT → every command fails with the auth error and a re-login hint.',
  items: [
    {
      id: '7.9.1',
      title:
        'CLI scaffold — `packages/cli` workspace package, MCP client core, `motir auth login|status|logout` + `motir link`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The package and the two substrates every command shares: the authenticated MCP ' +
        'client and the config/linking layer.\n\n' +
        '**Package.** `packages/cli` — the first real workspace package (the repo already has ' +
        '`pnpm-workspace.yaml`; extend its globs if needed and keep the Next app build ' +
        'unaffected). `package.json` name `@motir/cli` (the bare `motir` npm name is ' +
        'registry-blocked — finding #83), `bin: { "motir": ... }`, node >= 22, ' +
        'standard TS CLI toolchain (evaluate commander vs yargs + tsup vs esbuild at build ' +
        'time, record the pick in the package README). NOT published to npm in this story — ' +
        'in-repo install (`pnpm --filter @motir/cli...`) is the 7.9 distribution; publishing is ' +
        'Epic-8 (name securing).\n\n' +
        '**MCP client core (`src/client.ts`).** One shared module: connect to ' +
        '`<serverUrl>/api/mcp` (streamable HTTP, official `@modelcontextprotocol/sdk` ' +
        'client) with `Authorization: Bearer <PAT>`; typed wrappers over the tools the CLI ' +
        'consumes (`list_ready`, `next_ready`, `get_work_item`, `transition_status`, ' +
        '`list_sprints`, `search_work_items`); auth failures map to a single "token ' +
        'invalid/expired — run `motir auth login`" error path.\n\n' +
        '**Auth commands.** `motir auth login` — prompt for server URL + PAT (or flags), ' +
        'validate by connecting and listing tools, store in the user config ' +
        '(`~/.config/motir/config.json`, chmod 600 — the PAT never lands in a repo file); ' +
        '`auth status` — resolved server + token prefix + owning user; `auth logout` — ' +
        'remove the stored token.\n\n' +
        '**Linking (folder → project; repos by convention — the story-header design).** ' +
        '`motir link` — run at the WORKSPACE ROOT (the directory that holds, or WILL hold, ' +
        "the project's repo checkouts — an EMPTY folder for a new project is first-class: " +
        'bind and go, the first scaffold items create the checkouts). Interactive (or ' +
        '`--workspace/--project` flags): pick the workspace + project; that is the whole ' +
        'binding. Written to `.motir.json` at that root: `{ serverUrl, workspace, project, ' +
        'repos?: { "<repo>": "<relative path>", … } }` — the `repos` map is OPTIONAL ' +
        'OVERRIDES only (default resolution is the convention `<root>/<repoName>`); server ' +
        'URL + slugs + paths only, NEVER the token (safe to commit). `motir link add <repo> ' +
        '<path>` / `motir link remove <repo>` manage overrides; bare `motir link` re-run ' +
        'shows + edits the binding and lists how each known repo currently resolves ' +
        '(convention or override, exists or not-yet). Single-repo projects: run it in the ' +
        'repo root → an override `"<repo>": "."`. Commands resolve `.motir.json` by walking ' +
        'UPWARD from cwd (so every command works from inside any checkout), overridable ' +
        'with `--project`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm --filter @motir/cli build` produces a runnable `motir` binary; the root app ' +
        'build/test/lint pipelines are unaffected (CI lanes stay green with the workspace ' +
        'package present).\n' +
        '- `auth login` rejects an invalid/revoked PAT at login time (validation round-trip); ' +
        'a valid one persists with 0600 perms and `auth status` resolves the user.\n' +
        '- `.motir.json` contains no secret; commands error with a clear "run `motir link`" ' +
        'message when no link is found.\n' +
        '- `motir link` succeeds in an EMPTY folder (binding only, no repo entries — the ' +
        'new-project flow); at a root with checkouts it reports how each known repo ' +
        'resolves (convention/override, exists/not-yet); `link add`/`link remove` edit ' +
        'overrides and round-trip; resolution walks upward from inside any checkout; a ' +
        'single-repo link yields the one-entry "." override (same file shape, no special ' +
        'case).\n' +
        "- Every wrapper surfaces MCP tool errors with the tool's typed message (no " +
        'swallowed JSON-RPC errors).\n\n' +
        '## Context refs\n\n' +
        '- `lib/mcp/registry.ts` + the 7.8.4 endpoint (the server being consumed)\n' +
        '- `lib/services/apiTokensService.ts` (7.8.1 — what a PAT is)\n' +
        '- `pnpm-workspace.yaml`, root `package.json` (workspace wiring)\n' +
        '- story-7.9 header (architecture: MCP-client-only, no parallel REST path)\n\n' +
        '**Branch.** `subtask/PROD-7.9.1-cli-scaffold-auth`.',
      dependsOn: ['7.8.1', '7.8.4'],
    },
    {
      id: '7.9.2',
      title: 'Read commands — `motir ready`, `motir status`, `motir open <key>`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'The read surface — everything a user checks before and between dispatches.\n\n' +
        "- `motir ready` — the linked project's ready set via `list_ready`: table of key, " +
        'type, title, priority, estimate (the /ready page row, terminal form), with ' +
        "`--kinds`, `--assignee`, `--json`. Paginates with the tool's cursor — renders all " +
        'pages for the table but NEVER more than the server page size per call.\n' +
        '- `motir status` — the project pulse, composed from existing tools (NO new server ' +
        'surface): ready count (`list_ready`), in-flight items (`search_work_items` with a ' +
        'status-category predicate — the 6.1.1 FilterAST envelope), and the active sprint + ' +
        'dates/goal (`list_sprints`). One compact block, `--json` for scripts.\n' +
        "- `motir open <key>` — print + open the item's web URL in the default browser " +
        '(graceful print-only fallback when no browser is available, e.g. SSH).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir ready` output matches the /ready page set for the same user/project ' +
        '(asserted in the 7.9.5 suite); filters and `--json` work.\n' +
        '- `motir status` shows ready / in-progress / active-sprint from existing tools ' +
        'only; degrades gracefully when the project has no sprints.\n' +
        '- `motir open` resolves the canonical issue URL from the link config (no hardcoded ' +
        'host).\n\n' +
        '## Context refs\n\n' +
        '- 7.9.1 client wrappers; 7.8.4 (`list_ready`), 7.8.6 (`search_work_items`), ' +
        '7.8.10 (`list_sprints`)\n' +
        '- `app/(authed)/ready/` (the page whose set this mirrors)\n\n' +
        '**Branch.** `subtask/PROD-7.9.2-cli-read-commands`.',
      dependsOn: ['7.9.1', '7.8.6', '7.8.10'],
    },
    {
      id: '7.9.3',
      title:
        'Single dispatch — `motir next`, `motir run <key>`, `motir done <key>` (prompt out, agent exec, status flips)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The heart of the CLI: dispatch ONE work item end-to-end.\n\n' +
        '**`motir next`** — `next_ready` (honoring `--kinds`, plus the session exclude list ' +
        'below) → flip the item `in_progress` via `transition_status` → fetch the CANONICAL ' +
        'generated prompt (the 7.6 server-side per-type prompt — CONTEXT / WHAT TO DO / ' +
        'ACCEPTANCE CRITERIA / GIT WORKFLOW; the CLI never assembles its own prompt ' +
        'grammar) → deliver it:\n' +
        '- default `--print`: full prompt to stdout (BYOK copy-paste into any agent), plus a ' +
        'one-line summary to stderr so piping stays clean;\n' +
        '- `--agent "<cmd>"` (or config `agentCommand`): run the user\'s agent CLI with the ' +
        'prompt via stdin AND `$MOTIR_PROMPT_FILE` (a temp file, for agents that take a ' +
        'path), stream its output through, surface its exit code. Success reports "PR ' +
        'opened? review + `motir done <key>`" (manual merge mode); failure leaves the item ' +
        'in_progress, names it, and adds it to the session exclude list.\n\n' +
        '**`motir run <key>`** — same pipeline for an explicit item, with a readiness check ' +
        'first (running a blocked item requires `--force`, mirroring that readiness is ' +
        "dependency-only and the override is the human's call).\n\n" +
        "**`motir done <key>`** — the close-out: `transition_status` → the project's done " +
        'status (the CLI analog of `motir mark <id> done`, run after the human merges the ' +
        "PR in manual mode). Illegal transitions surface the service's allowed-targets " +
        'error verbatim. **`motir done --session <branch>`** — the bulk close-out for a ' +
        'merged SESSION PR: calls `complete_session` (7.8.11), flipping every item recorded ' +
        'on that branch to done and clearing the field; prints the per-item outcomes.\n\n' +
        '**Session-lineage `next` (the 7.8.11 inherited branch).** When the dispatch ' +
        'payload carries an inherited `sessionBranch` (the item is ready BECAUSE a dep is ' +
        'integrated-awaiting-review on that branch), `motir next` does NOT use the ' +
        "per-item-PR flow — the dep's code is not on main, so a PR to main could not even " +
        'build. The prompt (7.6 session variant) instructs branching from / integrating ' +
        'into the inherited branch, and on success the item is `mark_integrated` on it — ' +
        "the item JOINS the session lineage and ships with that session's PR.\n\n" +
        '**Repo routing (convention + bootstrap, story header).** Every dispatch resolves ' +
        "the item's `targetRepo` from the dispatch payload (7.6 sources it; 7.7's repo " +
        'entity upgrades it later): an override from `.motir.json` if present, else the ' +
        'convention `<root>/<repoName>`. Path EXISTS → the agent runs with cwd = that ' +
        'checkout (dispatching a motir-ai item while standing in motir-core works). ' +
        'Path MISSING → the bootstrap rule: the agent runs at the WORKSPACE ROOT (the ' +
        "scaffold prompt's GIT WORKFLOW creates the checkout — the empty-folder new-project " +
        'flow); after exit 0 the CLI verifies the path now exists and reports a suspect ' +
        'dispatch (with a `motir link add` hint for off-convention layouts) if it does ' +
        'not. The CLI never guesses an item into a DIFFERENT existing checkout. `--print` ' +
        'mode prints the target repo + resolved path alongside the prompt so the ' +
        'copy-paste user opens (or creates) the right checkout.\n\n' +
        '**Workflow mode.** `motir next` uses the per-item-PR workflow (branch from ' +
        'origin/main, one PR, stop — the human merges then runs `motir done`). There is NO ' +
        'auto-merge-to-main flag (the story-header rejected decision: main only moves ' +
        'through a human-merged PR). The mode + (for auto) session-branch name travel as ' +
        'DISPATCH-TIME PARAMETERS to the 7.6 prompt generation — the GIT WORKFLOW block ' +
        'is a server-side template variant, never assembled client-side.\n\n' +
        '**Per-item git stays with the agent.** Worktree/branch/commit mechanics live ' +
        "inside the generated prompt's GIT WORKFLOW section — the agent (or human) " +
        "executes them; the CLI's only git surface is `motir auto`'s session-branch " +
        'bookkeeping (7.9.4).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir next --print` transitions the picked item to in_progress on the server ' +
        'and prints the server-generated prompt byte-identical (no client-side prompt ' +
        'assembly).\n' +
        '- `--agent` feeds the prompt via BOTH stdin and `$MOTIR_PROMPT_FILE`; agent exit 0 ' +
        '→ success summary; non-zero → failure summary, item still in_progress, excluded ' +
        'from the next `motir next` in the same session.\n' +
        '- `motir run <key>` refuses a blocked item without `--force`; `motir done <key>` ' +
        'flips to done and an illegal flip shows the allowed transitions.\n' +
        "- Repo routing: an item targeting repo B dispatches with the agent's cwd inside " +
        "B's checkout even when invoked from repo A (convention path, no override needed); " +
        'a MISSING-path item dispatches at the workspace root and the CLI verifies the ' +
        'checkout exists afterward (reported as suspect with the `motir link add` hint when ' +
        'it does not); an item is NEVER executed in a different existing checkout; ' +
        '`--print` names the target repo + resolved path.\n' +
        "- All flips are attributed to the PAT's owning user (visible in the item's " +
        'activity).\n\n' +
        '## Context refs\n\n' +
        "- 7.9.1 client; 7.8.5 (`transition_status`), 7.0's `next_ready` contract " +
        '(`excludeIds`, `kinds`)\n' +
        '- story 7.6 (server-side prompt generation — the story-level dep; retarget to its ' +
        'concrete subtask on expansion)\n' +
        '- `MOTIR.md` § Prompt structure (what the generated prompt must contain — ' +
        'asserted server-side in 7.6, consumed here)\n\n' +
        '**Branch.** `subtask/PROD-7.9.3-cli-dispatch`.',
      dependsOn: ['7.9.1', '7.8.5', '7.8.11', '7.6'],
    },
    {
      id: '7.9.4',
      title:
        '`motir auto` — the sequential WHILE loop (one `next_ready` item per iteration, until none ready)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        "**The shape is a WHILE loop, never a batch drain (Yue's spec, 2026-06-10).** " +
        '`motir auto` MUST NOT fetch the ready list up front — the ready set CHANGES while ' +
        'the run executes (an integrated item unlocks its dependents mid-run; a triggered ' +
        'expansion adds brand-new leaves — 7.9.8). Each iteration asks the server for ' +
        'exactly ONE item (`next_ready`, honoring the exclude list), runs it through the ' +
        "7.9.3 single-dispatch pipeline — STRICTLY one at a time (Yue's spec; no " +
        'concurrent dispatches in this story) — then loops; the loop EXITS when ' +
        '`next_ready` returns empty, and prints a summary table (item, outcome, ' +
        'duration). There is no pre-computed plan-of-the-run anywhere in the ' +
        'implementation — the server is consulted fresh every single iteration.\n\n' +
        '**Semantics (the story-header integration modes):**\n' +
        '- Requires `--agent`/config `agentCommand` (an auto loop has no human to ' +
        'copy-paste; `--print` makes no sense here and errors with guidance).\n' +
        '- **An unexpanded epic/story in the ready set is a PLANNING item, not a ' +
        'dispatchable one — default behavior: SKIP it.** Per the 7.0.10 leaf rule a ' +
        'CHILDLESS epic/story is legitimately ready, but there is no agent prompt for ' +
        '"do the planning" in this subtask: the loop adds it to the exclude list, ' +
        'continues with the next ready item, and the end-of-run summary names it under ' +
        '"needs planning". The `--include-planning` flag that instead TRIGGERS its ' +
        'async expansion is subtask 7.9.8 (gated on the 7.4 expansion engine — kept out ' +
        'of this subtask so the loop does not block on Epic-7 planning work).\n' +
        '- **SESSION-BRANCH mode — the ONLY mode (auto-merge-to-main REJECTED, story ' +
        'header).** At loop start the CLI creates ' +
        '`motir/auto-<run-id>` off the LATEST origin/main in each repo it dispatches into ' +
        "(lazily, on that repo's first item). Each item's prompt (the 7.6 dispatch-mode " +
        'parameter) instructs the agent to integrate its work into that session branch — ' +
        'no per-item PR. On agent success the CLI calls `mark_integrated(key, branch)` ' +
        '(7.8.11): the item moves to IN_REVIEW — never done; main does not have the work ' +
        'yet — with the session branch RECORDED on the work item. The 7.8.11 ' +
        'integrated-dep readiness rule is what unlocks its dependents mid-run (the loop ' +
        'cascades through the dependency graph, not just the initially-ready set), and ' +
        'the recorded branch is what their dispatch payloads carry so 7.6 builds their ' +
        'prompts against it. At loop end — drained, `--max`, halt, or Ctrl-C — the CLI ' +
        'pushes each touched session branch and opens ONE PR per touched repo ' +
        '(session → main) listing every carried item; the human reviews the run as one ' +
        'unit. **Close-out:** after merging the session PR, `motir done --session ' +
        '<branch>` (7.9.3 / the `complete_session` tool) flips every carried item to done ' +
        'and clears the recorded branch; a REJECTED PR leaves the items honestly ' +
        'in_review — the summary names them, flip back or re-dispatch.\n' +
        '- **Main is never auto-advanced.** The loop has no path that merges to main: not ' +
        'the CLI, and not via the prompt (the generated GIT WORKFLOW for auto items ' +
        'integrates into the session branch ONLY). The single end-of-run PR per repo is ' +
        'the human gate.\n' +
        '- **Failure policy:** halt on the first agent failure by default (the failed item ' +
        'stays in_progress and is named); `--keep-going` excludes the failed item ' +
        '(`excludeIds`) and continues with the rest. In session-branch mode a failure ' +
        'NEVER abandons completed work — the end-of-run push + PR still happen for what ' +
        'integrated cleanly.\n' +
        "- Each dispatched item runs in its OWN target repo's checkout per the 7.9.3 " +
        'routing — including the bootstrap case (missing path → dispatch at the root; a ' +
        'bootstrap whose verification fails counts as a dispatch FAILURE) — one loop ' +
        'serves the whole multi-repo project from an empty folder onward.\n' +
        '- `--max <n>` caps dispatches per invocation; `--kinds` filters as in `next`.\n' +
        '- **Interrupt-safe:** Ctrl-C between items exits cleanly with the summary-so-far ' +
        '(and, in session mode, the end-of-run push + PR); mid-agent, the agent process is ' +
        'terminated, the item is left in_progress and named, exit code non-zero.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The implementation provably re-queries per iteration: a fixture where item B ' +
        'becomes ready ONLY as a result of dispatching item A (and did not exist in any ' +
        'pre-run listing) is picked up by the very next iteration; there is no code path ' +
        'that materializes the full ready list before or during the loop.\n' +
        '- An unexpanded (childless) story in the ready set is skipped without a dispatch ' +
        'attempt, the loop continues past it, and the summary lists it under "needs ' +
        'planning"; with children it never surfaces (the 7.0.10 exclusion, asserted as a ' +
        'control).\n' +
        '- On a fixture DEPENDENCY CHAIN (A ← B ← C), `motir auto` with an always-green ' +
        'fake agent dispatches all three in order — B unlocks when A reaches in_review ' +
        "WITH the session branch recorded (the 7.8.11 rule), and B's dispatch payload " +
        'carries that branch — one at a time, exits 0, and ends with the session branch ' +
        "pushed + ONE PR per touched repo listing the carried items; main's ref is " +
        'asserted UNCHANGED across the whole run (the no-auto-merge invariant); no item ' +
        'is done until `motir done --session` runs after the (fixture) merge, which flips ' +
        'all three and clears the recorded branches.\n' +
        '- A mid-loop failure halts by default with a non-zero exit; `--keep-going` ' +
        'finishes the remainder and lists the failure; the failed item is in_progress and ' +
        'never re-dispatched in that invocation; in session mode the end-of-run PR still ' +
        'opens with the completed items.\n' +
        '- The summary names every in_review item with its recorded branch (the unwind / ' +
        'close-out contract); `--max` is honored; Ctrl-C leaves the server state ' +
        'consistent (no half-applied transition) and still lands the session push + PR.\n\n' +
        '## Context refs\n\n' +
        '- 7.9.3 (the single-dispatch pipeline this loops)\n' +
        '- story-7.0.ts (`next_ready` sort/exclude contract)\n' +
        '- MOTIR.md `motir run` (the readiness-is-dependency-only rule the loop ' +
        'mirrors)\n\n' +
        '**Branch.** `subtask/PROD-7.9.4-cli-auto-loop`.',
      dependsOn: ['7.9.3', '7.8.11'],
    },
    {
      id: '7.9.5',
      title: 'Story tests — CLI integration suite against the real MCP endpoint + fake agent',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The story-closing suite (real Postgres, real MCP route, no mocks — the repo ' +
        'contract): spawn the BUILT `motir` binary as a child process against the dev ' +
        'server, with a fake agent script that records its stdin/`$MOTIR_PROMPT_FILE` and ' +
        'exits per fixture.\n\n' +
        '- **Auth + linking:** login with valid/invalid/revoked PATs; commands without a ' +
        'link error with guidance; `.motir.json` resolution from a subdirectory. TWO ' +
        'fixtures: (a) an EMPTY workspace root — link binds with no repo entries, the ' +
        'scaffold item dispatches at the root (fake agent creates `./<repo>`), the next ' +
        'item routes INTO it by convention; (b) a two-checkout root (the motir-core + ' +
        'motir-ai shape) — dispatch routes each item into its target checkout (the fake ' +
        'agent records its cwd), and a failed bootstrap (agent exits 0 but creates ' +
        'nothing) is reported as suspect, asserted in both `next` and `auto`.\n' +
        '- **Read parity:** `motir ready --json` ≡ `list_ready` ≡ the /ready set for the ' +
        'same user.\n' +
        '- **Dispatch:** `next --print` flips in_progress + prints the server prompt ' +
        'verbatim; `--agent` exit-code handling (0 / non-zero); `run --force` on a blocked ' +
        'item; `done` legal + illegal flips.\n' +
        '- **Session-branch integration:** the 7.9.4 dependency-chain fixture — mid-run ' +
        "cascade via in_review + recorded branch (7.8.11), dependents' dispatch payloads " +
        'carrying the inherited branch, end-of-run push + one PR per touched repo, the ' +
        '`motir done --session` close-out round-trip (all items done, branches cleared), ' +
        'the rejected-PR unwind list, and the no-auto-merge invariant (main unchanged ' +
        'across the run).\n' +
        '- **Auto loop:** the 7.9.4 fixture graph end-to-end (the per-iteration ' +
        '`next_ready` re-query — an item made ready only BY the run is dispatched by the ' +
        'same run; the unexpanded-story skip + "needs planning" summary line; halt vs ' +
        '--keep-going, --max, the manual-merge-mode termination case). The ' +
        '`--include-planning` lane rides 7.9.8, not this suite.\n' +
        '- **Attribution:** every transition lands as the PAT user in the revision trail.\n' +
        "- **Coverage:** the per-file ≥90% gate extends to the CLI's client core and " +
        'command modules (wire the package into the root coverage config or its own gate — ' +
        'match the repo convention).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The suite runs in the standard CI lanes (vitest job; no new CI workflow) and is ' +
        'green; the fake agent never needs a real LLM.\n' +
        '- Every command has at least one happy-path and one failure-path assertion.\n' +
        '- `pnpm test:coverage` passes with the CLI files gated.\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts`, `vitest.config.ts` (harness + gate list)\n' +
        '- 7.8.9 (the MCP suite this composes with — shared fixtures where sensible)\n\n' +
        '**Branch.** `subtask/PROD-7.9.5-cli-story-tests`.',
      dependsOn: ['7.9.2', '7.9.3', '7.9.4'],
    },
    {
      id: '7.9.6',
      title: 'Docs — `docs/cli.md` (install, auth, the loop, merge-mode semantics, agent wiring)',
      status: 'blocked',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'The user-facing CLI doc, `docs/jobs.md` register: install from the repo ' +
        '(`pnpm --filter @motir/cli...`; npm install lands with the Epic-8 publish), `auth ' +
        'login` + PAT creation pointer (the 7.8.8 doc), `link`, every command with examples, ' +
        'agent wiring recipes (`--agent "claude -p"` headless and a copy-paste flow), the ' +
        'SESSION-BRANCH semantics (in_review + the recorded branch while the end-of-run ' +
        'PR awaits review, the `motir done --session` close-out, how to unwind a rejected ' +
        'run, and WHY there is no auto-merge-to-main — the rejected-decision note), the ' +
        'failure policy, the SANDBOX recipe ' +
        '(when to use the 7.9.7 container for `--dangerously-skip-permissions` agents vs ' +
        'a manual-approval console run), and troubleshooting (revoked token, no link, ' +
        'blocked item, failed bootstrap).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A reader goes zero → first `motir auto` run from this doc alone; every shipped ' +
        'command + flag is documented with an example.\n' +
        '- The integration-mode section matches the 7.9.4 card exactly (incl. the ' +
        'statuses-ahead-of-main consequence and the unwind path); the sandbox section ' +
        'matches 7.9.7.\n' +
        '- Cross-links: `docs/mcp.md` (tokens/tools) and the /ready page doc surface.\n\n' +
        '## Context refs\n\n' +
        '- `docs/jobs.md`, `docs/mcp.md` (7.8.8) — register + cross-link targets\n' +
        '- 7.9.1–7.9.4 + 7.9.7 cards (the shipped behavior being documented)\n\n' +
        '**Branch.** `subtask/PROD-7.9.6-cli-docs`.',
      dependsOn: ['7.9.4', '7.9.7'],
    },
    {
      id: '7.9.7',
      title: 'Sandbox container — MULTI-AGENT reference image for unattended `motir auto` runs',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'The walls for the unattended mode (the story-header sandbox decision): `motir ' +
        'auto --agent "<agent> <auto-approve-flag>"` must have a confined, reproducible ' +
        'place to run — the shape of the dev sandbox Motir itself is built in — instead ' +
        "of a skip-permissions agent loose on the user's host. Running `motir auto` " +
        'directly in a normal console with a permission-prompting agent remains fully ' +
        'supported; the container is the RECOMMENDED path for unattended runs, not a ' +
        'requirement.\n\n' +
        "**This subtask's scope (refined 2026-06-12, Yue): the container is MULTI-AGENT.** " +
        'Motir is BYOK and agent-agnostic — the sandbox must make the popular coding-agent ' +
        'CLIs first-class, not leave the install entirely to the user. We ship a TESTED ' +
        '**agent-profile matrix** (a documented + CI-built install layer per agent), each ' +
        'selectable at build time, rather than one fat image carrying every agent.\n\n' +
        '**Agent matrix (researched 2026-06-12 — web-verified; see Context refs):**\n\n' +
        '- **Tier 1 — first-class, tested profiles (the four Yue named):**\n' +
        '  - **Claude Code** (Anthropic) — npm `@anthropic-ai/claude-code`; creds `~/.claude`; ' +
        'auto-approve `--dangerously-skip-permissions`. (Terminal-Bench #2, the consensus ' +
        'default for serious work.)\n' +
        '  - **Codex CLI** (OpenAI) — npm `@openai/codex`, Apache-2.0; creds `~/.codex`; ' +
        'auto-approve `--full-auto` (a.k.a. yolo). (Terminal-Bench 2.1 #1 on GPT-5.5.)\n' +
        '  - **OpenCode** — npm / install script, MIT, model-agnostic (the most-starred OSS ' +
        'agent, ~172k★); creds `~/.config/opencode`.\n' +
        '  - **Kimi Code CLI** (Moonshot) — npm (`MoonshotAI/kimi-code`), MIT, TypeScript, ' +
        '**needs Node ≥ 24.15** (the version floor that sets the base image); creds the ' +
        'Kimi config dir; powered by Kimi K2.6.\n' +
        '- **Tier 2 — also-supported profiles (popular, web-verified):**\n' +
        '  - **Antigravity CLI** (Google) — the MANDATORY replacement for the retired ' +
        'Gemini CLI (consumer cutover 2026-06-18); Go binary via ' +
        '`curl -fsSL https://antigravity.google/cli/install.sh | bash`. Include it ' +
        'IN PLACE OF Gemini CLI (do not ship the sunset tool).\n' +
        '  - **Cursor CLI** (Anysphere) — one of the big-vendor four.\n' +
        '  - **Aider** — Python (pip), Apache-2.0; git-native repomap + auto-commits; ' +
        'creds via `~/.aider.conf.yml` / env. (The base adds a thin Python layer for this ' +
        'profile only.)\n' +
        '  - **Goose** (Block) — Apache-2.0, model-agnostic OSS.\n' +
        '- **Tier 3 — generic escape hatch:** any other agent via a build-arg install layer ' +
        '+ `motir auto --agent "<cmd> <flag>"` (the original BYO mechanism, retained).\n\n' +
        '**Deliverable: `packages/cli/sandbox/`** — a reference `Dockerfile` (+ compose ' +
        'profiles + devcontainer.json variant) providing: a base of **node ≥ 24.15** (the ' +
        'Kimi floor; covers every Node agent) + git + `gh` + the built `motir` binary, with ' +
        'a `--build-arg AGENT=claude|codex|opencode|kimi|antigravity|cursor|aider|goose` ' +
        '(or compose profiles) selecting the per-agent install layer (and its extra ' +
        'runtime — Python for aider, the curl-installed Go binary for antigravity). ' +
        "A `/workspace` mount for the user's workspace root (the `.motir.json` tree — the " +
        "ONLY writable host surface); **read-only mounts for the SELECTED agent's " +
        'credentials** (the per-agent path above) + `~/.config/motir` (the PAT); an ' +
        'entrypoint that drops into the workspace so `motir auto` is a one-liner; NO docker ' +
        'socket, NO host filesystem beyond the mounts. Network stays open by default ' +
        '(agents need their APIs + git remotes) — documented explicitly: the container ' +
        'confines the FILESYSTEM blast radius, not egress. We do not redistribute the ' +
        'agents — each profile INSTALLS the third-party CLI from its official source at ' +
        'build time (pinned where the source allows).\n\n' +
        '**Per-agent auto-approve flags differ and DRIFT — treat as VERIFY-at-build, not ' +
        'asserted.** Claude `--dangerously-skip-permissions` and Codex `--full-auto` are ' +
        'verified; the others (opencode / kimi / antigravity / cursor / aider / goose) must ' +
        "have their unattended/auto-approve flag confirmed against the agent's current " +
        'docs in the profile README (flags change release-to-release — notes.html #33: ' +
        'verify per agent, do not assert from memory).\n\n' +
        '## Acceptance criteria\n\n' +
        '- For EACH Tier-1 agent profile (claude / codex / opencode / kimi): ' +
        '`docker build --build-arg AGENT=<x>` succeeds from a clean checkout and the image ' +
        "runs both `motir --version` AND the agent's own `--version` (or equivalent " +
        'liveness check). Tier-2 profiles build in CI too (network permitting; a profile ' +
        'whose install flakes on network is marked allow-fail, not removed).\n' +
        '- A mounted-workspace `motir auto --agent <fake-agent>` runs end-to-end on the ' +
        'base image (asserted in a CI-friendly smoke test that does NOT need a real LLM) — ' +
        'the loop is validated agent-independently; the per-agent layers are validated by ' +
        'their build + version check.\n' +
        '- Writes outside `/workspace` (beyond the credential mounts) fail — asserted in ' +
        'the smoke test; no docker socket inside.\n' +
        '- The base image floors at Node ≥ 24.15 (so the Kimi profile installs cleanly) ' +
        'and every Tier-1 profile mounts its agent-specific credential dir read-only.\n' +
        '- The compose/devcontainer variants carry the same mounts + the agent selector; ' +
        'the README in `packages/cli/sandbox/` documents, PER AGENT: the install source, ' +
        'the credential mount path, and the verified auto-approve flag — plus the global ' +
        'egress caveat. Antigravity is documented as the Gemini-CLI replacement (no Gemini ' +
        'CLI profile ships).\n\n' +
        '## Context refs\n\n' +
        '- 7.9.4 (the loop being confined), 7.9.6 (the docs section this feeds)\n' +
        '- `packages/cli/` (the binary the image bundles)\n' +
        '- Agent landscape (web-verified 2026-06-12): Claude Code ' +
        '(`@anthropic-ai/claude-code`), OpenAI Codex CLI (`@openai/codex`), OpenCode ' +
        '(github sst/opencode), Kimi Code CLI (github MoonshotAI/kimi-code, Node ≥ 24.15), ' +
        'Google Antigravity CLI (antigravity.google/cli — the mandatory Gemini-CLI ' +
        'replacement, consumer cutover 2026-06-18), Cursor CLI, Aider (Python), Goose ' +
        '(Block). Terminal-Bench 2.1: Codex #1, Claude Code #2.\n\n' +
        '**Branch.** `subtask/PROD-7.9.7-cli-sandbox`.',
      dependsOn: ['7.9.4'],
    },
    {
      id: '7.9.8',
      title:
        '`motir auto --include-planning` — trigger async expansion of ready epics/stories, never wait',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        "The planning hook for the while loop (Yue's spec, 2026-06-10). Without the flag, " +
        '7.9.4 SKIPS a ready unexpanded epic/story (a planning item — childless, so ' +
        'legitimately ready per 7.0.10) and just reports it. With `--include-planning`, ' +
        'the loop instead TRIGGERS its expansion and keeps moving:\n\n' +
        '- **Trigger, never wait.** When `next_ready` hands back an unexpanded ' +
        'epic/story, the CLI fires the server-side AI expansion for it (the 7.4 ' +
        'expansion engine, surfaced per the MCP-first rule as an async `expand_item`-' +
        'style tool — the job is queued server-side and the tool returns immediately), ' +
        'adds the item to the in-flight set + exclude list, and IMMEDIATELY asks ' +
        '`next_ready` for the next item. The dispatch loop never blocks on a planning ' +
        'job.\n' +
        '- **Planned work joins the run naturally.** When the expansion lands mid-run, ' +
        'the new child subtasks enter the ready set (deps and all) and later iterations ' +
        'pick them up like any other unlock — no special casing; the parent itself ' +
        'leaves the ready set the moment it has children (7.0.10). This is exactly why ' +
        '7.9.4 forbids a pre-fetched ready list.\n' +
        '- **End-of-loop rule.** `next_ready` empty + NO triggered expansion in flight → ' +
        'exit as in 7.9.4. `next_ready` empty + an expansion still in flight → the loop ' +
        'WAITS (poll `next_ready` on a backoff) until the expansion lands (its children ' +
        'surface as ready) or the job reports failure/empty — "don\'t wait" governs ' +
        'dispatch continuation, not run abandonment: exiting while a plan the run itself ' +
        'queued is about to surface work would strand that work.\n' +
        '- **Failure policy.** A failed/empty expansion is NON-halting (unlike an agent ' +
        'failure): nothing downstream depends on it within the run — the item stays ' +
        'unexpanded, is named in the summary under "planning failed", and the loop ' +
        'continues. `--keep-going` semantics are unchanged.\n' +
        '- The summary table gains a planning section: triggered / landed (with child ' +
        'count) / failed / still-in-flight-at-exit.\n' +
        "- Cross-update `docs/cli.md`'s `motir auto` section (7.9.6 ships before this " +
        'flag lands): the flag, the end-of-loop rule, the planning failure policy.\n\n' +
        '**Dependency note.** The server capability (async expansion of a stub ' +
        "epic/story + its MCP tool surface) is story 7.4's — the dep is story-level " +
        '(the 2.6.x / 6.7 precedent for unexpanded siblings); retarget to the concrete ' +
        '7.4.x subtask when 7.4 expands. Kept OUT of 7.9.4 so the base loop never ' +
        'blocks on the planning layer.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Fixture: a ready unexpanded story whose (fake) expansion creates two child ' +
        'subtasks mid-run — with the flag, the trigger fires, the loop dispatches OTHER ' +
        'ready items while the expansion is pending, and the new children are dispatched ' +
        'by later iterations of the SAME run.\n' +
        '- Drained-but-in-flight: with nothing else ready and one expansion pending, the ' +
        'loop waits, then dispatches the children when they land; if the expansion ' +
        'fails, the loop exits cleanly with the item named under "planning failed" ' +
        '(non-zero only if a DISPATCH failed).\n' +
        '- Without the flag, the same fixture reproduces the 7.9.4 skip behavior ' +
        '(asserted as a control); the trigger is never re-fired for an item already ' +
        'in flight (exclude list holds across iterations).\n' +
        '- The summary planning section reports all four outcomes.\n\n' +
        '## Context refs\n\n' +
        '- 7.9.4 (the while loop this extends — skip default, exclude list, summary)\n' +
        '- stubs.ts story 7.4 (the expansion engine + the MCP-first tool surface)\n' +
        '- story-7.0.ts 7.0.10 (childless epic/story = ready; childed = excluded)\n\n' +
        '**Branch.** `subtask/PROD-7.9.8-auto-include-planning`.',
      dependsOn: ['7.9.4', '7.4'],
    },
    {
      id: '7.9.9',
      title:
        '`motir plan` — terminal planning (describe → tree / expand <KEY>) with a consent-gated local code-context bundle',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The CLI form of the planning front door (the 7.2 web chat is the other; same ' +
        'server-side engine behind both):\n\n' +
        '- **`motir plan "<description>"`** — plan from a prompt: on a fresh project the ' +
        '7.3 generation pass (describe → epic/story/task tree as real issues), on an ' +
        'existing backlog the 7.4 augmentation pass — the server decides by project ' +
        'state; the CLI does not pick.\n' +
        '- **`motir plan <KEY>`** — expand that specific epic/story stub: the explicit ' +
        'form of the SAME async `expand_item`-style tool 7.9.8 fires from the loop.\n' +
        '- **Async, like 7.9.8:** the trigger returns a job; the command streams/polls ' +
        'progress and prints the created/changed tree (keys + titles, indented) on ' +
        'completion. `--detach` returns after the trigger (the 7.9.8 loop semantics); ' +
        'default is to watch.\n\n' +
        "**The code-context bundle — HOW the planner sees the user's code from the " +
        'terminal.** The CLI runs where the code LIVES (the linked workspace root) — its ' +
        'structural advantage over the web chat. Before triggering, it gathers a ' +
        'planning-context bundle from the linked checkouts: the file TREE (per repo, ' +
        '.gitignore-respecting), manifests (package.json / pyproject / go.mod …), ' +
        'contract + docs files (README, CLAUDE.md-class agent contracts, docs/ index), ' +
        'and size-capped excerpts of files the description names — never the whole ' +
        'repo, hard-capped total size. **Consent is explicit:** the bundle MANIFEST ' +
        '(file list + byte counts) prints first and nothing uploads without ' +
        'confirmation (`--yes` for unattended; `--no-context` skips the bundle ' +
        'entirely) — the code crosses into the closed motir-ai layer, so the user ' +
        'sees exactly what leaves the machine; the server side treats it as ' +
        'REQUEST-SCOPED (the 7.5 code-access decision — never persisted). An EMPTY ' +
        'linked folder sends no bundle and plans from the description alone — the ' +
        'new-project kickoff flow stays first-class. (The GitHub App read path — 7.7 → ' +
        '7.5 — is the SERVER-side code-access source for web-chat planning; this bundle ' +
        'is the CLI-side source and the pre-GitHub fallback.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir plan "<desc>"` on a seeded project triggers augmentation, on a fresh ' +
        'empty project triggers generation (fake planner job in tests), watches the ' +
        'job, and prints the resulting tree; `motir plan <KEY>` expands the named stub ' +
        'via the shared 7.9.8 tool; `--detach` returns right after the trigger.\n' +
        '- Bundle: respects .gitignore, includes tree/manifests/contract files, honors ' +
        'the size cap, prints the manifest, and uploads NOTHING without confirmation ' +
        '(`--yes`) — asserted including the refusal path; `--no-context` and the ' +
        'empty-folder case send no bundle and still plan.\n' +
        '- A failed planning job surfaces the server error verbatim, exit non-zero; ' +
        'the PAT permission scoping applies (a read-only token cannot trigger ' +
        'planning).\n\n' +
        '## Context refs\n\n' +
        '- 7.9.1 (client/config), 7.9.8 (the shared expand tool + async-job pattern)\n' +
        '- stubs 7.3 / 7.4 (the engine — story-level deps; retarget on their expansion)\n' +
        '- stubs 7.5 / 7.7 (the code-access decision this implements the CLI half of)\n' +
        '- `.motir.json` / `motir link` (the checkouts the bundle walks)\n\n' +
        '**Branch.** `subtask/PROD-7.9.9-cli-plan-command`.',
      dependsOn: ['7.9.1', '7.9.8', '7.3', '7.4'],
    },
    {
      id: '7.9.10',
      title:
        '`motir batch` — snapshot the ready set, implement one by one, per-item PRs to main (no session branch)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        "The snapshot complement of `motir auto` (Yue's spec, 2026-06-10). `auto` is a live " +
        'while loop — the ready set changes during the run and the loop follows it. `batch` ' +
        'deliberately does the opposite: **freeze a SNAPSHOT of the ready set NOW and ' +
        'implement exactly those items, one at a time.** Items that become ready DURING the ' +
        'run are NOT picked up — the summary counts them ("N became ready during the run — ' +
        're-run `motir batch`, or use `motir auto`").\n\n' +
        '**Why no session branch (the soundness argument, story header mode 3).** A ' +
        'strictly-ready snapshot is MUTUALLY INDEPENDENT by construction: ready = every dep ' +
        'done on main, so no snapshot item can depend on another snapshot item (it would not ' +
        'be ready). Each item therefore rides the 7.9.3 / `next` per-item flow unchanged — ' +
        "its own worktree/branch off origin/main IN ITS TARGET REPO (the prompt's standard " +
        'GIT WORKFLOW; the 7.6 per-item-PR variant, no new prompt variant), its own PR ' +
        'targeting main, item stays in_progress with the PR open. The human reviews each PR ' +
        'and closes out per item with `motir done <key>` — manual merge mode unchanged, main ' +
        'only moves through human-merged PRs. Two snapshot items in the SAME repo simply ' +
        'open two independent PRs off origin/main.\n\n' +
        '**Snapshot filter: STRICT main-readiness.** The snapshot takes `list_ready` items ' +
        'whose deps are ALL done — an item that is ready only via a 7.8.11 ' +
        "integrated-awaiting-review dep is EXCLUDED (its dep's code is not on main, so a " +
        "per-item PR to main could not even build; that lineage is `auto`'s session " +
        'territory) and named in the summary. An unexpanded epic/story in the snapshot is ' +
        'skipped + reported "needs planning" (the 7.9.4 rule); there is NO ' +
        "`--include-planning` here — an expansion's output could never join a frozen " +
        'snapshot, so the flag stays `auto`-only.\n\n' +
        '**Shared loop mechanics (7.9.4):** requires `--agent`/config `agentCommand`; halt ' +
        'on first agent failure by default, `--keep-going` to continue (failed item stays ' +
        'in_progress and is named, the rest of the snapshot proceeds); `--kinds` / `--max`; ' +
        'Ctrl-C exits with the summary-so-far (already-opened PRs stand). Cross-update ' +
        '`docs/cli.md` (7.9.6 ships before this): the batch section + an `auto` vs `batch` ' +
        'comparison table (live loop / session PR vs frozen snapshot / per-item PRs).\n\n' +
        '## Acceptance criteria\n\n' +
        '- On a fixture where finishing item A makes item B ready: `motir batch` prints the ' +
        'snapshot up front, dispatches ONLY the snapshot items, and B is never dispatched ' +
        '(the inverse of the 7.9.4 re-query proof) — the summary counts it as newly ready.\n' +
        '- Every snapshot item lands its own PR targeting main from its own branch; NO ' +
        'session branch is created anywhere in the run; two same-repo items open two ' +
        'independent PRs off origin/main; no `mark_integrated` call is made.\n' +
        '- An integrated-dep-ready item and an unexpanded story are excluded/skipped and ' +
        'named in the summary; failure policy, `--kinds`/`--max`, and Ctrl-C behave as in ' +
        '7.9.4; a read-only PAT cannot dispatch.\n' +
        '- `docs/cli.md` documents batch incl. the auto-vs-batch table.\n\n' +
        '## Context refs\n\n' +
        '- 7.9.3 (the per-item dispatch flow this loops over a frozen list)\n' +
        '- 7.9.4 (shared loop mechanics + the skip rule; the contrast this complements)\n' +
        '- story-7.0.ts (`GET /api/ready` — the snapshot source contract)\n\n' +
        '**Branch.** `subtask/PROD-7.9.10-cli-batch`.',
      dependsOn: ['7.9.3', '7.9.4'],
    },
  ],
};
