import { CliError } from './errors.js';
import { normalizeServerUrl } from './config/userConfig.js';
import type {
  ReadyItemSummary,
  SearchFilterEnvelope,
  SearchItemSummary,
  SprintSummary,
  WorkItemDetail,
  WorkItemLink,
  WorkItemSummary,
} from './mcpClient.js';

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

const READY_HEADERS = ['KEY', 'KIND', 'PRIORITY', 'ASSIGNEE', 'TITLE'];

/** The `motir ready` table (or the empty-set line). Title is truncated so the
 * key/kind columns stay aligned in a normal terminal. */
export function renderReadyTable(items: ReadyItemSummary[], titleWidth = 60): string {
  if (items.length === 0) return 'No ready work items.';
  const rows = items.map((it) => [
    it.key,
    it.kind,
    it.priority,
    it.assignee?.name ?? 'unassigned',
    truncate(it.title, titleWidth),
  ]);
  const count = `${items.length} ready work item${items.length === 1 ? '' : 's'}:`;
  return `${count}\n${formatTable(READY_HEADERS, rows)}`;
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

/**
 * One sprint's work items. `total` is the server's own count for the query:
 * the printed count is asserted against it, so a page the CLI failed to
 * collect reads as a visible mismatch rather than a silently short table.
 */
export function renderSprintItems(
  items: SearchItemSummary[],
  total: number,
  titleWidth = 60,
): string {
  if (items.length === 0) return 'No work items in this sprint.';
  const rows = items.map((it) => [
    it.identifier,
    it.kind,
    it.status,
    it.priority,
    truncate(it.title, titleWidth),
  ]);
  const noun = `work item${total === 1 ? '' : 's'}`;
  // A mismatch can only mean the paging stopped early — say so IN the output
  // rather than printing a short table that reads as complete.
  const count =
    items.length === total
      ? `${total} ${noun}:`
      : `${items.length} of ${total} ${noun} (the rest could not be collected):`;
  return `${count}\n${formatTable(SPRINT_ITEM_HEADERS, rows)}`;
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
// 7.9.16 sorts the children into build-order WAVES and prepends a column, so
// the ROW BUILDER (`childRows`) and the TABLE renderer (`renderRelationTable`)
// are deliberately separate — the rows carry no ordering and the table carries
// no column set.

/** The columns `motir show` gives a CHILD row. 7.9.16 prepends `WAVE` /
 * `BLOCKED BY` to a copy of this rather than editing the renderer. */
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
 */
export function renderRelationTable(
  heading: string,
  rows: string[][],
  emptyLine: string,
  headers: string[] = EDGE_HEADERS,
): string {
  const title = `${heading} (${rows.length})`;
  if (rows.length === 0) return `${title}\n${emptyLine}`;
  return `${title}\n${formatTable(headers, rows)}`;
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
export function renderWorkItemDetail(detail: WorkItemDetail, titleWidth = 60): string {
  const sections = [
    renderItemHeader(detail.item),
    `READINESS\n${renderReadinessLine(detail.readiness)}`,
    `LINEAGE\n${renderLineage(detail)}`,
    renderRelationTable(
      'CHILDREN',
      childRows(detail.children, titleWidth),
      'no children',
      CHILD_HEADERS,
    ),
    renderRelationTable('BLOCKED BY', edgeRows(detail.blockedBy, titleWidth), 'none'),
    renderRelationTable('BLOCKS', edgeRows(detail.blocks, titleWidth), 'none'),
    renderRelationTable('RELATES TO', edgeRows(detail.relatesTo, titleWidth), 'none'),
  ];
  const body = detail.item.descriptionMd;
  if (body) sections.push(`DESCRIPTION\n${body.trimEnd()}`);
  return sections.join('\n\n');
}
