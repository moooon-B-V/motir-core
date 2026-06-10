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
    'login|status|logout` (PAT), `motir link` (bind a repo directory to a workspace/project), ' +
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
    '- Create a PAT in Settings → Account → API tokens. In a scratch git repo: `motir auth ' +
    'login` (paste the token; `motir auth status` shows the resolved user), `motir link` ' +
    '(pick moooon/prodect).\n' +
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
        '**Linking.** `motir link` — interactive (or `--workspace/--project` flags) binding ' +
        'of the current directory to a workspace + project, written to `.motir.json` at the ' +
        'repo root (safe to commit: server URL + workspace/project slugs only, NEVER the ' +
        'token). Commands resolve project context from `.motir.json` upward, overridable ' +
        'with `--project`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm --filter motir build` produces a runnable `motir` binary; the root app ' +
        'build/test/lint pipelines are unaffected (CI lanes stay green with the workspace ' +
        'package present).\n' +
        '- `auth login` rejects an invalid/revoked PAT at login time (validation round-trip); ' +
        'a valid one persists with 0600 perms and `auth status` resolves the user.\n' +
        '- `.motir.json` contains no secret; commands error with a clear "run `motir link`" ' +
        'message when no link is found.\n' +
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
        'spinning. In auto merge mode (workspace opt-in) the ready set refills as items ' +
        'reach done and the loop cascades.\n' +
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
        'link error with guidance; `.motir.json` resolution from a subdirectory.\n' +
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
