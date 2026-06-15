import type { PlanStory } from '../types';

/**
 * Story 7.8 — Motir MCP server (the agent tool surface over the PM core).
 *
 * **Why this story exists (the orphaned-deferral fix).** An MCP server was
 * promised in prose for months — notes.html #26's follow-ups ("eventually a
 * Motir MCP lets agents log bugs directly") and the PRODECT_FINDINGS
 * preamble's bug-logging protocol — but no story owned it. Per the no-V1-tier
 * rule, an unowned capability is a planning bug, not a scope cut. Yue's
 * concrete trigger (2026-06-10): the planner's status-flip seed PRs + his
 * hand-drag of every card retire the moment an agent can transition statuses
 * in the live tenant directly.
 *
 * **Mirror product (rung 1, VERIFIED — not asserted).** Atlassian ships the
 * official Remote MCP Server for Jira/Confluence (atlassian/atlassian-mcp-server;
 * announced on the Atlassian blog): OAuth 2.1, read+write tools, and the
 * security contract "access only to data the user already has permission to
 * view" — every action respects existing project/space roles. Linear ships an
 * official MCP server too. A real Jira clone in 2026 has an MCP server; this
 * story is the standard shape, not a deviation.
 *
 * **One justified deviation from the mirror: PAT bearer auth, not OAuth 2.1.**
 * Atlassian's server is a CLOUD-hosted gateway with Atlassian-account OAuth.
 * motir-core is a self-hostable open core with no authorization-server
 * infrastructure; requiring OAuth 2.1 would force every self-hoster to operate
 * an AS before their first agent connects. The durable, widely-deployed
 * alternative is per-user API tokens sent as `Authorization: Bearer` (GitHub's
 * MCP server ships exactly this with PATs; Jira Data Center itself uses PATs).
 * The PAT substrate (7.8.1) is durable — hashed at rest, expiring, revocable,
 * permission-scoped to its owning user — and an OAuth layer can be ADDED in
 * front of it later without re-shaping a single tool (the MCP spec's auth is
 * transport-level). Use case recorded; complexity earned.
 *
 * **Placement: motir-core, not motir-ai.** Every tool is a thin adapter
 * over already-shipped PM-core services — the MCP server is part of the open
 * agent dispatch surface (like story 7.0's /ready endpoints, which the
 * dispatch tools wrap 1:1), not AI intelligence. A team that never buys the
 * AI layer still points their own agents at their own Motir.
 *
 * **Permission model: enforce in the SERVICE layer, surface in the tool.**
 * No tool re-implements authorization. Each tool resolves the PAT to its
 * owning user and calls the same service methods the routes call — the 6.4
 * role checks (done) and the 404-not-403 cross-tenant contract apply
 * unchanged. The MCP layer's only auth job is token → user resolution
 * (7.8.1's verify) and a clean JSON-RPC error mapping for typed service
 * errors.
 *
 * **The workflow flip this story must land (status authority moves seed →
 * live DB).** Today the plan seed is the source of truth for STATUS too:
 * status-flip seed PRs must merge so a later `[reseed]` regenerates the same
 * statuses (MOTIR.md § Plan seed Workflow step-4 invariant). Once
 * `transition_status` (7.8.5) exists, statuses change in the live tenant
 * without a seed edit — so a reseed that re-applies seed statuses would
 * CLOBBER them. 7.8.7 flips the loader invariant: a reseed PRESERVES the live
 * workflow status of plan items that already exist in the tenant; seed
 * statuses become initial-only (applied to NEW items). Plan-STRUCTURE
 * authority (adding/expanding stories) stays with the seed. 7.8.8 rewrites
 * the MOTIR.md runbook (status flips via MCP; status-flip seed PRs retire).
 *
 * **Scope (narrowed ruthlessly, axes per motir plan step 6).** Three read
 * tools (`get_work_item`, `list_ready`, `next_ready`), three work-item write
 * tools (`create_work_item` incl. bug logging, `transition_status`,
 * `add_comment`), `search_work_items` riding the 6.1.1 FilterAST envelope
 * when that codec lands, and the 7.8.10 sprint set (added on Yue's
 * direction, 2026-06-10: list/create/update/delete sprint, move items
 * sprint↔backlog, start, complete) — every sprint tool a thin adapter over
 * the shipped-and-done Epic-4 services. Plus the 7.8.11 INTEGRATION-STATE
 * substrate the 7.9 CLI session loop rides (Yue, 2026-06-10): the
 * `in_review` status, `work_item.session_branch`, the integrated-dep
 * readiness rule (a dep with a recorded session branch unblocks its
 * dependents before main merges), and the `mark_integrated` /
 * `complete_session` tools. NOT in scope (each has an owning
 * story already): prompt generation (7.6), GitHub sync (7.7), planner tools /
 * shared-context retrieval (7.5), notifications (5.7). Completeness axis:
 * tool reads are paginated from day one (they wrap services that already
 * paginate — 7.0's cursor contract, 5.1's paged comments); no
 * load-everything tool.
 */
