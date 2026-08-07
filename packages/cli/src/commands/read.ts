import { CliError } from '../errors.js';
import { info, json, out } from '../output.js';
import { requireLink } from '../config/linkConfig.js';
import { collectReady, collectSprintItems, withProjectSession } from '../session.js';
import { openUrl } from '../browser.js';
import {
  assignChildWaves,
  inFlightFilter,
  issueUrl,
  renderActivityStream,
  renderReadyTable,
  renderSprintHeader,
  renderSprintItems,
  renderSprintsTable,
  renderStatusBlock,
  renderWorkItemDetail,
  resolveSprintRef,
  type StatusPulse,
} from '../render.js';
import type { MotirClient, SprintSummary, WorkItemDetail } from '../client.js';

// `motir ready` / `motir status` / `motir open <key>` — the read surface a user
// checks before and between dispatches (Story 7.9 · Subtask 7.9.2), joined by
// `motir sprints` / `motir sprint [ref]` (7.9.14). Every read rides the existing
// MCP tools (list_ready / search_work_items / list_sprints): NO new server
// surface, so the CLI can never disagree with the web app on what "ready", "in
// flight", or "in this sprint" means.

const WORK_ITEM_KINDS = new Set(['epic', 'story', 'task', 'bug', 'subtask']);

/** Parse a `--kinds epic,story` list into validated lower-case kinds. */
export function parseKinds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const kinds = raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  if (kinds.length === 0) return undefined;
  const bad = kinds.filter((k) => !WORK_ITEM_KINDS.has(k));
  if (bad.length > 0) {
    throw new CliError(`Unknown work item kind(s): ${bad.join(', ')}.`, {
      hint: `Valid kinds: ${[...WORK_ITEM_KINDS].join(', ')}.`,
    });
  }
  return kinds;
}

/** Resolve a `--assignee` value to the tool's `assigneeId` tri-state: `me` →
 * the token owner's id (a whoami round-trip), `unassigned`/`none` → the
 * unassigned bucket sentinel, any other value → that id verbatim, omitted →
 * undefined (any). */
async function resolveAssignee(
  client: MotirClient,
  raw: string | undefined,
): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  // NULL is the unassigned bucket — the tri-state `MotirClient.listReady`'s
  // signature already declares. The wire's own literal for it (`none`) belongs
  // to the adapter, not here: `'unassigned'` was the MCP tool's spelling
  // leaking into the command (MOTIR-2344).
  if (value === 'unassigned' || value === 'none') return null;
  if (value === 'me') {
    const who = await client.whoami();
    return who.user.id;
  }
  return raw;
}

export interface ReadyOptions {
  kinds?: string;
  assignee?: string;
  json?: boolean;
}

export async function readyCommand(opts: ReadyOptions): Promise<void> {
  const kinds = parseKinds(opts.kinds);
  await withProjectSession(async ({ client, projectKey }) => {
    const assigneeId = await resolveAssignee(client, opts.assignee);
    const items = await collectReady(client, projectKey, { kinds, assigneeId });
    if (opts.json) {
      json(items);
      return;
    }
    out(renderReadyTable(items));
  });
}

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const pulse = await withProjectSession(async ({ client, projectKey }) => {
    // Ready count: page the whole ready set (it has no count operation of its
    // own; the set is the small actionable subset). In-flight count: ONE call to
    // the collection's count, which is what this always meant — it used to send
    // a `limit: 1` search and throw the row away. Active sprint: list the
    // sprints and pick the single `active` one.
    const ready = await collectReady(client, projectKey);
    const inFlight = await client.countWorkItems({ projectKey, filter: inFlightFilter() });
    const { sprints } = await client.listSprints({ projectKey });
    const result: StatusPulse = {
      projectKey,
      readyCount: ready.length,
      inFlightCount: inFlight,
      activeSprint: sprints.find((s) => s.state === 'active') ?? null,
      totalSprints: sprints.length,
    };
    return result;
  });

  if (opts.json) {
    json(pulse);
    return;
  }
  out(renderStatusBlock(pulse));
}

/** The sprint states `--state` accepts (the `SprintStateDto` union). */
const SPRINT_STATES = new Set(['planned', 'active', 'complete']);

/** Parse a `--state active` filter into a validated state, or undefined. */
export function parseSprintState(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const state = raw.trim().toLowerCase();
  if (state === '') return undefined;
  if (!SPRINT_STATES.has(state)) {
    throw new CliError(`Unknown sprint state: ${raw.trim()}.`, {
      hint: `Valid states: ${[...SPRINT_STATES].join(', ')}.`,
    });
  }
  return state;
}

