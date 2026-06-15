import { normalizeServerUrl } from './config/userConfig.js';
import type { ReadyItemSummary, SearchFilterEnvelope, SprintSummary } from './mcpClient.js';

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
