import { DEFAULT_TOKEN_SCOPES, TOKEN_SCOPES, TOOL_SCOPES, type TokenScope } from '@/lib/mcp/scopes';
import type { GuideBlock } from '@/lib/apiDocs/guide';

// The MCP server documentation, AS DATA (Story MOTIR-2309 · Subtask MOTIR-2325 ·
// design `design/mcp-server/` · ADR `public-api-conventions.md` Amendment 13).
//
// ── The dependency-graph rule this file exists to keep ──────────────────────
// It imports `lib/mcp/scopes.ts` and NOTHING ELSE from `lib/mcp/`, directly or
// transitively. `scopes.ts` is safe for a public page: its only reference to the
// registry is `import type { McpToolName }`, erased at build. `registry.ts` is
// not — it imports all of `lib/mcp/tools/*.ts`, which import the services, which
// import `@prisma/client` and `lib/db`. None of that belongs in the dependency
// graph of a page anybody on the internet can request (Amendment 13 Q2).
//
// That is also why the tool-name type below is `keyof typeof TOOL_SCOPES` rather
// than an imported `McpToolName`: the two are the same type — `TOOL_SCOPES` is
// declared `Record<McpToolName, TokenScope>` — but deriving it costs no import at
// all, so the rule holds by construction and not by discipline. The totality
// chain is unbroken: a tool added to `MCP_TOOL_NAMES` without a scope fails
// typecheck in `scopes.ts`; adding the scope widens `keyof typeof TOOL_SCOPES`;
// and that makes {@link TOOL_SUMMARIES} below incomplete, which fails typecheck
// here. A tool cannot reach the server undocumented.
//
// ── What is DERIVED and what is AUTHORED (Amendment 13 Q2) ──────────────────
// Derived: every tool NAME, its gating SCOPE, the catalogue's GROUPING (a tool's
// group is its own scope), the scope legend and the default grant. Authored: the
// reader-facing one-line summaries, because a tool's `title` and `description`
// live inside its `server.registerTool(...)` call and are not data anywhere.
//
// Each authored summary carries a FINGERPRINT of the shipped `title` +
// `description` it was written against. The story's vitest gate (MOTIR-2330)
// recomputes it from a live `tools/list` and fails when they diverge, naming the
// tool. It does not prove a summary is good — no test can. It proves the summary
// was written against the text the server currently ships, which is exactly the
// property Amendment 9 Q2's second limb asks for, on the one surface Amendment 7
// explicitly licenses to churn.
//
// ── English, per ADR Amendment 4 Q4 ─────────────────────────────────────────
// Long-form documentation prose is localized in principle and lives here rather
// than in `messages/*.json`, for the reason `guide.ts` records: a catalog entry
// per paragraph makes a document unreadable to edit and puts config samples
// inside a localization file. The page CHROME is localized in the catalogs.

/**
 * Every tool the MCP server exposes — structurally identical to `McpToolName`,
 * derived rather than imported so this module needs no `registry.ts` reference.
 */
export type McpCatalogueToolName = keyof typeof TOOL_SCOPES;

// ── The four transport facts, held ONCE ─────────────────────────────────────
// Amendment 13 Q3a: these are OURS and a test can pin them. Every client block
// below is one of them transcribed into a vendor's file format, so a stale block
// is wrong about that vendor's syntax and never about Motir.

/** The example origin, used when the deployment names none. Mirrors `reference.ts`. */
export const MCP_EXAMPLE_ORIGIN = 'https://app.motir.co';

/** The served path — `app/api/mcp/route.ts`, a static route, not `[transport]`. */
export const MCP_ENDPOINT_PATH = '/api/mcp';

/** The header every request carries; the scheme is separate so blocks compose it. */
export const MCP_AUTH_HEADER = 'Authorization';
export const MCP_AUTH_SCHEME = 'Bearer';

/**
 * The bearer PLACEHOLDER, not a plausible-looking fake — `reference.ts`'s rule:
 * a realistic token in published documentation gets pasted verbatim and then
 * debugged as an auth problem; an obvious placeholder cannot.
 */
export const MCP_TOKEN_PLACEHOLDER = 'motir_pat_<your-token>';

/** The four facts, resolved. Passed into every client block so none hard-codes them. */
export interface McpTransportFacts {
  origin: string;
  path: string;
  url: string;
  authHeader: string;
  authScheme: string;
  tokenPlaceholder: string;
}

