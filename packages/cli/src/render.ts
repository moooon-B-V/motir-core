import { CliError } from './errors.js';
import { normalizeServerUrl } from './config/userConfig.js';
import type {
  ActivityAllPage,
  ActivityComment,
  ActivityCommentThread,
  ActivityEntry,
  ActivityPage,
  ActivityPart,
  ActivityValue,
  CommentsPage,
  ReadyItemSummary,
  SearchFilterEnvelope,
  SearchItemSummary,
  SprintSummary,
  WorkItemChild,
  WorkItemDetail,
  WorkItemEdgeSummary,
  WorkItemLink,
  WorkItemSummary,
} from './client.js';

// Pure rendering + query-shaping helpers for the read commands (7.9.2). Kept
// free of I/O (no MCP, no stdout) so they are directly unit-testable and the
// command modules stay thin orchestration. The colour/shape token rules don't
// apply here — this is terminal text, not the design-system UI.

/** The FilterAST envelope version the server accepts (`FILTER_PARAM_VERSION`,
 * lib/filters/ast.ts). Pinned here so the CLI speaks the one supported version
 * without importing the Next app. */
export const FILTER_VERSION = 'v1';

/**
 * The default workflow's in_progress-CATEGORY status keys
 * (lib/workflows/defaultWorkflow.ts): both `in_progress` and `in_review` carry
 * `category: 'in_progress'`. "In flight" = a work item in either.
 *
 * The FilterAST has no category predicate and there is no workflow-read MCP
 * tool (and 7.9.2 adds NO server surface), so the in-flight query filters on
 * these well-known default-workflow keys. The registry treats an unknown status
 * key as matching nothing, so a project on a CUSTOM workflow that renamed these
 * simply reads as fewer/zero in-flight here — a documented limitation, never a
 * crash or a cross-tenant leak.
 */
export const IN_FLIGHT_STATUS_KEYS = ['in_progress', 'in_review'] as const;

/** Build the `search_work_items` envelope that selects the in-flight set. */
export function inFlightFilter(): SearchFilterEnvelope {
  return {
    version: FILTER_VERSION,
    combinator: 'and',
    conditions: [{ field: 'status', operator: 'is_any_of', value: [...IN_FLIGHT_STATUS_KEYS] }],
  };
}

/**
 * Build the `search_work_items` envelope that selects ONE sprint's work items,
 * optionally narrowed to a set of kinds.
 *
 * A sprint's items need no tool of their own: the FilterAST registry carries a
 * `sprint` facet (`lib/filters/registry.ts`), so the same grammar the /items
 * URL and saved filters use selects them — which is why `motir sprint` can
 * never disagree with the web app about what is in a sprint.
 */
export function sprintFilter(sprintId: string, kinds?: string[]): SearchFilterEnvelope {
  const conditions: SearchFilterEnvelope['conditions'] = [
    { field: 'sprint', operator: 'is_any_of', value: [sprintId] },
  ];
  if (kinds && kinds.length > 0) {
    conditions.push({ field: 'kind', operator: 'is_any_of', value: kinds });
  }
  return { version: FILTER_VERSION, combinator: 'and', conditions };
}

/** The canonical web URL for a work item, from the link's server + the
 * `PROD-<n>` key (the issue detail route is `<server>/issues/<key>`). No
 * hardcoded host — the server comes from `.motir.json`. */
export function issueUrl(serverUrl: string, key: string): string {
  return `${normalizeServerUrl(serverUrl)}/issues/${encodeURIComponent(key)}`;
}

/** Truncate to `max` chars with an ellipsis, so a long title can't wreck the
 * column alignment. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Render a fixed-width column table: a header row, an underline, then the body.
 * Each column is padded to the widest cell (header included). Right-aligns only
 * columns named in `rightAlign`. Returns the block as one string (no trailing
 * newline).
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  opts: { rightAlign?: number[] } = {},
): string {
  const right = new Set(opts.rightAlign ?? []);
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const pad = (cell: string, col: number): string => {
    const w = widths[col] ?? cell.length;
    return right.has(col) ? cell.padStart(w) : cell.padEnd(w);
  };
  const line = (cells: string[]): string =>
    cells
      .map((c, col) => pad(c, col))
      .join('  ')
      .trimEnd();
  const header = line(headers);
  const underline = widths.map((w) => '─'.repeat(w)).join('  ');
  return [header, underline, ...rows.map(line)].join('\n');
}

// ── dependency-EDGE cells (7.9.16 · MOTIR-1845) ─────────────────────────────
//
// The vocabulary EVERY surface that prints an edge shares — `motir ready`'s
// BLOCKS column, `motir sprint`'s BLOCKED BY + BLOCKS, and `motir show`'s wave
// view (7.9.16b). One budget, one overflow marker, one "already done" mark, one
// legend, so the three tables can never disagree about what a cell means.
//
// WHY A COLUMN AND NOT A GRAPH: a `blocked_by` edge only ever joins same-kind
// SIBLINGS under the same parent (plan-rules.md § Ordering follows the dependency
// arrow), so a plan is never one tangled DAG — it is many small closed ones, one
// per parent. `ready` / `sprint` hold a HETEROGENEOUS set spanning many parents,
// whose edges are therefore disconnected fragments with no graph to draw. The one
// surface that IS a single closed DAG is `show`'s children, which is exactly why
// that surface — and only that surface — gets a layered wave order.

/**
 * The default workflow's TERMINAL status keys (`category: 'done'` in
 * lib/workflows/defaultWorkflow.ts): `done` AND `cancelled`. An edge whose far
 * end is in either is SATISFIED — it no longer gates — which is exactly the
 * server's own readiness rule (`workflowsService.getTerminalStatusKeys`).
 *
 * The edge projection carries a raw status KEY and there is no workflow-read MCP
 * tool, so — like {@link IN_FLIGHT_STATUS_KEYS} — the CLI classifies against the
 * default workflow's well-known keys. A project on a CUSTOM workflow that renamed
 * its terminal statuses simply reads as more-blocked here (a conservative,
 * documented limitation), never as a crash and never as falsely-ready.
 */
