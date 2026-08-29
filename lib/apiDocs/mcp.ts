import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import enMessages from '@/messages/en.json';
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
// That is also why the tool-name type below is `keyof typeof TOOL_PERMISSIONS` rather
// than an imported `McpToolName`: the two are the same type — `TOOL_PERMISSIONS` is
// declared `Record<McpToolName, TokenScope>` — but deriving it costs no import at
// all, so the rule holds by construction and not by discipline. The totality
// chain is unbroken: a tool added to `MCP_TOOL_NAMES` without a scope fails
// typecheck in `toolPermissions.ts`; adding it widens `keyof typeof TOOL_PERMISSIONS`;
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
export type McpCatalogueToolName = keyof typeof TOOL_PERMISSIONS;

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

// ── The permission legend, derived from the catalog ─────────────────────────
//
// ⚠️ NOTHING HERE IS AUTHORED ANY MORE (MOTIR-2581). This block used to carry a
// hand-written `SCOPE_LABELS` table — six labels and six sentences describing
// what each scope gated — maintained beside the ones on Roles & permissions. A
// second hand-written description of one capability is the drift this story
// removes: the two say the same thing on the day they are written and diverge
// on the day someone edits one.
//
// So the label and the sentence are read from the SHIPPED i18n copy, by the
// catalog's own `permissions.<slug>.label` / `.description` keys — the exact
// strings the Roles & permissions screen renders. `en.json` is imported rather
// than resolved through next-intl because this module builds a PUBLISHED page,
// which has no request locale; the published reference is English, as the rest
// of `lib/apiDocs` already is.

/** The shipped `permissions.*` copy, as the published page reads it. */
const PERMISSION_COPY = enMessages.permissions as unknown as Record<
  string,
  { label: string; description: string }
>;

function permissionLabel(key: PermissionKey): string {
  return PERMISSION_COPY[permissionSlug(key)]!.label;
}

function permissionDescription(key: PermissionKey): string {
  return PERMISSION_COPY[permissionSlug(key)]!.description;
}

export interface McpScopeLegendRow {
  permission: PermissionKey;
  label: string;
  gates: string;
  /** From `DEFAULT_TOKEN_GRANT` — never a second hand-written list. */
  grantedByDefault: boolean;
  /** Derived: how many tools this permission gates. Never a literal. */
  toolCount: number;
}