/** The shipped facts; overridable so a test can prove a block INTERPOLATES them. */
export function mcpTransportFacts(origin: string = MCP_EXAMPLE_ORIGIN): McpTransportFacts {
  return {
    origin,
    path: MCP_ENDPOINT_PATH,
    url: `${origin}${MCP_ENDPOINT_PATH}`,
    authHeader: MCP_AUTH_HEADER,
    authScheme: MCP_AUTH_SCHEME,
    tokenPlaceholder: MCP_TOKEN_PLACEHOLDER,
  };
}

/** One row of the "every client needs these four" table. */
export interface McpTransportFactRow {
  label: string;
  value: string;
}

export function mcpTransportFactRows(
  facts: McpTransportFacts = mcpTransportFacts(),
): McpTransportFactRow[] {
  return [
    { label: 'URL', value: `\`${facts.url}\`` },
    { label: 'Transport', value: 'Streamable HTTP — **not** SSE, and not a stdio command' },
    {
      label: 'Header',
      value: `\`${facts.authHeader}: ${facts.authScheme} <token>\`, on every request`,
    },
    { label: 'Token', value: `\`${facts.tokenPlaceholder}\` — the one you minted in step 1` },
  ];
}

// ── The client matrix (Amendment 13 Q3a) ────────────────────────────────────

/** One client's wiring block. Everything here except `config` is the VENDOR's. */
export interface McpClient {
  id: string;
  /** How the client is known to its users. */
  label: string;
  /** Where the snippet goes — becomes the `CodeBlock` caption. */
  file: string;
  /** The snippet, built by interpolating {@link McpTransportFacts}. */
  config: string;
  /**
   * One line on what this vendor does about the secret, or what to watch for.
   * REQUIRED: every block has something worth saying, and an optional field here
   * bought nothing but a dead branch in the page that renders it.
   */
  note: string;
  /** That vendor's own MCP documentation — the authority when this block is stale. */
  docsUrl: string;
  /** When the FORMAT was last read from `docsUrl`. Amendment 13 Q3a's containment. */
  checkedOn: string;
}

/**
 * The date the four vendor formats below were read from their own documentation.
 * One constant, because they were checked in one pass and a per-client date that
 * nobody updates is worse than an honest shared one.
 */
export const MCP_CLIENT_FORMATS_CHECKED_ON = '2026-08-06';

/**
 * Every client block. **No entry hard-codes the endpoint, the header or the token
 * shape** — each interpolates `facts`, which is what makes MOTIR-2330's negative
 * case (build with a sentinel origin, assert every config carries it) meaningful.
 *
 * Where a vendor supports reading the secret from somewhere else, the block uses
 * it. A guide whose first instruction is "paste a live credential into a file
 * your repository tracks" has taught the wrong habit in the first five minutes.
 */