export const TERMINAL_STATUS_KEYS = ['done', 'cancelled'] as const;

/** Whether an edge's far end is in a terminal status — i.e. no longer gates. */
export function isSatisfiedBlocker(status: string): boolean {
  return (TERMINAL_STATUS_KEYS as readonly string[]).includes(status);
}

/** How many edge keys ONE cell prints before the rest collapse to `+n`. The cell
 * never wraps: a wrapped cell would wreck `formatTable`'s column alignment for
 * every row below it, and the truncation is a DISPLAY concern only — `--json`
 * always carries the full block. */
export const EDGE_KEYS_BUDGET = 3;

/** Suffix marks: an edge whose far end is already terminal, and (wave view only)
 * a blocker outside the parent whose children are being ordered. */
const SATISFIED_MARK = '✓';
const EXTERNAL_MARK = '↗';

/** What each mark means. Printed per-mark, and only for a mark a row actually
 * SHOWS — a legend for a symbol not on the screen (one the `+n` budget cut, say)
 * is noise that reads as a promise the table did not keep. */
const MARK_LEGEND: [string, string][] = [
  [SATISFIED_MARK, `${SATISFIED_MARK} = already done`],
  [EXTERNAL_MARK, `${EXTERNAL_MARK} = blocker outside this parent`],
];

/** The legend line for whichever marks the given CELLS actually show, or `null`
 * when they show none. */
export function markLegend(cells: string[]): string | null {
  const shown = MARK_LEGEND.filter(([mark]) => cells.some((cell) => cell.includes(mark)));
  return shown.length > 0 ? shown.map(([, text]) => text).join(' · ') : null;
}

/** Join keys to a `, `-separated cell, collapsing everything past `budget` into a
 * `+n` marker. An EMPTY list renders BLANK — never a `0`, which would read as a
 * count the row does not have. */
export function overflowKeys(keys: string[], budget: number): string {
  if (keys.length === 0) return '';
  if (keys.length <= budget) return keys.join(', ');
  return `${keys.slice(0, budget).join(', ')} +${keys.length - budget}`;
}

/**
 * ONE edge cell for a row of a HETEROGENEOUS list (`ready` / `sprint`), in either
 * direction: the far-end keys, LIVE ones first — they are what the row is
 * actually waiting on, or actually holding up — then the terminal ones suffixed
 * `✓`, because an edge whose far end is done no longer gates and must not read as
 * if it does. `undefined` (a server with no edge projection) renders blank, the
 * same as no edges.
 *
 * Unlike {@link blockedByCell} there is no sibling/external split: on these
 * surfaces EVERY far end is outside the row's own parent, so the distinction
 * carries no information and the mark would be on every key.
 */
export function edgeCell(
  edges: WorkItemEdgeSummary[] | undefined,
  budget = EDGE_KEYS_BUDGET,
): string {
  if (!edges) return '';
  const live = edges.filter((e) => !isSatisfiedBlocker(e.status)).map((e) => e.key);
  const settled = edges
    .filter((e) => isSatisfiedBlocker(e.status))
    .map((e) => `${e.key}${SATISFIED_MARK}`);
  return overflowKeys([...live, ...settled], budget);
}

/**
 * Whether a page of rows carries the edge projection at all — TRUE only when
 * EVERY row does.
 *
 * All-or-nothing on purpose: the block comes from one batched read per page
 * (MOTIR-1842), so per-row absence is not a shape the server produces — a page
 * either has the projection or predates it. Requiring every row means an OLDER
 * Motir gets exactly the table it got before rather than a column of blanks that
 * would read as "nothing blocks anything" (the degradation this card owes).
 */
function hasEdges(rows: { dependencies?: unknown }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.dependencies !== undefined);
}

/** Append the mark legend to a rendered table, when its edge cells show a mark. */
function withLegend(table: string, cells: string[]): string {
  const legend = markLegend(cells);
  return legend ? `${table}\n${legend}` : table;
}

const READY_HEADERS = ['KEY', 'KIND', 'PRIORITY', 'ASSIGNEE', 'TITLE'];

/** {@link READY_HEADERS} with the downstream-impact column before the (truncated)
 * TITLE, so nothing after TITLE can lose its alignment. */
const READY_EDGE_HEADERS = ['KEY', 'KIND', 'PRIORITY', 'ASSIGNEE', 'BLOCKS', 'TITLE'];

/**
 * The `motir ready` table (or the empty-set line). Title is truncated so the
 * key/kind columns stay aligned in a normal terminal.
 *
 * A `BLOCKS` column (MOTIR-1845) names what each row UNBLOCKS — the direction
 * that carries information HERE, because a ready row's blockers are by definition
 * all satisfied, so a `BLOCKED BY` column would be dead on every row. What a
 * picker wants from this list is downstream impact: "do this one first, three
 * things are waiting on it." Against a server with no edge projection the column
 * is omitted entirely and this is exactly the table 7.9.2 shipped.
 */
export function renderReadyTable(items: ReadyItemSummary[], titleWidth = 60): string {
  if (items.length === 0) return 'No ready work items.';
  const graphed = hasEdges(items);
  const rows = items.map((it) => [
    it.key,
    it.kind,
    it.priority,
    it.assignee?.name ?? 'unassigned',
    ...(graphed ? [edgeCell(it.dependencies?.blocks)] : []),
    truncate(it.title, titleWidth),
  ]);
  const count = `${items.length} ready work item${items.length === 1 ? '' : 's'}:`;
  const headers = graphed ? READY_EDGE_HEADERS : READY_HEADERS;
  const table = `${count}\n${formatTable(headers, rows)}`;
  return graphed
    ? withLegend(
        table,
        rows.map((row) => row[4] ?? ''),
      )
    : table;
}