export function mcpScopeLegend(): McpScopeLegendRow[] {
  // Seeded TOTAL over GRANTABLE_PERMISSIONS, so the lookup below cannot miss and
  // needs no fallback arm. A permission that currently gates no MCP tool reports
  // 0 rather than vanishing — the legend's job is to tell a reader what every
  // permission on their token means, including one only `/api/v1` exercises.
  const counts = Object.fromEntries(GRANTABLE_PERMISSIONS.map((key) => [key, 0])) as Record<
    PermissionKey,
    number
  >;
  for (const permission of Object.values(TOOL_PERMISSIONS)) {
    counts[permission] += 1;
  }
  return GRANTABLE_PERMISSIONS.map((permission) => ({
    permission,
    label: permissionLabel(permission),
    gates: permissionDescription(permission),
    grantedByDefault: DEFAULT_TOKEN_GRANT.includes(permission),
    toolCount: counts[permission],
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
  attach_file: {
    summary:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the card instead of hunting for a pull request.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '138c5dd702b3',
  },
  publish_design_result: {
    summary:
      'Put the design RESULT on a design work item — the note sections you changed, the mock and the .png export, in one call. It is the deliverable a reviewer opens, and nothing else publishes it.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '8742db646e68',
  },
  link_pull_request: {
    summary:
      'Declare which work item a pull request delivers — call it right after opening one, once ' +
      'per work item it delivers. The association is a SET, so a second call ADDS rather than ' +
      'moving, and it works before any webhook delivery has arrived.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    // Re-pinned for MOTIR-3721: the description said a pull request "cannot point at two"
    // work items, which the delivery table falsified when MOTIR-3658 shipped the dual write.
    // Re-pinned again for MOTIR-3757, and the SUMMARY changed with it: the description said
    // the link a work item carries is SINGULAR and MOVES, which stopped being true when the
    // column it described was dropped.
    descriptionFingerprint: '97a9ab212c18',
  },
  unlink_pull_request: {
    summary:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a ' +
      'pull request. A delivery is a row, so re-linking the right card ADDS rather than ' +
      'corrects; this removes exactly the one pair you name and leaves every other delivery ' +
      'alone.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '0dd646f57b25',
  },
  get_work_item: {
    // Re-pinned for MOTIR-3096, summary UNCHANGED and deliberately so: the tool
    // gained an optional `planId` that answers the SAME question over the live
    // tree ⊕ a plan's proposals. A reader picking a tool off this line is
    // picking it for what it reads, not for which tree it reads.
    summary:
      'One item in full — description, status, parent and children, dependency edges, and a readiness verdict.',
    descriptionFingerprint: '901407c6b4d0',
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
    // Re-pinned for MOTIR-3096, summary UNCHANGED — same reasoning as
    // `get_work_item`'s. The projected mode is documented in `docs/mcp.md`'s
    // AI-planning section, where somebody would look for it.
    summary:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
    descriptionFingerprint: 'fa9850f5a29c',
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
  skeleton: {
    summary:
      "The whole project's tree shape in one read — every item's key, kind, title, status and parent, with no paging loop.",
    descriptionFingerprint: '26ceb84cf462',
  },
  search_work_items_semantic: {
    summary:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
    descriptionFingerprint: '71d731c71c15',
  },
  list_sprints: {
    summary:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
    descriptionFingerprint: '1b0f1e472431',
  },
  validate_sprint: {
    // Re-pinned for MOTIR-3095, summary UNCHANGED — same reasoning as
    // `validate_work_item` below: the optional `planId` changes which tree the
    // question is asked over, not what the question is.
    summary:
      'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
    descriptionFingerprint: '4089eae0592b',
  },
  validate_work_item: {
    // Re-pinned for MOTIR-3095, summary UNCHANGED and deliberately so: the tool
    // gained an optional `planId` that asks the SAME question over a plan being
    // authored, and a reader choosing a tool from this line is choosing it for
    // the question, not for which tree it is asked over. The projected mode is
    // documented where somebody would look for it — `validate_plan`'s own line
    // below, and the `AI planning` section of `docs/mcp.md`.
    //
    // Re-pinned again for MOTIR-3110, summary UNCHANGED for the same reason one
    // rung over: the tool's `advisories` channel gained a third `shape` severity
    // (`likely-over-gate-sizing`). The summary names the QUESTION the tool
    // answers — finishability — and advisories have never been part of it,
    // precisely because they are the half that does not gate. A reader choosing
    // this tool from a one-line catalogue is choosing the verdict; the advisory
    // channel and every severity in it is documented where somebody would look,
    // in `docs/mcp.md`'s `validate_work_item` section and its severity table.
    //
    // Re-pinned once more for MOTIR-3178's FOURTH shape severity
    // (`likely-self-blocking-design`). Same re-read, same answer — and the
    // repetition is now itself the finding worth recording: every severity this
    // family gains drifts this pin and leaves the summary correct, because the
    // summary is scoped to the verdict and the severities live on the channel
    // that never touches it. A future member should expect to bump the hash and
    // change nothing else; a member that DID make this line wrong would be one
    // that started gating, which the family's contract forbids.
    //
    // Re-pinned again for MOTIR-3271, and this one is NOT a new severity: the
    // `likely-over-gate-sizing` line was corrected in place — its minutes
    // threshold moved 60 → 70 and the text now says that arm is a PROXY, since
    // `estimateMinutes` sums agent time and CI time while the gate ceilings the
    // agent run alone. Summary UNCHANGED for the reason above, which the
    // paragraph anticipated: the drift is on the advisory channel, and the
    // summary describes the verdict.
    summary:
      'Is this epic, story, task or bug finishable? Names the out-of-subtree work still gating it.',
    descriptionFingerprint: '5e25f8f8a9fb',
  },
  validate_plan: {
    // ⚠️ SUMMARY REWRITTEN, not merely re-pinned (MOTIR-3575). The old line —
    // *"Is the plan you are authoring finishable?"* — became FALSE rather than
    // stale: the tool used to answer finishability alone, and a plan the approve
    // button would refuse came back VALID. It now answers TWO questions, and
    // VALID means both pass. A summary naming one of them is precisely the
    // reading that made a malformed plan safe to close, so this is the drift the
    // pin exists to catch rather than an explanatory edit it can ride out.
    summary:
      'Would approve TAKE this plan, and is it finishable? Both, before `final: true` — nobody else will ask.',
    descriptionFingerprint: 'e4886b97d214',
  },
  get_plan_status: {
    // Re-pinned for MOTIR-3064, summary UNCHANGED and deliberately so: the tool
    // description's edit was to the parenthetical explaining WHY the `job` block
    // exists (a failed job no longer leaves its plan `generating` forever — a
    // reconciler declines an empty one within the hour), and this line was never
    // about that. What the tool answers is the same thing it answered before.
    //
    // Re-pinned AGAIN for MOTIR-3578, summary UNCHANGED for the same reason and
    // it is worth saying why the sibling above went the other way. The edit here
    // widened the description's ENUMERATION of the statuses a plan can be in,
    // from four to five (`stale`). This line does not enumerate them — it says
    // the tool reports the job's state and its proposal count, which is still
    // exactly what it does. `validate_plan`'s summary changed because its old
    // text named the WRONG QUESTION, not because its description moved.
    summary:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
    descriptionFingerprint: 'ab983b5ea9ac',
  },
  get_plan: {
    summary:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much.',
    descriptionFingerprint: 'c23f12cfee90',
  },
  create_plan: {
    summary:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
    descriptionFingerprint: '7c51786d65d6',
  },
  add_plan_items: {
    // The SUMMARY is MOTIR-3193's and stays exactly as that story wrote it: the
    // empty-final-batch close is a CAPABILITY, which is the kind of thing a
    // reader picks a tool off this line for. MOTIR-3194 then re-pinned the
    // fingerprint WITHOUT touching it, because what that card added to the
    // description is the ONE-PROPOSAL-PER-TARGET rule — a refusal a caller meets
    // after it has already chosen this tool, and read from the description.
    summary:
      'Append proposals to a plan — or close it with an empty final batch; ids come back in order, so the next batch can hang children off them.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'ae3fc99f33f6',
  },
  update_plan_item: {
    summary:
      'Fill in a proposal you appended — the deepen turn, while the plan is still being written.',
    descriptionFingerprint: 'b5b5fb20ecb2',
  },
  update_plan_proposal: {
    // The line has to carry what SEPARATES it from the deepen above, because a
    // reader picking between two adjacent tools is choosing on exactly that.
    summary:
      'Correct a proposal — including its parent, its dependency edges and its repo pin (name and role) — even after the plan is in review.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '3edbd458460d',
  },
  withdraw_plan_proposal: {
    summary:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
    descriptionFingerprint: 'b0245a956fa6',
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
  claim_work_item: {
    summary:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
    descriptionFingerprint: '272d4e9c0a23',
  },
  add_comment: {
    summary: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
    descriptionFingerprint: '81d096a6d087',
  },
  add_lesson: {
    summary:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
    descriptionFingerprint: '0089c4f1139f',
  },
  search_lessons: {
    summary:
      "Search recorded lessons by meaning — the shared corpus and this project's own — before you plan or build.",
    descriptionFingerprint: '0266605e57b9',
  },
  reinforce_lesson: {
    summary:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
    descriptionFingerprint: '264d63e358fd',
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
  permission: PermissionKey;
  summary: string;
}

/** One catalogue group — a permission, and the tools it gates. */
export interface McpCatalogueGroup {
  permission: PermissionKey;
  label: string;
  gates: string;
  grantedByDefault: boolean;
  tools: McpToolRow[];
}

/**
 * The catalogue, grouped by PERMISSION.
 *
 * The GROUPING is derived: a tool's group is its own `TOOL_PERMISSIONS` entry, so
 * no per-tool grouping fact is authored and a new tool lands in a group the
 * moment it has a permission — which is the moment it exists. Since MOTIR-2581
 * the group LABELS are derived too, from the shipped `permissions.*` copy; the
 * only authored thing left is the ORDER, which is the catalog's own.
 *
 * Groups with no tools are dropped, so a permission that gates no MCP tool does
 * not render an empty heading.
 */
export function mcpCatalogue(): McpCatalogueGroup[] {
  const rows = (Object.keys(TOOL_SUMMARIES) as McpCatalogueToolName[])
    .map((name) => ({
      name,
      permission: TOOL_PERMISSIONS[name],
      summary: TOOL_SUMMARIES[name].summary,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return GRANTABLE_PERMISSIONS.map((permission) => ({
    permission,
    label: permissionLabel(permission),
    gates: permissionDescription(permission),
    grantedByDefault: DEFAULT_TOKEN_GRANT.includes(permission),
    tools: rows.filter((row) => row.permission === permission),
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