export function mcpClients(facts: McpTransportFacts = mcpTransportFacts()): McpClient[] {
  const bearer = `${facts.authScheme} ${facts.tokenPlaceholder}`;
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      file: '.mcp.json',
      config: [
        '{',
        '  "mcpServers": {',
        '    "motir": {',
        '      "type": "http",',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${bearer}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: `Or one command: \`claude mcp add --transport http motir ${facts.url} --header "${facts.authHeader}: ${bearer}"\``,
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: '~/.cursor/mcp.json — or .cursor/mcp.json for one project',
      config: [
        '{',
        '  "mcpServers": {',
        '    "motir": {',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${facts.authScheme} \${env:MOTIR_TOKEN}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: 'Cursor interpolates `${env:…}`, so the token stays in your environment and out of the file.',
      docsUrl: 'https://cursor.com/docs/context/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'vscode',
      label: 'VS Code',
      file: '.vscode/mcp.json',
      config: [
        '{',
        '  "inputs": [',
        '    {',
        '      "type": "promptString",',
        '      "id": "motir-token",',
        '      "description": "Motir personal access token",',
        '      "password": true',
        '    }',
        '  ],',
        '  "servers": {',
        '    "motir": {',
        '      "type": "http",',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${facts.authScheme} \${input:motir-token}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: 'VS Code prompts for the token the first time the server starts and stores it securely — nothing secret is written to the file.',
      docsUrl: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      file: '~/.codex/config.toml',
      config: [
        '[mcp_servers.motir]',
        `url = "${facts.url}"`,
        'bearer_token_env_var = "MOTIR_TOKEN"',
      ].join('\n'),
      note: '`bearer_token_env_var` takes the variable’s **name**, not the token.',
      docsUrl: 'https://developers.openai.com/codex/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'other',
      label: 'Any other streamable-HTTP client',
      file: 'whatever your client calls its config',
      config: [
        'Transport:  streamable HTTP',
        `URL:        ${facts.url}`,
        `Header:     ${facts.authHeader}: ${bearer}`,
      ].join('\n'),
      note: 'Windsurf, Zed, Cline, Goose, or something you wrote yourself — the same four facts under different key names.',
      docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
  ];
}

// ── The reader's fork: MCP or /api/v1? (Amendment 7, published as reasoning) ──

/** One row of the fork table. Cells carry the same marks the prose does. */
export interface McpForkRow {
  axis: string;
  mcp: string;
  rest: string;
}

export function mcpForkRows(facts: McpTransportFacts = mcpTransportFacts()): McpForkRow[] {
  return [
    { axis: 'Endpoint', mcp: `\`POST ${facts.path}\``, rest: '`/api/v1/…`' },
    {
      axis: 'Built for',
      mcp: 'An **agent you control** — it reads tool descriptions at run time.',
      rest: 'A **client you ship** — code written once against a fixed shape.',
    },
    {
      axis: 'Stability',
      mcp: '**Expected to change.** Rewording a description or renaming an argument is how an agent’s behaviour gets tuned.',
      rest: '**Additive only.** A breaking change mints `/api/v2`; v1 keeps its promise.',
    },
    {
      axis: 'Shape',
      mcp: 'The same. MCP payloads are derived from the v1 response schemas, so the two describe provably identical objects.',
      rest: 'The same, and it is the source the MCP derives from.',
    },
    {
      axis: 'Auth',
      mcp: 'One personal access token, one scope set.',
      rest: 'The same credential works on both.',
    },
  ];
}

/** The one-line steer under the fork table. */
export const MCP_FORK_STEER: GuideBlock = {
  kind: 'callout',
  tone: 'info',
  text: 'Wiring an agent? Stay here. Writing software other people install? The REST API is the other half — it is the one that promises not to change under you.',
};

// ── The scope legend, derived from TOKEN_SCOPES / DEFAULT_TOKEN_SCOPES ───────

/** What each scope gates, in the reader's terms. The ONLY authored part. */
const SCOPE_LABELS: Record<TokenScope, { label: string; gates: string }> = {
  read: {
    label: 'Read',
    gates: 'Every read — items, the ready set, search, sprints, plans, identity. Never mutates.',
  },
  'work_items:write': {
    label: 'Write work items',
    gates: 'Create, edit, transition, comment, link, re-parent — and submit a planning job.',
  },
  'work_items:archive': {
    label: 'Archive & restore',
    gates: 'Soft-remove and restore. Recoverable, so it is on by default.',
  },
  'work_items:delete': {
    label: 'Delete',
    gates: 'Irreversible subtree delete. The only scope OFF by default on a new token.',
  },
  'sprints:write': {
    label: 'Sprints',
    gates: 'The sprint lifecycle and its membership moves.',
  },
  integration: {
    label: 'Integration',
    gates: 'Mark work integrated, and close out a session branch.',
  },
};

export interface McpScopeLegendRow {
  scope: TokenScope;
  label: string;
  gates: string;
  /** From `DEFAULT_TOKEN_SCOPES` — never a second hand-written list. */
  grantedByDefault: boolean;
  /** Derived: how many tools this scope gates. Never a literal. */
  toolCount: number;
}

export function mcpScopeLegend(): McpScopeLegendRow[] {
  // Seeded TOTAL over TOKEN_SCOPES, so the lookup below cannot miss and needs no
  // fallback arm. A scope that currently gates no tool reports 0 rather than
  // vanishing — the legend's job is to tell a reader what every scope on their
  // token means, including one that happens to gate nothing today.
  const counts = Object.fromEntries(TOKEN_SCOPES.map((scope) => [scope, 0])) as Record<
    TokenScope,
    number
  >;
  for (const scope of Object.values(TOOL_SCOPES)) {
    counts[scope] += 1;
  }
  return TOKEN_SCOPES.map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope].label,
    gates: SCOPE_LABELS[scope].gates,
    grantedByDefault: DEFAULT_TOKEN_SCOPES.includes(scope),
    toolCount: counts[scope],
  }));
}

// ── The catalogue ───────────────────────────────────────────────────────────

/** One authored summary, plus the fingerprint of the shipped text it was written against. */
export interface McpToolSummary {
  summary: string;
  /** {@link fingerprintToolText} of the shipped `title` + `description`. */
  descriptionFingerprint: string;
}