export interface StatusPulse {
  projectKey: string;
  readyCount: number;
  inFlightCount: number;
  activeSprint: SprintSummary | null;
  /** Sprint count, so "no active sprint" can distinguish "none planned" from
   * "some planned, none active". */
  totalSprints: number;
}

/** A sprint's window as `start → end`, with em-dashes for open ends. */
export function formatSprintWindow(sprint: SprintSummary): string {
  if (!sprint.startDate && !sprint.endDate) return '';
  return `${sprint.startDate ?? '—'} → ${sprint.endDate ?? '—'}`;
}

// ── sprints ─────────────────────────────────────────────────────────────────

/** An absent number, rendered as the same em-dash the web app uses for an
 * unestimated / unstarted sprint. */
const NONE = '—';

const SPRINTS_HEADERS = ['', 'STATE', 'NAME', 'ITEMS', 'POINTS', 'WINDOW'];

/**
 * The `motir sprints` table: every sprint in `sequence` order, the ACTIVE one
 * marked with a `*` in the leading column.
 *
 * Sorted here rather than trusted from the wire — `list_sprints` does return
 * sequence order today, but the ordering is part of what this table promises,
 * so it does not depend on a server detail the CLI cannot enforce.
 */
export function renderSprintsTable(sprints: SprintSummary[], nameWidth = 40): string {
  if (sprints.length === 0) return 'No sprints.';
  const ordered = [...sprints].sort((a, b) => a.sequence - b.sequence);
  const rows = ordered.map((s) => [
    s.state === 'active' ? '*' : '',
    s.state,
    truncate(s.name, nameWidth),
    String(s.issueCount),
    s.committedPoints === null ? NONE : String(s.committedPoints),
    formatSprintWindow(s) || NONE,
  ]);
  const count = `${ordered.length} sprint${ordered.length === 1 ? '' : 's'}:`;
  return `${count}\n${formatTable(SPRINTS_HEADERS, rows, { rightAlign: [3, 4] })}`;
}

/** The `motir sprint` header block: what this sprint IS, above its rows. */
export function renderSprintHeader(sprint: SprintSummary): string {
  const lines = [`${sprint.name}  [${sprint.state}]`];
  const window = formatSprintWindow(sprint);
  if (window) lines.push(window);
  if (sprint.goal) lines.push(`goal: ${sprint.goal}`);
  // The activation baseline, present only on a started sprint — omitted rather
  // than printed as em-dashes on a planned one, where it means nothing yet.
  if (sprint.committedIssueCount !== null || sprint.committedPoints !== null) {
    const issues = sprint.committedIssueCount === null ? NONE : String(sprint.committedIssueCount);
    const points = sprint.committedPoints === null ? NONE : String(sprint.committedPoints);
    lines.push(`committed: ${issues} issues · ${points} points`);
  }
  return lines.join('\n');
}

const SPRINT_ITEM_HEADERS = ['KEY', 'KIND', 'STATUS', 'PRIORITY', 'TITLE'];

/** {@link SPRINT_ITEM_HEADERS} with BOTH edge directions before the (truncated)
 * TITLE. `BLOCKED BY` comes first: on a mixed-status list it is the load-bearing
 * one — the reason a row is not moving. */
const SPRINT_ITEM_EDGE_HEADERS = [
  'KEY',
  'KIND',
  'STATUS',
  'PRIORITY',
  'BLOCKED BY',
  'BLOCKS',
  'TITLE',
];

/**
 * One sprint's work items. `total` is the server's own count for the query:
 * the printed count is asserted against it, so a page the CLI failed to
 * collect reads as a visible mismatch rather than a silently short table.
 *
 * `BLOCKED BY` + `BLOCKS` columns (MOTIR-1845) make an un-finishable sprint
 * legible from the terminal: unlike `ready`, a sprint holds mixed-status work, so
 * "what is holding this row up" is the question the table has to answer — and a
 * blocker already `done` is marked `✓` rather than counted, so a row nothing gates
 * cannot read as blocked. Omitted wholesale against a server with no edge
 * projection.
 */
export function renderSprintItems(
  items: SearchItemSummary[],
  total: number,
  titleWidth = 60,
): string {
  if (items.length === 0) return 'No work items in this sprint.';
  const graphed = hasEdges(items);
  const rows = items.map((it) => [
    it.identifier,
    it.kind,
    it.status,
    it.priority,
    ...(graphed ? [edgeCell(it.dependencies?.blockedBy), edgeCell(it.dependencies?.blocks)] : []),
    truncate(it.title, titleWidth),
  ]);
  const noun = `work item${total === 1 ? '' : 's'}`;
  // A mismatch can only mean the paging stopped early — say so IN the output
  // rather than printing a short table that reads as complete.
  const count =
    items.length === total
      ? `${total} ${noun}:`
      : `${items.length} of ${total} ${noun} (the rest could not be collected):`;
  const headers = graphed ? SPRINT_ITEM_EDGE_HEADERS : SPRINT_ITEM_HEADERS;
  const table = `${count}\n${formatTable(headers, rows)}`;
  return graphed
    ? withLegend(
        table,
        rows.flatMap((row) => [row[4] ?? '', row[5] ?? '']),
      )
    : table;
}