export interface SprintsOptions {
  state?: string;
  json?: boolean;
}

/** `motir sprints` — the project's sprints, the drill-down behind `motir
 *  status`'s one-line active-sprint block. */
export async function sprintsCommand(opts: SprintsOptions): Promise<void> {
  const state = parseSprintState(opts.state);
  const sprints = await withProjectSession(async ({ client, projectKey }) => {
    const list = await client.listSprints({ projectKey });
    return state ? list.sprints.filter((s) => s.state === state) : list.sprints;
  });

  if (opts.json) {
    // The tool's own rows, verbatim — filtered, never reshaped.
    json(sprints);
    return;
  }
  out(renderSprintsTable(sprints));
}

export interface SprintOptions {
  kinds?: string;
  json?: boolean;
}

/**
 * `motir sprint [ref]` — ONE sprint's work items, defaulting to the active
 * sprint. `ref` resolves as an id, then a case-insensitive name / name prefix
 * (`resolveSprintRef`); an ambiguous or unknown ref is an error, never a
 * silent pick.
 */
export async function sprintCommand(ref: string | undefined, opts: SprintOptions): Promise<void> {
  const kinds = parseKinds(opts.kinds);
  const result = await withProjectSession(async ({ client, projectKey }) => {
    const { sprints } = await client.listSprints({ projectKey });
    // Resolution happens BEFORE the item read, so a bad ref costs one call and
    // fails with the candidate list rather than an empty table.
    const sprint: SprintSummary = resolveSprintRef(sprints, ref);
    const { items, total } = await collectSprintItems(client, projectKey, sprint.id, { kinds });
    return { sprint, items, total };
  });

  if (opts.json) {
    // The sprint row and the item rows exactly as the tools returned them; the
    // pages are concatenated (a paged read cannot be one payload) and `total`
    // is the server's own count for the query.
    json(result);
    return;
  }
  out(renderSprintHeader(result.sprint));
  out();
  out(renderSprintItems(result.items, result.total));
}

/** A work item identifier: a project key, a dash, the number (`PROD-7`). The
 * server upper-cases it, so we do too — `motir show prod-7` is the same read. */
const ITEM_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * Validate a `PROD-7`-style key BEFORE any network call, so a typo fails with a
 * guiding one-liner instead of the server's generic not-found. A key that is
 * well-FORMED but unknown (or in another tenant) is the server's call — it
 * answers 404-not-403 by design, and that message is what the user sees.
 */
export function parseItemKey(raw: string, command: string): string {
  const key = raw.trim().toUpperCase();
  if (!ITEM_KEY.test(key)) {
    throw new CliError(`"${raw.trim()}" is not a work item key.`, {
      hint: `Keys look like PROD-7. Run \`motir ${command} PROD-7\`, or \`motir ready\` to list what you can pick up.`,
    });
  }
  return key;
}

export interface ShowOptions {
  json?: boolean;
  /** Also read the merged stream: comments and history interleaved. */
  activity?: boolean;
  /** Also read the comment threads only. */
  comments?: boolean;
}

/**
 * Which activity view the flags select, or `null` for neither.
 *
 * The two flags are alternatives, not a set — asking for both is a contradiction
 * about which stream to print, so it fails with the choice named rather than
 * silently taking one (the same "never silently picks" rule `resolveSprintRef`
 * holds to).
 */
export function activityView(opts: ShowOptions): 'all' | 'comments' | null {
  if (opts.activity && opts.comments) {
    throw new CliError('`--activity` and `--comments` cannot be combined.', {
      hint: '`--activity` prints comments AND history; `--comments` prints just the comments. Pick one.',
    });
  }
  if (opts.activity) return 'all';
  if (opts.comments) return 'comments';
  return null;
}

/**
 * `motir show <key>` — read ONE work item in the terminal: its fields, its
 * readiness verdict, its lineage + children, its dependency edges, and its raw
 * Markdown body.
 *
 * ONE tool call (`get_work_item`) does all of it — the aggregate already carries
 * everything, readiness included (and, since MOTIR-1848, each child's dependency
 * edges, which is what makes the children's build ORDER derivable without a
 * per-child read), so the CLI renders the server's verdict and never re-derives
 * it. A pure read: `show` never claims, transitions or edits.
 *
 * `--activity` / `--comments` (MOTIR-2000) add the DISCUSSION, which the
 * aggregate does not carry: one page of `get_work_item_activity`, appended below
 * the body. It is a SECOND call made only when asked — the default read stays
 * one round-trip, so a card with two hundred comments never slows down `show`
 * or the dispatch path that leans on it — and the output with neither flag is
 * byte-identical to what it was before they existed.
 */