/**
 * ⚠️ REGENERATE A FINGERPRINT FROM THE LIVE SERVER, NEVER BY RE-READING THE
 * SOURCE. The first pass here derived them by parsing the `registerTool(...)`
 * literals out of `lib/mcp/tools/*.ts`, and **nine of thirty-nine came out
 * wrong** — the descriptions are concatenated across many lines and several
 * contain typographic quotes, so a source-level parse silently truncates some of
 * them. The gate caught all nine, which is the system working; the lesson is
 * that the only trustworthy source for this value is the same one the gate
 * reads. Get it from a `tools/list` handshake (the pattern in
 * `tests/api-docs/mcp-truth.test.ts`) and copy the result.
 *
 * The stored fingerprints are computed by `fingerprintToolText` in
 * `lib/apiDocs/mcpFingerprint.ts` — which lives in its OWN module because it
 * needs `node:crypto`, and nothing a public page imports may. The story's vitest
 * gate (MOTIR-2330) imports it, recomputes each fingerprint from a live
 * `tools/list`, and fails when one diverges.
 */

/**
 * ⚠️ TOTAL over the tool set by TYPE. A tool added to the registry — which forces
 * a `TOOL_SCOPES` entry — widens `McpCatalogueToolName` and makes this map
 * incomplete, which is a compile error in this file. That is the guarantee; the
 * fingerprints are the separate guarantee that each line still describes the tool
 * the server ships.
 */
const TOOL_SUMMARIES: Record<McpCatalogueToolName, McpToolSummary> = {
  get_work_item: {
    summary:
      'One item in full — description, status, parent and children, dependency edges, and a readiness verdict.',
    descriptionFingerprint: '343942011390',
  },
  get_work_item_activity: {
    summary:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
    descriptionFingerprint: 'f67109d04887',
  },
  list_ready: {
    summary:
      'The ready-to-start set for a project — every item whose dependencies are all satisfied, paginated.',
    descriptionFingerprint: '570879d433ae',
  },
  next_ready: {
    summary:
      'The single highest-ranked ready item, as a full dispatch payload. The “what do I do next” call.',
    descriptionFingerprint: '8283986decf5',
  },
  dispatch_prompt: {
    summary:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
    descriptionFingerprint: 'b597b28346fd',
  },
  search_work_items: {
    summary:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
    descriptionFingerprint: '50c0482ec3fd',
  },
  whoami: {
    summary:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
    descriptionFingerprint: 'b8b8a104bfe6',
  },
  list_projects: {
    summary: 'Every project this token can reach, each with the projectKey every other tool takes.',
    descriptionFingerprint: 'f2ba367c391a',
  },
  get_project_state: {
    summary:
      "A project's planning preconditions — established, code connected, indexed, repo set — before you plan.",
    descriptionFingerprint: '77241589544a',
  },
  list_sprints: {
    summary:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
    descriptionFingerprint: '1b0f1e472431',
  },
  validate_sprint: {
    summary:
      'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
    descriptionFingerprint: '76934cb8bc30',
  },
  validate_work_item: {
    summary:
      'Is this epic, story, task or bug finishable? Names the out-of-subtree work still gating it.',
    descriptionFingerprint: '677e882f5e83',
  },
  get_plan_status: {
    summary:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
    descriptionFingerprint: '6a4d3e564af1',
  },
  get_plan: {
    summary:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much.',
    descriptionFingerprint: 'c23f12cfee90',
  },
  open_plan_session: {
    summary: "Open — or resume — a project's planning conversation, and read its thread.",
    descriptionFingerprint: 'aa4e7ce9b277',
  },
  create_work_item: {
    summary:
      'Create an epic, story, task, bug or subtask; points, estimate, type, executor and repo in one call.',
    descriptionFingerprint: '1decba47fca7',
  },
  update_work_item: {
    summary:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
    descriptionFingerprint: '564bf33c1ea8',
  },
  transition_status: {
    summary:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
    descriptionFingerprint: '07d05e08c12b',
  },
  claim_next_ready: {
    summary:
      'Atomically claim the next ready subtask in the active sprint and flip it to In Progress. Race-safe.',
    descriptionFingerprint: 'ef64f059efb9',
  },
  add_comment: {
    summary: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
    descriptionFingerprint: '81d096a6d087',
  },
  expand_item: {
    summary:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
    descriptionFingerprint: 'ee60a5541cc4',
  },
  append_plan_turn: {
    summary:
      "Add one turn to a project's planning conversation — what you want changed about the plan.",
    descriptionFingerprint: 'b1ad0d0eb3f9',
  },
  submit_plan_session: {
    summary: "Send the conversation's accumulated intent to the planner as one change set.",
    descriptionFingerprint: '2191f35e198e',
  },
  link_work_items: {
    summary:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
    descriptionFingerprint: 'e2d02dc88244',
  },
  unlink_work_items: {
    summary: 'Remove an edge, given the same relationship used to create it.',
    descriptionFingerprint: 'ddebb74fa44c',
  },
  move_to_parent: {
    summary: 'Re-parent an item, enforcing the kind-parent matrix and refusing a cycle.',
    descriptionFingerprint: 'fc965c828ab0',
  },
  change_kind: {
    summary: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
    descriptionFingerprint: '7d5af7a4655e',
  },
  archive_work_item: {
    summary: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
    descriptionFingerprint: 'c806b53fd762',
  },
  unarchive_work_item: {
    summary: 'Restore an archived item — the inverse of archive.',
    descriptionFingerprint: '8ada099dad87',
  },
  delete_work_item: {
    summary: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
    descriptionFingerprint: '416497cebae1',
  },
  create_sprint: {
    summary:
      'Create a planned sprint on a project, with an optional name, goal and planned window.',
    descriptionFingerprint: 'e18783eda5a4',
  },
  update_sprint: {
    summary: 'Rename a sprint, change its goal, or adjust its planned window.',
    descriptionFingerprint: '5efd5da7f72d',
  },
  delete_sprint: {
    summary: 'Delete a planned or complete sprint.',
    descriptionFingerprint: '1993eb2eb159',
  },
  start_sprint: {
    summary: "Start a planned sprint, making it the project's active one.",
    descriptionFingerprint: 'a6537ea4f114',
  },
  complete_sprint: {
    summary: 'Complete the active sprint.',
    descriptionFingerprint: 'a2f8a391c36a',
  },
  move_to_sprint: {
    summary: 'Add items to a sprint in one atomic move, appended in the order given.',
    descriptionFingerprint: '9fb0ffb5cf7c',
  },
  move_to_backlog: {
    summary: 'Move items out of their sprint and back to the backlog.',
    descriptionFingerprint: '52003d122cfd',
  },
  mark_integrated: {
    summary:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
    descriptionFingerprint: '645372de2186',
  },
  complete_session: {
    summary:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
    descriptionFingerprint: 'fbfb1bc9197a',
  },
};