/**
 * Resolve a `motir sprint [ref]` argument to exactly ONE sprint, or throw.
 *
 * Resolution order: omitted → the ACTIVE sprint (the overwhelmingly common
 * case, and the same default `validate_sprint` takes); an exact id; an exact
 * case-insensitive name; otherwise a case-insensitive name PREFIX. An exact
 * name wins over a prefix so "Sprint 1" is not ambiguous with "Sprint 10".
 *
 * It never silently picks: no match and an ambiguous prefix are both a
 * {@link CliError} that names the candidates.
 */
export function resolveSprintRef(sprints: SprintSummary[], ref?: string): SprintSummary {
  if (ref === undefined || ref.trim() === '') {
    const active = sprints.find((s) => s.state === 'active');
    if (active) return active;
    throw new CliError('No sprint is active in this project.', {
      hint: 'Run `motir sprints` to see every sprint, then `motir sprint <name>`.',
    });
  }

  const needle = ref.trim();
  const byId = sprints.find((s) => s.id === needle);
  if (byId) return byId;

  const lower = needle.toLowerCase();
  const byName = sprints.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0] as SprintSummary;

  const byPrefix = byName.length > 0 ? byName : sprints.filter(prefixMatch(lower));
  if (byPrefix.length === 1) return byPrefix[0] as SprintSummary;
  if (byPrefix.length > 1) {
    throw new CliError(`"${needle}" matches ${byPrefix.length} sprints.`, {
      hint: `Name one of: ${byPrefix.map((s) => s.name).join(', ')}.`,
    });
  }
  throw new CliError(`No sprint matches "${needle}".`, {
    hint: 'Run `motir sprints` to see this project’s sprints (a name, a name prefix, or an id).',
  });
}

function prefixMatch(lower: string): (sprint: SprintSummary) => boolean {
  return (sprint) => sprint.name.toLowerCase().startsWith(lower);
}

/** The compact `motir status` block. */
export function renderStatusBlock(pulse: StatusPulse): string {
  const lines = [
    `Project:    ${pulse.projectKey}`,
    `Ready:      ${pulse.readyCount}`,
    `In flight:  ${pulse.inFlightCount}  (in progress + in review)`,
  ];
  if (pulse.activeSprint) {
    const s = pulse.activeSprint;
    lines.push(
      `Sprint:     ${s.name}  [active, ${s.issueCount} issue${s.issueCount === 1 ? '' : 's'}]`,
    );
    const window = formatSprintWindow(s);
    if (window) lines.push(`            ${window}`);
    if (s.goal) lines.push(`            goal: ${s.goal}`);
  } else if (pulse.totalSprints === 0) {
    lines.push('Sprint:     (no sprints)');
  } else {
    lines.push('Sprint:     (none active)');
  }
  return lines.join('\n');
}

// ── `motir show <key>` — the item DETAIL block (7.9.13) ─────────────────────
//
// The renderers below turn one `get_work_item` aggregate into the terminal
// read: header → readiness → lineage → children → the three dependency edge
// groups → the body. Each is pure and separately exported, because the block is
// assembled from parts that later cards re-arrange rather than rewrite:
// 7.9.16b sorts the children into build-order WAVES and widens the column set,
// so the ROW BUILDER (`childRows`) and the TABLE renderer (`renderRelationTable`)
// are deliberately separate — the rows carry no ordering and the table carries
// no column set. It reuses both as-is (see `renderChildrenSection` below).

/** The columns `motir show` gives a CHILD row. The WAVE view builds
 * {@link WAVE_CHILD_HEADERS} around a copy of this rather than editing the
 * renderer. */
export const CHILD_HEADERS = ['KEY', 'KIND', 'STATUS', 'TITLE'];

/** The columns an EDGE row (blocked by / blocks / relates to) gets. */
export const EDGE_HEADERS = ['KEY', 'STATUS', 'TITLE'];

/** ONE work-item summary as CHILD cells, in {@link CHILD_HEADERS} order. */
export function childRow(child: WorkItemSummary, titleWidth = 60): string[] {
  return [child.identifier, child.kind, child.status, truncate(child.title, titleWidth)];
}

/**
 * `(children) => rows` — the child list as table cells, in the order given.
 *
 * Pure and order-PRESERVING: `motir show` passes the server's source order,
 * and 7.9.16 passes the same children topologically sorted into dependency
 * waves. Neither ordering nor the column set is baked in here.
 */
export function childRows(children: WorkItemSummary[], titleWidth = 60): string[][] {
  return children.map((child) => childRow(child, titleWidth));
}

/** `(links) => rows` — dependency edges as `key · status · title` cells. */
export function edgeRows(links: WorkItemLink[], titleWidth = 60): string[][] {
  return links.map(({ item }) => [item.identifier, item.status, truncate(item.title, titleWidth)]);
}

/**
 * A named section: `HEADING (n)` and either the table or the empty line. Rows
 * come in already built (and already ordered), so a caller can re-sort them or
 * hand a wider `headers` set without touching this.
 *
 * `note` annotates the COUNT line (`CHILDREN (6) — build order`) — how the rows
 * below are ordered, when that is not the server's own order. Dropped on an
 * empty section, where there is no ordering to explain.
 */
export function renderRelationTable(
  heading: string,
  rows: string[][],
  emptyLine: string,
  headers: string[] = EDGE_HEADERS,
  note?: string,
): string {
  const title = `${heading} (${rows.length})`;
  if (rows.length === 0) return `${title}\n${emptyLine}`;
  return `${note ? `${title} — ${note}` : title}\n${formatTable(headers, rows)}`;
}

