import type { PlanStory } from '../types';

/**
 * Story 7.9 — the Motir CLI (`motir`): terminal dispatch of the work loop.
 *
 * **Why (Yue's direction, 2026-06-10).** The user-facing form of the loop the
 * planner runs by hand today: `motir next` dispatches the next ready work
 * item to the user's own coding agent; `motir auto` keeps dispatching, one
 * by one, until the ready set drains. This productizes `prodect run` /
 * `prodect next` for every Prodect user — the BYOK execution path the plan
 * has promised since story 7.0 shipped `/api/ready/next` naming "the BYOK
 * `prodect run` CLI" as its consumer.
 *
 * **Mirror status: justified deviation, same escape clause as 7.0.** Jira and
 * Linear ship no "run the next work item with your coding agent" CLI — this
 * is Prodect's AI-coding-native differentiator, not a mirrorable surface.
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
 * canonical agent prompt (PRODECT.md § Prompt structure: CONTEXT / WHAT TO
 * DO / ACCEPTANCE CRITERIA / GIT WORKFLOW, per-type variants). 7.6 owns
 * generating that server-side — one source of truth for every dispatch
 * surface (web "copy prompt", CLI, the future native AI-coding layer). The
 * CLI's dispatch commands therefore carry a story-level dep on 7.6 (the
 * 2.6.x / 6.7 precedent for unexpanded siblings; retarget to the concrete
 * subtask when 7.6 expands). Listing/auth/linking commands don't need 7.6.
 *
 * **Multi-repo projects are the NORM — and the link binds a FOLDER to a
 * PROJECT, not repos (Yue, 2026-06-10, two refinements).** A Prodect project
 * usually spans several repos (Prodect itself is `prodect-core` +
 * `prodect-ai`), AND a brand-new project starts from an EMPTY folder — the
 * plan's first work items are what CREATE the repos (Prodect's own 1.0.1
 * scaffolded prodect-core into an empty directory). So `motir link` does
 * exactly one thing: bind the **workspace root** directory to a server +
 * workspace + project. **Repo paths are CONVENTION, not configuration:**
 * the item's `targetRepo` resolves to `<root>/<repoName>` by default — the
 * plan knows its repo names before the repos exist (planning names them,
 * e.g. "prodect-core", at plan time), so convention covers the new-project
 * flow from item one with NOTHING to link. `.motir.json` carries
 * `{ serverUrl, workspace, project }` plus an OPTIONAL `repos` override map
 * for the exceptions (a checkout living elsewhere / under a different
 * name): `motir link add <repo> <path>` / `remove` manage overrides only.
 * Running `link` in an empty folder is therefore first-class — bind and
 * go. Commands resolve `.motir.json` by walking UPWARD from cwd, so
 * invoking from inside `prodect-core/` still sees the whole root — ONE
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
 * file, surfacing the exit code. Worktree/branch mechanics stay INSIDE the
 * generated prompt's GIT WORKFLOW section (the agent creates its own
 * worktree, as every dispatched prompt already instructs) — the CLI never
 * mutates the user's git state itself.
 *
 * **Status semantics honor the merge mode (no invented states).** Dispatch
 * flips the item to `in_progress` (the same `transition_status` tool any
 * agent uses). In `manual` merge mode the item then waits for the human:
 * the agent's PR gets reviewed + merged, and `motir done <key>` is the
 * close-out (the CLI analog of `prodect mark done`). `motir auto` therefore
 * drains the CURRENTLY-ready set in manual mode — items unlocked only by a
 * not-yet-merged dependency stay out of reach until the human merges and
 * marks done (readiness is dependency-only; the loop never fakes a `done`).
 * In `auto` merge mode (the workspace opt-in), completion cascades and the
 * loop keeps going as the ready set refills.
 *
 * **Packaging: `packages/cli` workspace package, binary `motir`.** The repo
 * already carries `pnpm-workspace.yaml`; the CLI lands as the first real
 * workspace package (own package.json, `bin: { motir }`, bundled with a
 * standard TS CLI build — evaluate commander vs yargs + tsup vs esbuild at
 * build time and record the pick; node >= 22). It ships from the repo first
 * (installable via the checkout / `pnpm --filter cli`); **publishing the
 * `motir` npm package is Epic-8 work** (8.7 — gated on the Motir
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
    "The command-line tool that runs Prodect's execution loop from the terminal: `motir next` " +
    "dispatches the next ready work item to the user's own coding agent, `motir auto` keeps " +
    'dispatching one item at a time until the ready set drains. Full command set: `motir auth ' +
    'login|status|logout` (PAT), `motir link` (bind a WORKSPACE ROOT directory — possibly ' +
    'EMPTY for a new project — to a project; repo checkouts resolve by CONVENTION ' +
    '`<root>/<repoName>`, with an optional override map for exceptions), ' +
    '`motir ready` (the ready set), `motir status` (project pulse), `motir next` / `motir run ' +
    '<key>` (dispatch one), `motir done <key>` (close-out after the PR merges), `motir auto` ' +
    '(the loop), `motir open <key>` (jump to the browser). Built as an MCP client of the 7.8 ' +
    'server (one agent surface, one auth path — PAT bearer), consuming 7.6 server-side prompt ' +
    'generation; the agent itself is the user\'s own (`--agent "claude -p"` or copy-paste). ' +
    'Lives in `packages/cli` (first workspace package), binary named `motir` per the 8.7 name ' +
    'decision; npm publishing belongs to Epic 8 (name securing gates it).',
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
    '- With two checkouts present (the prodect-core + prodect-ai shape), run `motir ready` ' +
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
    '- `motir auto --agent "./fake-agent.sh"` on a small fixture project: items dispatch ' +
    'one-by-one in ready order until `next_ready` returns empty; the summary table lists ' +
    'every item with its outcome; a mid-loop agent failure halts by default and ' +
    '`--keep-going` skips past it (the failed item stays in_progress, excluded from ' +
    're-dispatch).\n' +
    '- Revoke the PAT → every command fails with the auth error and a re-login hint.',
  items: [
    {
      id: '7.9.1',
      title:
        'CLI scaffold — `packages/cli` workspace package, MCP client core, `motir auth login|status|logout` + `motir link`',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The package and the two substrates every command shares: the authenticated MCP ' +
        'client and the config/linking layer.\n\n' +
        '**Package.** `packages/cli` — the first real workspace package (the repo already has ' +
        '`pnpm-workspace.yaml`; extend its globs if needed and keep the Next app build ' +
        'unaffected). `package.json` name `motir`, `bin: { "motir": ... }`, node >= 22, ' +
        'standard TS CLI toolchain (evaluate commander vs yargs + tsup vs esbuild at build ' +
        'time, record the pick in the package README). NOT published to npm in this story — ' +
        'in-repo install (`pnpm --filter motir...`) is the 7.9 distribution; publishing is ' +
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
        '- `pnpm --filter motir build` produces a runnable `motir` binary; the root app ' +
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
      status: 'blocked',
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
        'status (the CLI analog of `prodect mark <id> done`, run after the human merges the ' +
        "PR in manual mode). Illegal transitions surface the service's allowed-targets " +
        'error verbatim.\n\n' +
        '**Repo routing (convention + bootstrap, story header).** Every dispatch resolves ' +
        "the item's `targetRepo` from the dispatch payload (7.6 sources it; 7.7's repo " +
        'entity upgrades it later): an override from `.motir.json` if present, else the ' +
        'convention `<root>/<repoName>`. Path EXISTS → the agent runs with cwd = that ' +
        'checkout (dispatching a prodect-ai item while standing in prodect-core works). ' +
        'Path MISSING → the bootstrap rule: the agent runs at the WORKSPACE ROOT (the ' +
        "scaffold prompt's GIT WORKFLOW creates the checkout — the empty-folder new-project " +
        'flow); after exit 0 the CLI verifies the path now exists and reports a suspect ' +
        'dispatch (with a `motir link add` hint for off-convention layouts) if it does ' +
        'not. The CLI never guesses an item into a DIFFERENT existing checkout. `--print` ' +
        'mode prints the target repo + resolved path alongside the prompt so the ' +
        'copy-paste user opens (or creates) the right checkout.\n\n' +
        '**The CLI never touches git.** Worktree/branch mechanics live inside the generated ' +
        "prompt's GIT WORKFLOW section — the agent (or human) executes them.\n\n" +
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
        '- `PRODECT.md` § Prompt structure (what the generated prompt must contain — ' +
        'asserted server-side in 7.6, consumed here)\n\n' +
        '**Branch.** `subtask/PROD-7.9.3-cli-dispatch`.',
      dependsOn: ['7.9.1', '7.8.5', '7.6'],
    },
    {
      id: '7.9.4',
      title:
        '`motir auto` — the sequential dispatch loop (drain the ready set, one item at a time)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The loop: repeat the 7.9.3 single-dispatch pipeline — STRICTLY one item at a time ' +
        "(Yue's spec; no concurrent dispatches in this story) — until `next_ready` returns " +
        'empty, then print a summary table (item, outcome, duration).\n\n' +
        '**Semantics (no invented states, honor the merge mode):**\n' +
        '- Requires `--agent`/config `agentCommand` (an auto loop has no human to ' +
        'copy-paste; `--print` makes no sense here and errors with guidance).\n' +
        '- **Failure policy:** halt on the first agent failure by default (the failed item ' +
        'stays in_progress and is named); `--keep-going` excludes the failed item ' +
        '(`excludeIds`) and continues with the rest.\n' +
        '- **Manual merge mode reality:** the loop drains the CURRENTLY-ready set. Items ' +
        'whose deps complete only when a human merges + `motir done`s stay out of reach — ' +
        'the loop reports them as "blocked awaiting review" in the summary instead of ' +
        "spinning. Each dispatched item runs in its OWN target repo's checkout per the " +
        '7.9.3 routing — including the bootstrap case (missing path → dispatch at the root; ' +
        'a bootstrap whose verification fails counts as a dispatch FAILURE for the halt / ' +
        '--keep-going policy) — so one loop serves the whole multi-repo project from an ' +
        'empty folder onward, no per-repo loops. ' +
        'In auto merge mode (workspace opt-in) the ready set refills as items reach done ' +
        'and the loop cascades.\n' +
        '- `--max <n>` caps dispatches per invocation; `--kinds` filters as in `next`.\n' +
        '- **Interrupt-safe:** Ctrl-C between items exits cleanly with the summary-so-far; ' +
        'mid-agent, the agent process is terminated, the item is left in_progress and ' +
        'named, exit code non-zero.\n' +
        '- Each iteration re-queries `next_ready` (never a pre-fetched batch) so ' +
        'newly-unlocked items join in ready order.\n\n' +
        '## Acceptance criteria\n\n' +
        '- On a fixture dependency graph, `motir auto` with an always-green fake agent ' +
        'dispatches every ready item exactly once, in ready-sort order, one at a time, and ' +
        'exits 0 with a full summary.\n' +
        '- A mid-loop failure halts by default with a non-zero exit; `--keep-going` ' +
        'finishes the remainder and lists the failure; the failed item is in_progress and ' +
        'never re-dispatched in that invocation.\n' +
        '- In manual merge mode the loop terminates when only review-gated items remain ' +
        '(reported, not spun on); `--max` is honored.\n' +
        '- Ctrl-C leaves the server state consistent (no item stranded in a half-applied ' +
        'transition) and prints the partial summary.\n\n' +
        '## Context refs\n\n' +
        '- 7.9.3 (the single-dispatch pipeline this loops)\n' +
        '- story-7.0.ts (`next_ready` sort/exclude contract)\n' +
        '- PRODECT.md `prodect run` (the readiness-is-dependency-only rule the loop ' +
        'mirrors)\n\n' +
        '**Branch.** `subtask/PROD-7.9.4-cli-auto-loop`.',
      dependsOn: ['7.9.3'],
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
        'item routes INTO it by convention; (b) a two-checkout root (the prodect-core + ' +
        'prodect-ai shape) — dispatch routes each item into its target checkout (the fake ' +
        'agent records its cwd), and a failed bootstrap (agent exits 0 but creates ' +
        'nothing) is reported as suspect, asserted in both `next` and `auto`.\n' +
        '- **Read parity:** `motir ready --json` ≡ `list_ready` ≡ the /ready set for the ' +
        'same user.\n' +
        '- **Dispatch:** `next --print` flips in_progress + prints the server prompt ' +
        'verbatim; `--agent` exit-code handling (0 / non-zero); `run --force` on a blocked ' +
        'item; `done` legal + illegal flips.\n' +
        '- **Auto loop:** the 7.9.4 fixture graph end-to-end (drain order, halt vs ' +
        '--keep-going, --max, the manual-merge-mode termination case).\n' +
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
        '(`pnpm --filter motir...`; npm install lands with the Epic-8 publish), `auth ' +
        'login` + PAT creation pointer (the 7.8.8 doc), `link`, every command with examples, ' +
        'agent wiring recipes (`--agent "claude -p"` headless and a copy-paste flow), the ' +
        "`auto` loop's failure policy + the manual-vs-auto merge-mode semantics (set " +
        'expectations: in manual mode the loop drains what is ready NOW), and ' +
        'troubleshooting (revoked token, no link, blocked item).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A reader goes zero → first `motir auto` run from this doc alone; every shipped ' +
        'command + flag is documented with an example.\n' +
        '- The merge-mode semantics section matches the 7.9.4 card (no over-promising what ' +
        '`auto` does in manual mode).\n' +
        '- Cross-links: `docs/mcp.md` (tokens/tools) and the /ready page doc surface.\n\n' +
        '## Context refs\n\n' +
        '- `docs/jobs.md`, `docs/mcp.md` (7.8.8) — register + cross-link targets\n' +
        '- 7.9.1–7.9.4 cards (the shipped behavior being documented)\n\n' +
        '**Branch.** `subtask/PROD-7.9.6-cli-docs`.',
      dependsOn: ['7.9.4'],
    },
  ],
};