/** One catalogue row. */
export interface McpToolRow {
  name: McpCatalogueToolName;
  scope: TokenScope;
  summary: string;
}

/** One catalogue group — a scope, and the tools it gates. */
export interface McpCatalogueGroup {
  scope: TokenScope;
  label: string;
  gates: string;
  grantedByDefault: boolean;
  tools: McpToolRow[];
}

/**
 * The catalogue, grouped by scope.
 *
 * The GROUPING is derived: a tool's group is its own `TOOL_SCOPES` entry, so no
 * per-tool grouping fact is authored and a new tool lands in a group the moment
 * it has a scope — which is the moment it exists. Only the six group labels and
 * their order (`TOKEN_SCOPES` order) are authored, in `SCOPE_LABELS` above.
 *
 * Groups with no tools are dropped, so a scope that gates nothing does not render
 * an empty heading.
 */
export function mcpCatalogue(): McpCatalogueGroup[] {
  const rows = (Object.keys(TOOL_SUMMARIES) as McpCatalogueToolName[])
    .map((name) => ({ name, scope: TOOL_SCOPES[name], summary: TOOL_SUMMARIES[name].summary }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return TOKEN_SCOPES.map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope].label,
    gates: SCOPE_LABELS[scope].gates,
    grantedByDefault: DEFAULT_TOKEN_SCOPES.includes(scope),
    tools: rows.filter((row) => row.scope === scope),
  })).filter((group) => group.tools.length > 0);
}

/** Every row, flat — for the truth test and for a count. */
export function mcpToolRows(): McpToolRow[] {
  return mcpCatalogue().flatMap((group) => group.tools);
}

/**
 * How many tools the catalogue carries. **Computed, never a literal** — the
 * number a reader sees is the length of what was derived, so it cannot disagree
 * with the list beneath it.
 */
export function mcpToolCount(): number {
  return mcpToolRows().length;
}

/** The stored fingerprint for one tool, for the gate to compare against. */
export function mcpToolFingerprint(name: McpCatalogueToolName): string {
  return TOOL_SUMMARIES[name].descriptionFingerprint;
}

// ── What the page hands off ─────────────────────────────────────────────────

/** The in-repo reference this page fronts; everything past the first run. */
export const MCP_REFERENCE_URL = 'https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md';