// ── build-order WAVES (7.9.16b · MOTIR-1848) ────────────────────────────────
//
// The children of one parent form a small DAG (`blocked_by` between siblings).
// A WAVE is a layer of that DAG: wave 1 is the parent's LOCAL ready set — every
// child nothing un-done gates — wave 2 is what only wave 1 gates, and so on. The
// wave NUMBER is the graph: it says what can be worked in parallel right now and
// what has to wait, in a column, next to the status and title you need in order
// to act on it. (Deliberately NOT a `git log --graph` rail: a within-story DAG
// fans and a node routinely carries several blockers, which needs lane
// assignment + crossing edges — illegible past ~3 lanes, and it leaves nowhere
// to put status or title. A true graph view belongs on the web canvas.)

/** One child placed in the build order, with the blockers that put it there. */
export interface ChildWave {
  child: WorkItemChild;
  /** 1-based build wave — or `null` when the child sits in a dependency CYCLE
   * and therefore has no position in any build order. */
  wave: number | null;
  /** Un-done blockers that are SIBLINGS — the only edges that set the wave. */
  siblingBlockers: string[];
  /** Un-done blockers OUTSIDE this parent. The plan rules forbid these, but the
   * data can hold them: they are NAMED (so the reason for the wait is visible)
   * and deliberately do NOT form a sibling layer — nothing in this table can
   * clear them, so counting them would distort every wave below. */
  externalBlockers: string[];
  /** Blockers already terminal. Shown, so "why is this wave 1" is answerable
   * from the row rather than from memory. */
  satisfiedBlockers: string[];
}

/**
 * `(children) => the same children, layered into build waves` — PURE, and the
 * whole graph computation `motir show` does.
 *
 * STABLE: each wave keeps the order the children arrived in (the server's), so
 * two runs against unchanged data render identically. Cycle members — children
 * whose sibling blockers can never all resolve — come LAST with `wave: null`,
 * because a cycle is a planning bug to REPORT, not a reason to fail or to draw a
 * false order.
 */
export function assignChildWaves(children: WorkItemChild[]): ChildWave[] {
  const siblingKeys = new Set(children.map((c) => c.identifier));
  const classified = children.map((child) => {
    const entry: ChildWave = {
      child,
      wave: null,
      siblingBlockers: [],
      externalBlockers: [],
      satisfiedBlockers: [],
    };
    for (const edge of child.dependencies?.blockedBy ?? []) {
      if (isSatisfiedBlocker(edge.status)) entry.satisfiedBlockers.push(edge.key);
      else if (siblingKeys.has(edge.key)) entry.siblingBlockers.push(edge.key);
      else entry.externalBlockers.push(edge.key);
    }
    return entry;
  });

  // Kahn layering. Each pass takes every child whose sibling blockers are ALL
  // already placed, off a snapshot taken before the pass — so two siblings that
  // block each other's peer never land in the same wave.
  const placed = new Map<string, number>();
  const ordered: ChildWave[] = [];
  let remaining = classified;
  for (let wave = 1; remaining.length > 0; wave += 1) {
    const ready = remaining.filter((e) => e.siblingBlockers.every((k) => placed.has(k)));
    if (ready.length === 0) break; // only cycles left
    for (const entry of ready) {
      entry.wave = wave;
      ordered.push(entry);
    }
    for (const entry of ready) placed.set(entry.child.identifier, wave);
    remaining = remaining.filter((e) => !placed.has(e.child.identifier));
  }
  return [...ordered, ...remaining];
}

/** The cycle members left unplaced by {@link assignChildWaves}, in table order. */
export function cycleMembers(waves: ChildWave[]): string[] {
  return waves.filter((w) => w.wave === null).map((w) => w.child.identifier);
}

/** The columns the WAVE view gives a child: {@link CHILD_HEADERS} with the build
 * order in front and the blockers beside the status. TITLE stays last — it is
 * the truncated column, so nothing after it can lose its alignment. */
export const WAVE_CHILD_HEADERS = ['WAVE', 'KEY', 'KIND', 'STATUS', 'BLOCKED BY', 'TITLE'];

/** The WAVE cell for a child that has no wave (a cycle member). */
const NO_WAVE = '—';

/**
 * ONE child's `BLOCKED BY` cell: the blocker keys, un-done siblings first (they
 * are what the wait is actually about), then external, then satisfied. Beyond
 * {@link EDGE_KEYS_BUDGET} keys the rest collapse to `+n` — a fan-in of nine
 * must not push TITLE off the terminal. No blockers renders BLANK, not a zero.
 */
export function blockedByCell(entry: ChildWave, budget = EDGE_KEYS_BUDGET): string {
  return overflowKeys(
    [
      ...entry.siblingBlockers,
      ...entry.externalBlockers.map((k) => `${k}${EXTERNAL_MARK}`),
      ...entry.satisfiedBlockers.map((k) => `${k}${SATISFIED_MARK}`),
    ],
    budget,
  );
}

/** `(waves) => rows` — the wave view's cells, in {@link WAVE_CHILD_HEADERS}
 * order. Built from {@link childRow}, so the four shared columns can never drift
 * between the plain table and this one. */
export function waveChildRows(
  waves: ChildWave[],
  titleWidth = 60,
  budget = EDGE_KEYS_BUDGET,
): string[][] {
  return waves.map((entry) => {
    const cells = childRow(entry.child, titleWidth);
    const wave = entry.wave === null ? NO_WAVE : String(entry.wave);
    // CHILD_HEADERS is KEY · KIND · STATUS · TITLE — the blockers go before the
    // (truncated) title, the wave in front.
    return [wave, ...cells.slice(0, 3), blockedByCell(entry, budget), ...cells.slice(3)];
  });
}

/**
 * The whole CHILDREN section, in whichever of its two forms the server supports.
 *
 * With the per-child `dependencies` block (MOTIR-1848) it is the build-order WAVE
 * view. WITHOUT it — an older Motir, since the CLI ships to npm on its own
 * release train — it is exactly the table 7.9.13 shipped: the CLI degrades to the
 * truth it can prove rather than inventing an order or failing on a field it
 * never got.
 */