/**
 * The v1 work-item resource with its children IN BUILD ORDER, each carrying the
 * `wave` the table computed.
 *
 * Both halves are the shipped `--json` contract and both are kept: a script that
 * reads this never re-derives the graph, and never has to sort. The only thing
 * the port changes is that the surrounding resource is the SERVER's own rather
 * than the CLI's narrowed view of it (ADR Amendment 14).
 *
 * The order and the wave come from the VIEW MODEL — `assignChildWaves` is
 * `render.ts`'s, and that file does not change — and are applied to the
 * payload's own children matched by KEY rather than by position, so the two
 * representations cannot silently drift out of correspondence.
 */
function withChildWaves(payload: unknown, detail: WorkItemDetail): Record<string, unknown> {
  const body = payload as Record<string, unknown>;
  const children = body['children'];
  if (!Array.isArray(children) || !hasChildEdges(detail)) return body;

  const byKey = new Map(children.map((child: unknown) => [(child as { key?: string }).key, child]));
  const ordered = assignChildWaves(detail.children).flatMap((entry) => {
    const child = byKey.get(entry.child.identifier);
    return child === undefined ? [] : [{ ...(child as object), wave: entry.wave }];
  });
  // A child the waves do not mention keeps its place at the end rather than
  // vanishing: the payload never carries fewer children than the server sent.
  const placed = new Set(detail.children.map((child) => child.identifier));
  const rest = children.filter(
    (child: unknown) => !placed.has((child as { key?: string }).key ?? ''),
  );
  return { ...body, children: [...ordered, ...rest] };
}

/** Whether the server projected the child edge block this build order needs. */
function hasChildEdges(detail: WorkItemDetail): boolean {
  return detail.children.some((child) => child.dependencies !== undefined);
}

export async function showCommand(key: string, opts: ShowOptions): Promise<void> {
  const identifier = parseItemKey(key, 'show');
  const view = activityView(opts);
  const { detail, payload, activity, activityPayload } = await withProjectSession(
    async ({ client }) => {
      const { detail, payload } = await client.readWorkItem(identifier);
      // No `cursor`, no `order`: this is a look at the newest page, not a walk.
      const read =
        view === null ? null : await client.readWorkItemActivity({ key: identifier, view });
      return { detail, payload, activity: read?.page ?? null, activityPayload: read?.payload };
    },
  );

  if (opts.json) {
    // The SERVER's own resource, not the CLI's narrowed view of it (ADR
    // Amendment 14). The view model deliberately omits fields nothing renders —
    // labels, components, the comment count, the provenance triple — and this
    // flag is the escape hatch that makes that omission safe, so it must carry
    // everything the server sent.
    //
    // The one thing ADDED is the `wave` per child, exactly as before: it is the
    // build order the table computed, and a script that had to re-derive the
    // graph to get it would be doing work the CLI already did. The
    // `dependencies` block rides through in FULL — the `+n` budget is a
    // terminal-width concern, not a payload one.
    //
    // A requested stream rides along under `activity`, the activity page
    // UNALTERED (its `nextCursor` and totals included). Without a flag the key
    // does not appear at all rather than appearing as null.
    const body = withChildWaves(payload, detail);
    json(view === null ? body : { ...body, activity: activityPayload });
    return;
  }
  out(renderWorkItemDetail(detail));
  if (view !== null && activity !== null) {
    out();
    out(renderActivityStream(view, activity, identifier, new Date()));
  }
}

export interface OpenOptions {
  /** Print the URL only; don't try to launch a browser. */
  print?: boolean;
}

export async function openCommand(key: string, opts: OpenOptions): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir open PROD-7`.');
  // No MCP call needed — the canonical URL comes straight from the link config
  // (no hardcoded host). Resolving the link also enforces the not-linked error.
  const link = requireLink();
  const url = issueUrl(link.config.serverUrl, trimmed);
  out(url);
  if (opts.print) return;
  const launched = await openUrl(url);
  if (!launched) info('(Could not open a browser here — the URL is above.)');
}