export const story_7_8: PlanStory = {
  id: '7.8',
  title: 'Motir MCP server (agent tool surface over the PM core)',
  status: 'planned',
  gitBranch: 'story/PROD-7.8-mcp-server',
  descriptionMd:
    'An MCP server exposing the PM core to AI agents: query work items + the ready set, create ' +
    'work items, log bugs, comment, transition statuses, run the full sprint cadence ' +
    '(create/scope/start/complete + settings, 7.8.10), and carry integration state for the ' +
    'CLI session loop (7.8.11: in_review + session_branch + integrated-dep readiness + ' +
    '`mark_integrated`/`complete_session`) — per-user API-token auth, every ' +
    'tool honoring the same workspace/project access checks as the UI (enforced in the service ' +
    'layer, 6.4). The mirror products ship exactly this (the official Atlassian Remote MCP ' +
    'Server — OAuth 2.1, read+write, "access only to data the user already has permission to ' +
    'view"; Linear likewise). Open-core: lives in motir-core beside the rest of the agent ' +
    "dispatch surface — the dispatch tools wrap story 7.0's shipped `/api/ready` contract 1:1. " +
    'Fulfils the long-promised "agents log bugs via the Motir MCP" protocol (notes.html #26 ' +
    'follow-ups, PRODECT_FINDINGS preamble).\n\n' +
    '**Dogfood payoff + the workflow decision this story lands:** once agents transition ' +
    "statuses directly in the live tenant, the planner's status-flip seed PRs (and Yue's " +
    'hand-drag of each card) retire. Status authority moves from the plan seed to the live DB: ' +
    '7.8.7 flips the loader invariant so a reseed PRESERVES live statuses (today seed status ' +
    'wins), and 7.8.8 ships the MOTIR.md runbook rewrite. Plan-structure authority stays ' +
    'with the seed.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma generate`, `pnpm prisma migrate dev`, ' +
    '`pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test` — vitest covers the PAT lifecycle, the MCP auth gate, every tool, and the ' +
    'permission scoping (see 7.8.9).\n' +
    '- Sign in as `zhuyue@motir.co` → Settings → Account → **API tokens** → create a token ' +
    '(label "claude-code", 90-day expiry). The plaintext shows ONCE with a copy affordance; the ' +
    'list shows the prefix, created, expires, last-used.\n' +
    '- Wire a real agent: `claude mcp add --transport http motir http://localhost:3000/api/mcp ' +
    '--header "Authorization: Bearer <token>"` — then, in a Claude Code session: ask it to list ' +
    'ready items (`list_ready` returns the same set the /ready page shows), open one ' +
    '(`get_work_item PROD-<n>`), move it (`transition_status` → "In progress"), and comment on ' +
    'it (`add_comment`). Refresh the board: the card moved WITHOUT a seed PR and the comment ' +
    "is attributed to the token's owning user.\n" +
    '- Ask the agent to log a bug (`create_work_item kind:bug` under a story) — the bug appears ' +
    'in the issue tree with the reporter set to the token owner (the findings-protocol payoff).\n' +
    '- Run a sprint entirely from chat (7.8.10): create a sprint with a goal, `move_to_sprint` ' +
    'a few backlog items (bulk), `start_sprint`, then `complete_sprint` choosing where the ' +
    'unfinished items go — the backlog/board UIs show the same states the whole way, and the ' +
    'completed sprint reports the same scope the UI flow would.\n' +
    '- Negative: revoke the token in settings → the next tool call fails with an auth error and ' +
    'the agent surfaces it cleanly; a token for a non-member user cannot see the workspace at ' +
    'all (404-not-403 contract).\n' +
    '- Reseed flip (7.8.7): move a card via MCP, then merge a `[reseed]` planning PR — the ' +
    'reseed regenerates the plan tree but the card KEEPS the live status the agent set (the ' +
    'new invariant).',
  items: [
    {
      id: '7.8.1',
      title:
        'API-token (PAT) substrate — `api_token` schema + repository + `apiTokensService` (create-shows-once / list / revoke / verify)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The auth substrate every other subtask rides. A per-user personal access token: ' +
        'generated once, shown once, stored ONLY as a hash, expiring, revocable — the Jira / ' +
        'GitHub API-token shape.\n\n' +
        '**Schema (`prisma/schema.prisma` + migration).** `api_token`: `id` (cuid), `userId` ' +
        '(FK → `User`, modelled as a Prisma `@relation` on BOTH sides per the CLAUDE.md ' +
        'FK-relation rule — `ApiToken.user` ↔ `User.apiTokens`, `onDelete: Cascade`), `label` ' +
        '(user-facing name, e.g. "claude-code"), `tokenHash` (sha-256 hex of the full secret, ' +
        '`@unique` — the lookup key), `tokenPrefix` (first 12 chars of the secret, display-only ' +
        'so the list can show `motir_pat_AbC1…`), `expiresAt` (nullable timestamptz), ' +
        '`lastUsedAt` (nullable), `revokedAt` (nullable — soft revoke, the row stays for the ' +
        'audit trail), `createdAt`. Index on `userId`. RLS policies matching the existing ' +
        'per-table pattern (the `prodect_app` non-bypass role).\n\n' +
        '**Token format.** `motir_pat_` + 32 bytes of `crypto.randomBytes` base62. The fixed ' +
        'prefix makes tokens greppable in leaked-secret scanners (the GitHub `ghp_` rationale).\n\n' +
        '**Service (`lib/services/apiTokensService.ts`) + repository ' +
        '(`lib/repositories/apiTokenRepository.ts`), 4-layer split.** `create(userId, {label, ' +
        'expiresAt?})` → generates the secret, persists the hash row in a tx, returns `{token ' +
        '(plaintext, returned ONCE and never persisted), dto}`. `listForUser(userId)` → DTOs ' +
        '(id, label, tokenPrefix, createdAt, expiresAt, lastUsedAt, revokedAt) — NEVER the ' +
        "hash. `revoke(userId, tokenId)` → sets `revokedAt` in a tx; revoking someone else's " +
        'token is a typed not-found error (404-not-403). `verify(plaintext)` → sha-256 the ' +
        'input, look up by `tokenHash` (an equality probe on a unique hash index — constant ' +
        'work regardless of token validity), reject revoked/expired with typed errors, touch ' +
        '`lastUsedAt` (throttled: skip the write if touched < 5 min ago, so a chatty agent ' +
        'session does not write-amplify), and return the owning user. No HTTP surface in this ' +
        'subtask — 7.8.3 (settings UI routes) and 7.8.4 (MCP bearer gate) consume the service.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration applies cleanly; `prisma migrate dev` afterwards reports no drift (the ' +
        'FK-relation rule — modelled on both sides).\n' +
        "- The plaintext secret appears in exactly ONE place ever: `create`'s return value. " +
        'Not in the row, not in any DTO, not in any log.\n' +
        '- `verify` accepts a live token; rejects unknown / revoked / expired tokens with ' +
        'distinct typed errors; touches `lastUsedAt` at most once per 5-minute window.\n' +
        '- Write methods require `tx` (compile-time, per CLAUDE.md); vitest covers the full ' +
        'lifecycle against the real Postgres (create → verify → revoke → verify-fails, expiry ' +
        'boundary, cross-user revoke is not-found).\n' +
        '- `pnpm test:coverage` per-file gate holds for the new service + repository.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` (User model, RLS migration pattern in `prisma/migrations/`)\n' +
        '- `CLAUDE.md` (4-layer split; FK `@relation` rule; required-`tx` writes)\n' +
        '- `lib/auth/passwords.ts` (the existing hashing util conventions; PATs use sha-256, ' +
        'NOT argon2 — the secret has full entropy, so a fast hash is correct and keeps `verify` ' +
        'cheap per call)\n' +
        '- `lib/services/workspacesService.ts` (typed-error + DTO conventions)\n\n' +
        '**Branch.** `subtask/PROD-7.8.1-api-token-substrate`.',
      dependsOn: [],
    },
    {
      id: '7.8.2',
      title: 'Design — API tokens settings surface (list / create / shown-once / revoke / empty)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** design (planning-time design gate, Principle #13). There is NO ' +
        '`design/settings/` area yet — the settings pages shipped so far (account, workspace, ' +
        'jobs dashboard) predate or carry their own references; this surface gets its own ' +
        'asset BEFORE 7.8.3 writes any UI.\n\n' +
        'Produce `motir-core/design/settings/api-tokens.mock.html` — a `*.mock.html` mockup ' +
        'built from the real design system (`components/ui/*` primitives, `--el-*` colour ' +
        'tokens, `[data-display-style]` shape tokens; the 7.0.1 convention) — plus ' +
        '`design/settings/design-notes.md`.\n\n' +
        '**Mirror surface (rung 1):** Atlassian API tokens (id.atlassian.com → Security → API ' +
        'tokens): create with label + expiry, a list showing label / created / expires / ' +
        "last-used, revoke per row. Keep Motir's coloured-personality register (the " +
        'less-enterprise-than-Jira standing policy) without inventing new primitives.\n\n' +
        '**Panels (EVERY panel — the multi-panel rule, mistake #31):**\n\n' +
        '- **Panel 1 — populated list** inside the existing Settings → Account layout: table ' +
        'of tokens (label, `tokenPrefix` in a code chip, created, expires, last-used, a ' +
        'revoked row shown muted with a "Revoked" `Pill`), "Create token" primary button.\n' +
        '- **Panel 2 — create modal**: label input, expiry select (30/90/365 days/never — ' +
        'default 90), create CTA.\n' +
        '- **Panel 3 — the shown-ONCE state**: the modal after create — full token in a ' +
        'monospace copy field, copy button + toast, and the warning copy that it will not be ' +
        'shown again.\n' +
        '- **Panel 4 — revoke confirm**: destructive-action dialog naming the token label; ' +
        'consequence copy ("agents using it lose access immediately").\n' +
        '- **Panel 5 — empty state**: `EmptyState` primitive; copy explains what the tokens ' +
        'are for and points at `docs/mcp.md` (the 7.8.8 doc).\n\n' +
        '`design-notes.md` names the exact primitives per panel, the exact copy strings, ' +
        'spacing/placement, and the per-`--el-*` colour role (the 1.3.3 / 1.5.1 convention). ' +
        'Self-review per the render checklist (render + screenshot every panel, AA on ' +
        '`--el-*` pairs, no nested buttons, prettier --write).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/settings/api-tokens.mock.html` renders all five panels from real ' +
        'primitives + tokens (no Tier-0 `--color-*`, no raw radius/spacing).\n' +
        '- `design/settings/design-notes.md` follows the convention and includes the ' +
        '"primitives composed (no hand-rolling)" checklist.\n' +
        '- The PR only touches `design/settings/**`.\n\n' +
        '## Context refs\n\n' +
        '- `design/ready/` (7.0.1 — the closest prior mock.html + design-notes convention)\n' +
        '- `app/(authed)/settings/account/page.tsx` (the host layout the panels sit in)\n' +
        '- `components/ui/*`, `app/globals.css` (primitives + token tiers)\n\n' +
        '**Branch.** `design/PROD-7.8.2-api-tokens-settings` (the `design/*` prefix skips CI ' +
        'E2E + the Vercel preview deploy).',
      dependsOn: [],
    },
    {
      id: '7.8.3',
      title:
        'API tokens settings UI — Settings → Account → API tokens (list / create-shows-once / revoke)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The human half of the token lifecycle, matching the 7.8.2 design asset exactly.\n\n' +
        'Routes (HTTP-only, 4-layer): `GET/POST /api/me/api-tokens`, `DELETE ' +
        '/api/me/api-tokens/[tokenId]` — session-authed (the PAT is for agents; the UI that ' +
        'MINTS it is cookie-session only, so a leaked PAT cannot mint more PATs), each calling ' +
        'one `apiTokensService` method. Page: an "API tokens" section/tab in Settings → ' +
        'Account rendering the 7.8.2 panels — list, create modal with expiry select, the ' +
        'shown-once copy state, revoke confirm, empty state.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Create → modal shows the plaintext exactly once with a working copy affordance; ' +
        'after close it is irretrievable (only prefix shown); revoke flips the row to the ' +
        'muted Revoked state without removing it.\n' +
        '- The routes enforce session auth + ownership (cross-user token id → 404); no ' +
        'PAT-authed access to these routes.\n' +
        '- UI matches `design/settings/api-tokens.mock.html` (primitives, copy, tokens — ' +
        'colour through `--el-*`, shape through element-semantic tokens).\n' +
        '- Vitest covers the three routes; an E2E covers create → copy → revoke → the ' +
        'revoked-state render.\n\n' +
        '## Context refs\n\n' +
        '- `design/settings/api-tokens.mock.html` + `design-notes.md` (7.8.2 — REQUIRED ' +
        'design reference)\n' +
        '- `lib/services/apiTokensService.ts` (7.8.1)\n' +
        '- `app/(authed)/settings/account/page.tsx` + `_components/` (host page patterns)\n\n' +
        '**Branch.** `subtask/PROD-7.8.3-api-tokens-settings-ui`.',
      dependsOn: ['7.8.1', '7.8.2'],
    },
    {
      id: '7.8.4',
      title:
        'MCP endpoint — `/api/mcp` (streamable HTTP, official TS SDK), bearer-PAT auth gate, read + dispatch tools (`get_work_item`, `list_ready`, `next_ready`)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The MCP server itself: one streamable-HTTP endpoint at `app/api/mcp/[transport]/` ' +
        "using the official `@modelcontextprotocol/sdk` server via Vercel's `mcp-handler` " +
        'Next.js adapter (the maintained App-Router integration; evaluate at build time and ' +
        "record the pick — if `mcp-handler` is unsuitable, wire the SDK's " +
        '`StreamableHTTPServerTransport` directly; either way the tool registry below is the ' +
        'stable contract).\n\n' +
        '**Auth gate.** Every request requires `Authorization: Bearer motir_pat_…`; resolve ' +
        'via `apiTokensService.verify` to the owning user, reject failures with the proper ' +
        'JSON-RPC auth error BEFORE any tool dispatch. The resolved user becomes the actor for ' +
        'every service call — identical permission surface to the cookie session (6.4 roles, ' +
        '404-not-403 cross-tenant). No tool-level auth logic.\n\n' +
        '**Tool registry pattern.** One module per tool under `lib/mcp/tools/`, each ' +
        'declaring name / description / zod input schema / handler that calls EXACTLY ONE ' +
        'service method and maps typed service errors to MCP tool errors (the route-layer ' +
        'discipline, ported). A central `lib/mcp/registry.ts` assembles the server — the seam ' +
        '7.8.5 / 7.8.6 extend without touching transport or auth.\n\n' +
        '**Read + dispatch tools (this subtask).**\n' +
        '- `get_work_item` — by key (`PROD-<n>`): full detail DTO (description, status, ' +
        'assignee, deps, the issue-detail read service shape).\n' +
        '- `list_ready` — wraps `workItemsService.listReady` (the 7.0 contract verbatim: ' +
        'cursor-paginated `ReadyItemDto`, `kinds`/`assigneeId`/`priority` filters).\n' +
        '- `next_ready` — wraps the `/api/ready/next` projection (`excludeIds`, `kinds`, ' +
        'returns the dispatch payload incl. `descriptionMd` + `contextRefs`).\n\n' +
        'Tool results return BOTH a compact human-readable text block and ' +
        '`structuredContent` (the DTO) — the MCP dual-content convention agents and humans ' +
        'both read.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tools/list` over the endpoint returns the three tools with stable names + ' +
        'schemas; an MCP client SDK round-trips `initialize → tools/list → tools/call`.\n' +
        '- Absent / unknown / revoked / expired tokens are rejected with a JSON-RPC auth ' +
        'error and NO tool executes; a valid token resolves to its user and `list_ready` ' +
        'returns exactly the /ready page set for that user.\n' +
        '- Cross-tenant probes through any tool honor the 404-not-403 contract (asserted in ' +
        'vitest with a non-member token).\n' +
        '- Pagination cursors round-trip through `list_ready` (no load-everything path).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` (`listReady` + the `/next` projection, 7.0)\n' +
        '- `app/api/ready/route.ts`, `app/api/ready/next/route.ts` (the contract being ' +
        'wrapped 1:1)\n' +
        '- `lib/services/apiTokensService.ts` (7.8.1 `verify`)\n' +
        '- story-7.8 header (PAT-over-OAuth deviation rationale — restate in `lib/mcp/` ' +
        'module docs)\n\n' +
        '**Branch.** `subtask/PROD-7.8.4-mcp-endpoint-read-tools`.',
      dependsOn: ['7.8.1'],
    },
    {
      id: '7.8.5',
      title:
        'Write tools — `create_work_item` (incl. bug logging), `transition_status`, `add_comment`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The three write tools, each a thin adapter in the 7.8.4 registry over an ' +
        'already-shipped service — no new business logic, no bypassed validation.\n\n' +
        '- `create_work_item` — project key, kind (story/task/bug/subtask), title, optional ' +
        'parent key + `descriptionMd` + priority. Calls the shipped create service: the ' +
        'kind-parent matrix (finding #41), key allocation, revision row, and 6.4 permission ' +
        "checks all apply unchanged. Reporter = the token's owning user. **`kind: bug` under " +
        'a story/epic IS the findings bug-logging protocol** — the tool description says so, ' +
        'so an agent told to "log this bug in Motir" finds the right tool.\n' +
        '- `transition_status` — work-item key + target status (key or name). Calls ' +
        '`workItemsService.updateStatus`: the workflow legal-transition validation ' +
        '(`workflowsService` / `canTransition`) decides; an illegal transition returns the ' +
        'typed error VERBATIM as a tool error listing the allowed targets (the agent ' +
        'self-corrects from it). THE tool that retires the status-flip seed PRs.\n' +
        '- `add_comment` — work-item key + Markdown body. Calls `commentsService` (5.1.2, ' +
        'done): server-side mention parsing, `comment_mention` rows, and job events fire ' +
        'exactly as from the UI — a mention from an agent comment emails the mentioned user ' +
        '(5.1.6) with zero MCP-specific wiring.\n\n' +
        '## Acceptance criteria\n\n' +
        "- All three tools execute as the token's user (reporter / actor / author " +
        'attribution) and appear in `tools/list` with zod-validated inputs.\n' +
        '- An illegal transition surfaces the allowed-transitions error; a legal one writes ' +
        'the status + revision row identically to the board drag (asserted by comparing ' +
        'revision shapes in vitest).\n' +
        '- `create_work_item` honors the kind-parent matrix (vitest: an illegal parent/kind ' +
        'pair errors typed); a bug created under a story lands in the tree with reporter ' +
        'set.\n' +
        '- `add_comment` triggers mention parsing + the `work-item/comment.created` job ' +
        'event (asserted via the job_run/event fixtures the 5.1 tests use).\n' +
        '- Non-member token: all three tools 404-not-403.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` (`updateStatus`, the create path)\n' +
        '- `lib/services/workflowsService.ts` (`canTransition`, typed transition errors)\n' +
        '- `lib/services/commentsService.ts` (5.1.2)\n' +
        '- `lib/mcp/registry.ts` (7.8.4 seam)\n\n' +
        '**Branch.** `subtask/PROD-7.8.5-mcp-write-tools`.',
      dependsOn: ['7.8.4', '5.1.2'],
    },
    {
      id: '7.8.6',
      title: 'Search tool — `search_work_items` riding the 6.1.1 versioned FilterAST envelope',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'The query tool, deliberately SECOND to the dispatch tools: agents that only run the ' +
        'planner loop never need it, but a real agent surface needs arbitrary search (the ' +
        "Atlassian MCP ships JQL search as a first-class tool — Motir's structured " +
        'equivalent is the 6.1 FilterAST).\n\n' +
        '`search_work_items` accepts the SAME versioned FilterAST envelope the 6.1.1 codec ' +
        'defines (one codec, N carriers — URL `?filter=v1:…`, 6.2 saved filters, and now the ' +
        'MCP tool; never a parallel query grammar), plus cursor + page-size. Compiles through ' +
        'the 6.1.1 safe compiler (parameterized-only WHERE fragments) and returns the list ' +
        'DTO + total + next cursor. The zod input schema embeds the AST schema so ' +
        '`tools/list` teaches an agent the exact filter grammar without external docs.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A v1 FilterAST that works in the /issues URL returns the identical result set ' +
        'through the tool (same compiler, asserted in vitest).\n' +
        "- Invalid / unknown-version envelopes return the codec's typed error as a tool " +
        'error; injection probes die in the parameterized compiler (reuse the 6.1.6 ' +
        'fixtures).\n' +
        '- Results are cursor-paginated; permission scoping per 6.4 (non-member: 404).\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-6.1.ts` (6.1.1 codec card — the envelope + compiler ' +
        'contract)\n' +
        '- `lib/mcp/registry.ts` (7.8.4)\n\n' +
        '**Branch.** `subtask/PROD-7.8.6-mcp-search-tool`.',
      dependsOn: ['7.8.4', '6.1.1'],
    },
    {
      id: '7.8.7',
      title:
        'Reseed preserves live statuses — flip the seed-loader invariant (seed status becomes initial-only)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'The workflow flip the story header pins. Today `pnpm db:seed` clear-and-reseeds the ' +
        'tenant and APPLIES seed statuses — correct while the seed is the status source of ' +
        'truth, destructive the moment 7.8.5 lets agents flip statuses in the live tenant.\n\n' +
        'Change `scripts/plan-seed/seed.ts`: before clearing the workspace, snapshot the ' +
        'current `workflow_status` of every existing plan work item keyed by its dotted plan ' +
        'id (the stable title prefix); after re-creating the tree, re-apply the snapshot to ' +
        'items that existed before (matched by plan id), leaving NEW items on their seed ' +
        'status (`PLAN_STATUS_MAP` becomes initial-only). Statuses whose key no longer exists ' +
        'in the target workflow fall back to the seed status with a loader warning. ' +
        'Re-running stays idempotent. Document the new invariant in the seed.ts header AND ' +
        "in `.github/workflows/seed.yml`'s comment block (whose current text states the OLD " +
        'invariant — "a later [reseed] regenerates the SAME statuses"; that sentence must be ' +
        'rewritten, not left to lie).\n\n' +
        '## Acceptance criteria\n\n' +
        "- Vitest (real PG): seed → move an item's status directly via the service (the MCP " +
        'path) → reseed → the item keeps the moved status; a NEW seed item gets its seed ' +
        'status; a removed-from-workflow status falls back with a warning.\n' +
        '- A full double-reseed remains idempotent (the existing guarantee).\n' +
        '- seed.ts + seed.yml comments state the new invariant; no doc still claims seed ' +
        'status wins.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/seed.ts`, `scripts/plan-seed/types.ts` (`PLAN_STATUS_MAP`)\n' +
        '- `.github/workflows/seed.yml` (the invariant prose to rewrite)\n' +
        '- `lib/workflows/defaultWorkflow.ts` (status keys the snapshot maps over)\n\n' +
        '**Branch.** `subtask/PROD-7.8.7-reseed-preserves-status`.',
      dependsOn: ['7.8.5'],
    },
    {
      id: '7.8.8',
      title:
        'Docs + runbook flip — `docs/mcp.md` (tool catalog, client wiring) + MOTIR.md status-workflow rewrite',
      status: 'blocked',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'Two documents, two repos, one PR each.\n\n' +
        '**`docs/mcp.md` (motir-core).** The user-facing doc the 7.8.2 empty state links ' +
        'to: what the MCP server is, creating a token (Settings → Account → API tokens), ' +
        'client wiring with copy-paste examples (Claude Code `claude mcp add --transport ' +
        'http … --header "Authorization: Bearer …"` and the equivalent `.mcp.json`; one ' +
        'generic streamable-HTTP example), the full tool catalog with input/output shapes, ' +
        "the permission model (tools see exactly what the token's user sees), and security " +
        'notes (shown-once, expiry, revoke immediately on leak). Follow the `docs/jobs.md` ' +
        'register.\n\n' +
        '**MOTIR.md (motir-meta).** Rewrite the status-flip workflow: `motir run` / ' +
        '`motir mark <id> done` flip statuses via the MCP `transition_status` tool against ' +
        'the live tenant; status-flip seed PRs + the hand-drag retire; the step-4 reseed ' +
        'table loses its status-flip row; the 7.8.7 PRESERVE invariant replaces the ' +
        '"reseed regenerates the same statuses" prose everywhere it appears. Plan-structure ' +
        'PRs (`[reseed]`) are unchanged.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `docs/mcp.md` exists; a reader can go token → wired agent → first `list_ready` ' +
        'call from the doc alone; every shipped tool is cataloged.\n' +
        '- MOTIR.md no longer instructs status-flip seed PRs anywhere (grep-verified); the ' +
        'new MCP flip path is the documented mechanic; the reseed-invariant prose matches ' +
        '7.8.7.\n\n' +
        '## Context refs\n\n' +
        '- `docs/jobs.md` (register + structure exemplar)\n' +
        '- `motir-meta/MOTIR.md` (§ Plan seed Workflow step 4; `motir run` step 5; ' +
        '`motir mark <id> done`)\n' +
        '- 7.8.4/7.8.5/7.8.6/7.8.10 tool registry (the catalog source)\n\n' +
        '**Branch.** `subtask/PROD-7.8.8-mcp-docs` (motir-core); the MOTIR.md edit ships ' +
        "as a plain motir-meta commit per that repo's convention.",
      dependsOn: ['7.8.5', '7.8.7', '7.8.10'],
    },
    {
      id: '7.8.10',
      title:
        'Sprint tools — `list_sprints` / `create_sprint` / `update_sprint` / `delete_sprint` / `move_to_sprint` / `move_to_backlog` / `start_sprint` / `complete_sprint`',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        "The Scrum half of the tool surface (added on Yue's direction, 2026-06-10): an agent " +
        'that plans and dispatches work also has to RUN the cadence — create the sprint, scope ' +
        'it, start it, and close it out. Jira exposes every one of these as a first-class ' +
        'Agile REST operation (create/update/delete sprint, move issues to sprint/backlog, ' +
        "start, complete); Motir's equivalents are ALL shipped and `done` (4.1 sprint " +
        'entity, 4.2 backlog scoping, 4.4 lifecycle), so — like 7.8.5 — every tool here is a ' +
        'thin adapter in the 7.8.4 registry over an existing service method, no new business ' +
        'logic.\n\n' +
        '- `list_sprints` — by project key, with state (future / active / completed) and ' +
        'dates/goal: `sprintsService.listByProject`. The read an agent needs before it can ' +
        'target any other sprint tool.\n' +
        '- `create_sprint` — project key, name, optional goal + start/end dates: ' +
        '`sprintsService.createSprint`.\n' +
        '- `update_sprint` — the "sprint settings" tool: rename, re-goal, re-date a sprint: ' +
        "`sprintsService.updateSprint` (the service's own state rules decide what is " +
        'editable per sprint state — surfaced verbatim as typed tool errors).\n' +
        "- `delete_sprint` — `sprintsService.deleteSprint`; the service's guards (what " +
        'happens to scoped items, which states are deletable) apply unchanged. Destructive, ' +
        'so the tool description says exactly what the service will do before an agent ' +
        'reaches for it.\n' +
        '- `move_to_sprint` — work-item keys (bulk) + target sprint: the `backlogService` ' +
        'bulk move (one transaction, the cross-project guard ' +
        '`CrossProjectSprintAssignmentError` surfaces as a typed tool error). This is the ' +
        '"add work items to sprint" operation.\n' +
        '- `move_to_backlog` — the inverse (bulk, `sprintId = null`), same service.\n' +
        '- `start_sprint` — `sprintsService.startSprint`. Not in the original ask but ' +
        'completeness requires it: an agent that can create and complete a sprint but not ' +
        'START one has a hole in the middle of the lifecycle.\n' +
        '- `complete_sprint` — `sprintsService.completeSprint`, INCLUDING the 4.4 ' +
        'incomplete-items disposition argument (move remaining items to backlog or to a ' +
        "named next sprint — the same choice the UI's complete-sprint modal offers; the " +
        'tool schema makes it required so an agent states the disposition explicitly).\n\n' +
        "All tools execute as the token's owning user (6.4 permission checks in the " +
        'services, 404-not-403 cross-tenant), return the dual text + `structuredContent` ' +
        'shape, and register through `lib/mcp/registry.ts` — which automatically enrolls ' +
        "them in 7.8.9's registry-loop permission suite.\n\n" +
        '## Acceptance criteria\n\n' +
        '- All eight tools appear in `tools/list` with zod-validated inputs; each calls ' +
        'exactly one existing service method (no inlined logic, no bypassed guards).\n' +
        '- Full lifecycle through MCP alone (vitest, real PG): create → scope via ' +
        '`move_to_sprint` (bulk) → start → complete with disposition → the remaining items ' +
        'land where the disposition said; states/dates/goal match what the UI flow ' +
        'produces.\n' +
        '- `update_sprint` on a completed sprint and `move_to_sprint` across projects return ' +
        "the services' typed errors as tool errors (asserted verbatim).\n" +
        '- `complete_sprint` requires the disposition argument (schema-level).\n' +
        '- Non-member token: every sprint tool honors 404-not-403 (the registry-loop suite ' +
        'covers this by construction once registered).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/sprintsService.ts` (create/update/delete/list/start/complete — the ' +
        '4.1 + 4.4 seams, all done)\n' +
        '- `lib/services/backlogService.ts` (single + bulk sprint assignment, ' +
        'cross-project guard — the 4.2 seam)\n' +
        '- `app/(authed)/backlog/_components/SprintMenuList.tsx` (the UI flow the tools ' +
        'mirror)\n' +
        '- `lib/mcp/registry.ts` (7.8.4 seam)\n\n' +
        '**Branch.** `subtask/PROD-7.8.10-mcp-sprint-tools`.',
      dependsOn: ['7.8.4'],
    },
    {
      id: '7.8.11',
      title:
        'Integration-state substrate — `in_review` status, `work_item.session_branch`, integrated-dep readiness, `mark_integrated` / `complete_session` tools',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        "The server-side substrate for 7.9's session-branch loop (Yue, 2026-06-10): work " +
        'merged to a session branch is NOT done — it is integrated-awaiting-review — but ' +
        'it MUST still unblock dependents, and the branch it lives on must travel with the ' +
        'work item so prompt generation can point the next agent at it.\n\n' +
        '**`in_review` workflow status.** Add `in_review` to ' +
        "`lib/workflows/defaultWorkflow.ts` (category `in_progress` — Jira's own In Review " +
        'sits in the In Progress category) with transitions `in_progress ↔ in_review`, ' +
        '`in_review → done` (and `in_review → blocked`), plus a migration adding the ' +
        'status + transitions to EXISTING default workflows (mirror the blocked-status ' +
        'precedent). Custom workflows are untouched — see the predicate design below for ' +
        'why nothing keys on the status.\n\n' +
        '**`work_item.session_branch`** (nullable text + index): the integration branch ' +
        "the item's work currently sits on. Set when a run integrates the item; CLEARED " +
        'when the item reaches done. Surfaced in the work-item DTO + the issue detail ' +
        '(read-only line under status — no design change needed beyond the existing field ' +
        'rows; if the rail needs a new element, the design gate fires at expansion of ' +
        'that surface, not here).\n\n' +
        '**Readiness: the integrated-dep rule — keyed on the FIELD, not the status.** ' +
        '`listReady` / `next_ready` (7.0) currently require every `is_blocked_by` link in ' +
        'the done category. New rule: a dep is satisfied when it is done OR its ' +
        '`session_branch` is set (integrated-awaiting-review). Deliberately NOT keyed on ' +
        'the `in_review` status key: custom workflows can name review states anything; ' +
        'the recorded branch is the ground truth that the dependent can actually build on ' +
        'the work. The dispatch payload gains TWO fields: `sessionBranch` (inherited — ' +
        "the branch the item's in-review deps live on, so 7.6's GIT WORKFLOW variant " +
        'tells the agent to branch from / integrate into IT) and the rule that an item ' +
        'whose in-review deps span TWO different session branches is NOT ready ' +
        '(conflicting lineages — surfaced in the readiness explanation, resolved by a ' +
        'human merging one session PR first).\n\n' +
        '**Tools (the 7.8.4 registry).** `mark_integrated(key, sessionBranch)` — one ' +
        'transaction: transition to `in_review` (legal-transition validation applies) + ' +
        'set `session_branch`; the tool the 7.9 loop calls on agent success. ' +
        '`complete_session(sessionBranch)` — bulk close-out after the human merges the ' +
        'session PR: every work item recorded on that branch transitions to done and the ' +
        'field clears (one transaction; partial-failure surfaces per item). Both ' +
        'permission-scoped via the services like every other tool; both join the 7.8.9 ' +
        'registry-loop suite automatically.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration adds `in_review` + transitions to the default workflow (new AND ' +
        'existing projects); `prisma migrate dev` afterwards reports no drift.\n' +
        '- An item with `session_branch` set unblocks its dependents in `listReady` / ' +
        '`next_ready` (vitest: A in_review-with-branch → B ready); a done dep still ' +
        'unblocks; an in-review dep WITHOUT the field set does NOT (the field is the ' +
        'signal); conflicting-branch deps keep the item out of the ready set with the ' +
        'explanation.\n' +
        '- The dispatch payload carries the inherited `sessionBranch`; items with no ' +
        'in-review deps carry null.\n' +
        '- `mark_integrated` is transactional (status + field together; illegal ' +
        'transition → typed error, field untouched); `complete_session` flips every ' +
        'recorded item to done and clears the field (vitest: a 3-item session).\n' +
        '- `pnpm test:coverage` per-file gate holds for the touched services.\n\n' +
        '## Context refs\n\n' +
        '- `lib/workflows/defaultWorkflow.ts` (the blocked-status precedent for adding a ' +
        'status)\n' +
        '- `lib/services/workItemsService.ts` (`listReady` — the 7.0 predicate this ' +
        'extends; `updateStatus` — the transition validation `mark_integrated` reuses)\n' +
        '- `lib/mcp/registry.ts` (7.8.4), `prisma/schema.prisma`\n' +
        "- story-7.9.ts header (the consuming loop's semantics)\n\n" +
        '**Branch.** `subtask/PROD-7.8.11-integration-state`.',
      dependsOn: ['7.8.5'],
    },
    {
      id: '7.8.9',
      title:
        'Story tests — MCP client round-trip suite (auth matrix, permission scoping, tool parity) + settings E2E',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The story-closing suite, real Postgres, no mocks (the repo testing contract): drive ' +
        'the ACTUAL `/api/mcp` endpoint with the official `@modelcontextprotocol/sdk` ' +
        'CLIENT — `initialize → tools/list → tools/call` — not the handlers in isolation ' +
        '(the per-subtask vitest already covers those).\n\n' +
        '- **Auth matrix:** valid / absent / malformed / unknown / revoked / expired token × ' +
        'a representative tool — only valid executes; each failure mode returns the distinct ' +
        'auth error.\n' +
        '- **Permission parity:** the same call under an owner token vs a non-member token — ' +
        'the non-member sees the 404-not-403 contract on every tool (loop the registry, so a ' +
        'future tool added without scoping FAILS this suite by construction).\n' +
        '- **Tool/UI parity:** `list_ready` ≡ `GET /api/ready` result set; ' +
        '`transition_status` produces a revision row identical in shape to the board drag; ' +
        '`search_work_items` ≡ the /issues URL filter for the same AST; the 7.8.10 sprint ' +
        'lifecycle (create → scope → start → complete) lands the same end state as the ' +
        'backlog/board UI flow.\n' +
        '- **Settings E2E (Playwright):** create token (label + expiry) → shown-once copy → ' +
        'list shows prefix/expiry → revoke → revoked render; plus the credentials-style ' +
        'assertion that the plaintext never re-appears.\n' +
        '- **Coverage:** the per-file ≥90% gate extends to `apiTokensService`, the MCP ' +
        'registry, and each tool module.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The suite runs green in CI (standard lanes — the MCP suite is vitest + the one ' +
        'settings E2E spec, no new CI job).\n' +
        '- The registry-loop scoping test exists and covers EVERY registered tool ' +
        'dynamically.\n' +
        '- `pnpm test:coverage` passes with the three new files in the per-file gate list.\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts` (truncate-between-tests harness)\n' +
        '- `vitest.config.ts` (per-file coverage gate list)\n' +
        "- 7.0's test suite (the ready-contract fixtures to reuse)\n\n" +
        '**Branch.** `subtask/PROD-7.8.9-mcp-story-tests`.',
      dependsOn: ['7.8.3', '7.8.5', '7.8.6', '7.8.7', '7.8.10', '7.8.11'],
    },
  ],
};