export function renderChildrenSection(children: WorkItemChild[], titleWidth = 60): string {
  if (!hasEdges(children)) {
    return renderRelationTable(
      'CHILDREN',
      childRows(children, titleWidth),
      'no children',
      CHILD_HEADERS,
    );
  }

  const waves = assignChildWaves(children);
  const rows = waveChildRows(waves, titleWidth);
  const lines = [
    renderRelationTable('CHILDREN', rows, 'no children', WAVE_CHILD_HEADERS, 'build order'),
  ];
  const legend = markLegend(rows.map((row) => row[4] ?? ''));
  if (legend) lines.push(legend);
  const cycle = cycleMembers(waves);
  if (cycle.length > 0) {
    // Reported, not thrown: `show` reads a plan, and a plan that cannot be
    // ordered is precisely what the reader needs to be told.
    lines.push(
      `⚠ dependency CYCLE — ${cycle.join(', ')} block each other and have no build order. ` +
        'Fix the blocked_by edges.',
    );
  }
  return lines.join('\n');
}

/** A child as `show --json` emits it: the full, UNTRUNCATED `dependencies` block
 * plus the wave the table computed, so a script gets the build order without
 * re-deriving the graph. */
export type WorkItemChildWithWave = WorkItemChild & { wave: number | null };

/**
 * The `show --json` payload: the tool's own aggregate, with `children` re-ordered
 * into build order and each carrying its `wave` (`null` for a cycle member).
 * Against a server with no per-child edges the aggregate passes through
 * UNCHANGED — the same degradation the table takes.
 */
export function detailWithWaves(
  detail: WorkItemDetail,
): WorkItemDetail | (Omit<WorkItemDetail, 'children'> & { children: WorkItemChildWithWave[] }) {
  if (!hasEdges(detail.children)) return detail;
  return {
    ...detail,
    children: assignChildWaves(detail.children).map((entry) => ({
      ...entry.child,
      wave: entry.wave,
    })),
  };
}

/** The item's identity line + its field line. A null field is OMITTED rather
 * than printed as `null` — an absent estimate reads as absent, not as zero. */
export function renderItemHeader(item: WorkItemDetail['item']): string {
  const kindType = item.type ? `${item.kind}/${item.type}` : item.kind;
  // status + priority are non-null on every work item; the rest are optional and
  // simply do not appear when unset (never `null`, never a placeholder). A ZERO
  // story-point estimate is a real value, so the test is `!== null`, not falsy.
  const fields = [`status ${item.status}`, `priority ${item.priority}`];
  const add = (label: string, value: string | number | null): void => {
    if (value !== null) fields.push(`${label} ${value}`);
  };
  add('assignee', item.assigneeId);
  add('type', item.type);
  add('executor', item.executor);
  add('points', item.storyPoints);
  add('estimate', item.estimateMinutes === null ? null : `${item.estimateMinutes}m`);
  add('sprint', item.sprintId);
  add('repo', item.targetRepo);
  return `${item.identifier}  [${kindType}]  ${item.title}\n${fields.join(' · ')}`;
}

/**
 * The readiness verdict as one line, in the three shapes the DTO distinguishes:
 * `ready`, the item's OWN open blockers (named), and the CASCADE case where a
 * blocked ancestor holds it back. The cascade case names the ancestor precisely
 * so a cascade-blocked item never reads as a bare "blocked" with nothing to
 * point at.
 */
export function renderReadinessLine(readiness: WorkItemDetail['readiness']): string {
  if (readiness.ready) return 'ready';
  if (readiness.openBlockers.length > 0) {
    return `blocked by ${readiness.openBlockers.map((b) => b.identifier).join(', ')}`;
  }
  const ancestor = readiness.blockedByAncestor;
  if (ancestor) return `blocked by ancestor ${ancestor.identifier} — ${ancestor.title}`;
  return 'blocked';
}

/** The parent breadcrumb, root→self. A top-level item has no ancestors, so the
 * trail is the item alone. */
export function renderLineage(detail: WorkItemDetail): string {
  return [...detail.ancestors.map((a) => a.identifier), detail.item.identifier].join(' › ');
}

/**
 * The whole `motir show` block. Sections are separated by a blank line and
 * headed in caps, matching the CLI's own help surface; the DESCRIPTION is the
 * RAW Markdown, printed verbatim — the terminal is not a Markdown viewer, and
 * the body is what a human pastes into an agent.
 */
// ── the ACTIVITY stream (`show --activity` / `--comments` · MOTIR-2000) ──────
//
// The consumer half of `get_work_item_activity` (MOTIR-1999). The DTO ships
// DATA — typed parts, resolved values — and the wording is the CLIENT's, exactly
// as the web Activity section owns its own sentence grammar through next-intl.
// This is that grammar for a terminal: one block per entry, the author and a
// relative time on the header line (with the absolute stamp beside it, since a
// terminal has no hover to reveal it), the body indented underneath.
//
// TWO invariants the renderer must not break:
//   1. NO TRUNCATION of a comment body (the MOTIR-1709 rule the tool inherits) —
//      an agent reading a cut-off rationale is worse off than one that knows it
//      must page. The `truncate` helper above is for TABLE CELLS; nothing here
//      uses it.
//   2. NO DRAIN LOOP. One page is printed and what remains is STATED (the CLI's
//      own at-scale rule, finding #57). A short page with a non-null cursor is
//      documented normal for the merged stream, so silence would read as "that
//      is all" — which is exactly the lie the footer exists to prevent.

/** The em-dash an absent value renders as — the same one the sprint table uses
 *  for an unset number, and what `ActivityValueDto`'s `none` form means. */
const NO_VALUE = '—';

/** What the two views print when the item has nothing recorded. Explicit lines,
 *  never a bare blank: "nothing here" and "the read failed" must not look alike. */
export const NO_COMMENTS_LINE = 'No comments yet.';
export const NO_ACTIVITY_LINE = 'No activity yet.';

/** Header prefixes. All three are the SAME WIDTH so every body indents to one
 *  column, and a reply stays visually attached to the comment it answers. */
const COMMENT_PREFIX = '[comment] ';
const REPLY_PREFIX = '  ↳ reply ';
const CHANGE_PREFIX = '[change]  ';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** `n` with its noun, pluralized. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * How long ago, in the coarse unit a reader actually wants ("3 days ago").
 *
 * `now` is a PARAMETER, not a `new Date()` inside: a renderer that reads the
 * clock cannot be asserted against a fixed expectation, and a test that pins one
 * would rot the moment the fixture aged (the hardcoded-period-vs-wall-clock
 * trap). A stamp in the FUTURE — clock skew between the server and this box —
 * reads as "just now" rather than as a negative age, and an unparseable stamp
 * degrades to itself rather than to `NaN`.
 */
export function relativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const delta = now.getTime() - then;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${plural(Math.floor(delta / MINUTE), 'minute')} ago`;
  if (delta < DAY) return `${plural(Math.floor(delta / HOUR), 'hour')} ago`;
  if (delta < MONTH) return `${plural(Math.floor(delta / DAY), 'day')} ago`;
  if (delta < YEAR) return `${plural(Math.floor(delta / MONTH), 'month')} ago`;
  return `${plural(Math.floor(delta / YEAR), 'year')} ago`;
}

/**
 * One side of a change, in its display form — the resolved label, falling back
 * to the stored id when the referent is gone (a deleted user, an archived
 * sprint), never dropping both.
 *
 * The `default` branch is NOT dead code: `ActivityValue` mirrors an open union
 * on purpose (client.ts), because a newer server can send a value type this
 * published CLI has never seen. It prints whatever resolved label the value
 * carries instead of failing on a shape it cannot name.
 */
export function activityValueText(value: ActivityValue | string | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  if (typeof value === 'string') return value;
  switch (value.type) {
    case 'none':
      return NO_VALUE;
    case 'text':
      return value.text ?? NO_VALUE;
    case 'status':
      return value.label ?? value.key ?? NO_VALUE;
    case 'user':
      return value.name ?? value.userId ?? NO_VALUE;
    case 'date':
      return value.date ?? NO_VALUE;
    case 'sprint':
      return value.name ?? value.sprintId ?? NO_VALUE;
    case 'issue':
      return value.identifier ?? value.workItemId ?? NO_VALUE;
    default:
      return value.label ?? value.name ?? value.identifier ?? value.text ?? value.key ?? NO_VALUE;
  }
}

/**
 * ONE part of a history entry as a sentence fragment — a revision may carry
 * several (one save touching many fields), which is why the entry joins them
 * rather than assuming one.
 *
 * Total by construction, including over kinds that do not exist yet: an
 * unrecognized part degrades to the GENERIC form (name the change, show what
 * sides it carries) instead of throwing. A published CLI meeting a newer Motir
 * is the ordinary case, not the exceptional one.
 */
export function activityPartText(part: ActivityPart): string {
  switch (part.kind) {
    case 'created':
      return 'created the item';
    case 'archived':
      return 'archived the item';
    case 'unarchived':
      return 'restored the item';
    case 'field':
      return `changed ${part.field}: ${activityValueText(part.from)} → ${activityValueText(part.to)}`;
    // The trail records THAT a body field changed, never its text (the DTO
    // carries none) — said plainly, so it never reads as a truncation.
    case 'fieldEdited':
      return `edited ${part.field} (body not shown — the history trail records no text)`;
    case 'link':
      return `${part.op} ${part.linkKind} link → ${activityValueText(part.target)}`;
    case 'collection':
      return `${part.op} ${part.field}: ${(part.items ?? []).join(', ')}`;
    case 'commentDeleted': {
      const replies = part.replyCount ?? 0;
      return `deleted a comment by ${activityValueText(part.author)} (${replies} ${replies === 1 ? 'reply' : 'replies'})`;
    }
    case 'generic':
      return `${part.key}: ${activityValueText(part.from)} → ${activityValueText(part.to)}`;
    default:
      if (part.from === undefined && part.to === undefined) {
        return `${part.kind} (unknown change kind — update the CLI to read it in full)`;
      }
      return `${part.kind}: ${activityValueText(part.from)} → ${activityValueText(part.to)}`;
  }
}

/** `<author> · <relative> (<absolute>)` — the header line every block shares. */
function attribution(who: string | null, iso: string, now: Date): string {
  return `${who ?? 'former member'} · ${relativeTime(iso, now)} (${iso})`;
}

/** ONE history entry: who, when, and every part it carries. */
export function renderHistoryEntry(entry: ActivityEntry, now: Date): string {
  const parts = entry.parts.map(activityPartText).join('; ');
  return `${CHANGE_PREFIX}${attribution(entry.actor.name, entry.changedAt, now)} — ${parts}`;
}

/** ONE comment: the header, then the body VERBATIM and in FULL, indented to the
 *  prefix so a multi-line Markdown comment stays attached to its author. Not one
 *  character is dropped — the no-truncation invariant above. */
export function renderComment(comment: ActivityComment, prefix: string, now: Date): string {
  const edited = comment.editedAt === null ? '' : ' (edited)';
  const indent = ' '.repeat(prefix.length);
  const header = `${prefix}${attribution(comment.author.name, comment.createdAt, now)}${edited}`;
  const body = comment.bodyMd
    .split('\n')
    // A blank line stays blank — indenting it would append trailing whitespace
    // to output people pipe and diff. The body's own characters are untouched.
    .map((line) => (line === '' ? '' : `${indent}${line}`))
    .join('\n');
  return `${header}\n${body}`;
}

/** A root comment plus its single-level replies, nested one level. */
export function renderCommentThread(thread: ActivityCommentThread, now: Date): string {
  return [
    renderComment(thread, COMMENT_PREFIX, now),
    ...thread.replies.map((reply) => renderComment(reply, REPLY_PREFIX, now)),
  ].join('\n');
}

/** Every comment a thread holds — the root plus its replies — because the
 *  server's totals count replies too, and "5 of 12" has to compare like to like. */
function commentsIn(threads: ActivityCommentThread[]): number {
  return threads.reduce((sum, thread) => sum + 1 + thread.replies.length, 0);
}

/** `12 comments` when the page holds them all, `5 of 12 comments` when it does
 *  not — the page never claims to be the whole stream. */
function shownOfTotal(shown: number, total: number, noun: string): string {
  return shown === total ? plural(total, noun) : `${shown} of ${plural(total, noun)}`;
}

/**
 * The footer, printed only when the server handed back a cursor.
 *
 * `motir show` deliberately has NO `--cursor` flag: this is a look, not a walk,
 * and a CLI that pages a discussion is a different command than this card ships.
 * So "how to continue" is the honest one — the web Activity section, reachable
 * from here in one command — and the remainder is stated so the page cannot read
 * as complete. A non-null cursor with nothing left to count is the documented
 * short-page case, and says so rather than claiming a number it does not have.
 */
function moreLine(remaining: [number, string][], identifier: string): string {
  const left = remaining.filter(([count]) => count > 0).map(([count, noun]) => plural(count, noun));
  const what =
    left.length > 0
      ? `${left.join(' and ')} not on this page`
      : 'this page may be short — the stream is not exhausted';
  return `MORE — ${what}. \`motir show\` prints ONE page and never drains the stream; read the rest in Motir: \`motir open ${identifier}\`.`;
}

/**
 * Assemble a stream section: heading, count line, the blocks, the footer.
 *
 * Entries are separated by a BLANK LINE (a thread's replies are not — they stay
 * attached to the comment they answer). A comment body is multi-line Markdown,
 * so run together the blocks read as one wall of text and the boundary between
 * two people's words disappears.
 */
function activitySection(
  heading: string,
  counts: string,
  blocks: string[],
  emptyLine: string,
  more: string | null,
): string {
  const body = blocks.length === 0 ? [emptyLine] : blocks;
  return [`${heading}\n${counts}`, body.join('\n\n'), ...(more === null ? [] : [more])].join(
    '\n\n',
  );
}

/**
 * The whole ACTIVITY / COMMENTS block appended to `motir show`.
 *
 * `view` selects the section, and it comes from the FLAG rather than from
 * sniffing the payload: the two page shapes are the server's own, and a renderer
 * that guessed which one it held would disagree with the tool the first time a
 * page came back empty.
 *
 * The merged view makes no claim about ordering — every block carries its own
 * timestamp, and the CLI never sends `order`, so asserting a direction here
 * would be asserting a server default this build cannot see. The comments view
 * DOES state one, because its page carries `order`.
 */
export function renderActivityStream(
  view: 'all' | 'comments',
  page: ActivityPage,
  identifier: string,
  now: Date,
): string {
  if (view === 'comments') {
    const p = page as CommentsPage;
    const shown = commentsIn(p.threads);
    const direction = p.order === 'asc' ? 'oldest first' : 'newest first';
    return activitySection(
      'COMMENTS',
      `${shownOfTotal(shown, p.totalCount, 'comment')}, ${direction}`,
      p.threads.map((thread) => renderCommentThread(thread, now)),
      NO_COMMENTS_LINE,
      p.nextCursor === null ? null : moreLine([[p.totalCount - shown, 'comment']], identifier),
    );
  }

  const p = page as ActivityAllPage;
  const shownComments = commentsIn(
    p.entries.flatMap((entry) => (entry.type === 'comment' ? [entry.thread] : [])),
  );
  const shownChanges = p.entries.filter((entry) => entry.type === 'history').length;
  return activitySection(
    'ACTIVITY',
    [
      shownOfTotal(shownComments, p.totalComments, 'comment'),
      shownOfTotal(shownChanges, p.totalChanges, 'change'),
    ].join(' · '),
    p.entries.map((entry) =>
      entry.type === 'comment'
        ? renderCommentThread(entry.thread, now)
        : renderHistoryEntry(entry.entry, now),
    ),
    NO_ACTIVITY_LINE,
    p.nextCursor === null
      ? null
      : moreLine(
          [
            [p.totalComments - shownComments, 'comment'],
            [p.totalChanges - shownChanges, 'change'],
          ],
          identifier,
        ),
  );
}

export function renderWorkItemDetail(detail: WorkItemDetail, titleWidth = 60): string {
  const sections = [
    renderItemHeader(detail.item),
    `READINESS\n${renderReadinessLine(detail.readiness)}`,
    `LINEAGE\n${renderLineage(detail)}`,
    renderChildrenSection(detail.children, titleWidth),
    renderRelationTable('BLOCKED BY', edgeRows(detail.blockedBy, titleWidth), 'none'),
    renderRelationTable('BLOCKS', edgeRows(detail.blocks, titleWidth), 'none'),
    renderRelationTable('RELATES TO', edgeRows(detail.relatesTo, titleWidth), 'none'),
  ];
  const body = detail.item.descriptionMd;
  if (body) sections.push(`DESCRIPTION\n${body.trimEnd()}`);
  return sections.join('\n\n');
}
