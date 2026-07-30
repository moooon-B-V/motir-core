import { describe, expect, it, vi } from 'vitest';
import {
  CHILD_HEADERS,
  EDGE_HEADERS,
  EDGE_KEYS_BUDGET,
  FILTER_VERSION,
  IN_FLIGHT_STATUS_KEYS,
  TERMINAL_STATUS_KEYS,
  WAVE_CHILD_HEADERS,
  assignChildWaves,
  blockedByCell,
  childRow,
  childRows,
  cycleMembers,
  detailWithWaves,
  edgeCell,
  edgeRows,
  formatSprintWindow,
  formatTable,
  inFlightFilter,
  isSatisfiedBlocker,
  issueUrl,
  markLegend,
  overflowKeys,
  renderChildrenSection,
  renderItemHeader,
  renderLineage,
  renderReadinessLine,
  renderReadyTable,
  renderRelationTable,
  renderSprintHeader,
  renderSprintItems,
  renderSprintsTable,
  renderStatusBlock,
  renderWorkItemDetail,
  resolveSprintRef,
  sprintFilter,
  truncate,
  waveChildRows,
  type StatusPulse,
} from '../src/render.js';
import { CliError } from '../src/errors.js';
import type {
  ReadyItemSummary,
  SearchItemSummary,
  SprintSummary,
  WorkItemChild,
  WorkItemDependencyEdges,
  WorkItemDetail,
  WorkItemSummary,
} from '../src/mcpClient.js';

describe('issueUrl', () => {
  it('builds <server>/issues/<key> from the link server (no hardcoded host)', () => {
    expect(issueUrl('https://app.motir.co', 'PROD-7')).toBe('https://app.motir.co/issues/PROD-7');
  });
  it('strips a trailing slash from the server', () => {
    expect(issueUrl('https://app.motir.co/', 'PROD-12')).toBe(
      'https://app.motir.co/issues/PROD-12',
    );
  });
  it('encodes the key', () => {
    expect(issueUrl('http://localhost:3000', 'PROD 7')).toBe(
      'http://localhost:3000/issues/PROD%207',
    );
  });
});

describe('inFlightFilter', () => {
  it('is a v1 envelope selecting the in_progress-category status keys', () => {
    const f = inFlightFilter();
    expect(f.version).toBe(FILTER_VERSION);
    expect(f.combinator).toBe('and');
    expect(f.conditions).toEqual([
      { field: 'status', operator: 'is_any_of', value: ['in_progress', 'in_review'] },
    ]);
    expect(IN_FLIGHT_STATUS_KEYS).toEqual(['in_progress', 'in_review']);
  });
});

describe('truncate', () => {
  it('leaves short text alone and ellipsizes long text', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a very long title indeed', 10)).toBe('a very lo…');
    expect(truncate('a very long title indeed', 10)).toHaveLength(10);
  });
});

describe('formatTable', () => {
  it('pads columns to the widest cell (header included) and underlines', () => {
    const table = formatTable(
      ['KEY', 'TITLE'],
      [
        ['PROD-7', 'Do the thing'],
        ['PROD-12', 'X'],
      ],
    );
    const lines = table.split('\n');
    expect(lines[0]).toBe('KEY      TITLE');
    expect(lines[1]).toMatch(/^─+ {2}─+$/);
    expect(lines[2]).toBe('PROD-7   Do the thing');
    expect(lines[3]).toBe('PROD-12  X');
  });
  it('right-aligns named columns', () => {
    const table = formatTable(['N'], [['1'], ['100']], { rightAlign: [0] });
    const lines = table.split('\n');
    expect(lines[2]).toBe('  1');
    expect(lines[3]).toBe('100');
  });
});

const readyItem = (over: Partial<ReadyItemSummary>): ReadyItemSummary => ({
  key: 'PROD-7',
  kind: 'subtask',
  title: 'Read commands',
  priority: 'high',
  assignee: { id: 'u1', name: 'Odie' },
  ...over,
});

describe('renderReadyTable', () => {
  it('renders the empty-set line', () => {
    expect(renderReadyTable([])).toBe('No ready work items.');
  });
  it('renders a count header + a row with the unassigned fallback', () => {
    const out = renderReadyTable([
      readyItem({}),
      readyItem({ key: 'PROD-9', assignee: null, priority: 'low' }),
    ]);
    expect(out).toContain('2 ready work items:');
    expect(out).toContain('PROD-7');
    expect(out).toContain('Odie');
    expect(out).toContain('unassigned');
  });
  it('singularizes the count for one row', () => {
    expect(renderReadyTable([readyItem({})])).toContain('1 ready work item:');
  });
});

// ── dependency-edge cells (7.9.16 · MOTIR-1845) ─────────────────────────────

/** A `dependencies` block from `[key, status]` pairs; `status` defaults to todo. */
const edges = (over: {
  blockedBy?: (string | [string, string])[];
  blocks?: (string | [string, string])[];
}): WorkItemDependencyEdges => {
  const far = (e: string | [string, string]) => {
    const [key, status] = typeof e === 'string' ? [e, 'todo'] : e;
    return { key, title: `Far end ${key}`, status: status as string };
  };
  return { blockedBy: (over.blockedBy ?? []).map(far), blocks: (over.blocks ?? []).map(far) };
};

describe('overflowKeys', () => {
  it('renders BLANK for an empty list — never a zero', () => {
    expect(overflowKeys([], 3)).toBe('');
  });

  it('renders up to and including the budget in full', () => {
    expect(EDGE_KEYS_BUDGET).toBe(3);
    expect(overflowKeys(['A'], 3)).toBe('A');
    expect(overflowKeys(['A', 'B', 'C'], 3)).toBe('A, B, C');
  });

  it('collapses everything past the budget to +n', () => {
    expect(overflowKeys(['A', 'B', 'C', 'D'], 3)).toBe('A, B, C +1');
    expect(overflowKeys(['A', 'B', 'C', 'D', 'E'], 2)).toBe('A, B +3');
  });
});

describe('edgeCell', () => {
  it('renders blank for no edges AND for a server that sent none at all', () => {
    expect(edgeCell([])).toBe('');
    expect(edgeCell(undefined)).toBe('');
  });

  it('renders one live edge as its bare key', () => {
    expect(edgeCell(edges({ blocks: ['PROD-8'] }).blocks)).toBe('PROD-8');
  });

  it('renders exactly the budget without an overflow marker, and past it with +n', () => {
    const five = ['PROD-1', 'PROD-2', 'PROD-3', 'PROD-4', 'PROD-5'];
    expect(edgeCell(edges({ blocks: five.slice(0, 3) }).blocks)).toBe('PROD-1, PROD-2, PROD-3');
    expect(edgeCell(edges({ blocks: five }).blocks)).toBe('PROD-1, PROD-2, PROD-3 +2');
  });

  it('marks a TERMINAL far end and sorts it after the live ones', () => {
    // The live edges are what the row is waiting on / holding up, so they lead;
    // a done one carries `✓` because it no longer gates.
    const mixed = edges({
      blockedBy: [['PROD-1', 'done'], 'PROD-2', ['PROD-3', 'cancelled'], 'PROD-4'],
    });
    expect(edgeCell(mixed.blockedBy, 9)).toBe('PROD-2, PROD-4, PROD-1✓, PROD-3✓');
  });

  it('counts a terminal far end against the budget like any other key', () => {
    const mixed = edges({ blockedBy: ['PROD-1', 'PROD-2', ['PROD-3', 'done'], 'PROD-4'] });
    expect(edgeCell(mixed.blockedBy)).toBe('PROD-1, PROD-2, PROD-4 +1');
  });

  it('makes an all-done row distinguishable from a genuinely blocked one', () => {
    const settled = edgeCell(edges({ blockedBy: [['PROD-1', 'done']] }).blockedBy);
    const live = edgeCell(edges({ blockedBy: ['PROD-1'] }).blockedBy);
    expect(settled).toBe('PROD-1✓');
    expect(live).toBe('PROD-1');
    expect(settled).not.toBe(live);
  });
});

describe('markLegend', () => {
  it('is null when the cells show no mark — a legend for an absent symbol is noise', () => {
    expect(markLegend([])).toBeNull();
    expect(markLegend(['PROD-1, PROD-2'])).toBeNull();
  });

  it('explains only the marks actually present, in a stable order', () => {
    expect(markLegend(['PROD-1✓'])).toBe('✓ = already done');
    expect(markLegend(['PROD-1↗'])).toBe('↗ = blocker outside this parent');
    expect(markLegend(['PROD-1↗', 'PROD-2✓'])).toBe(
      '✓ = already done · ↗ = blocker outside this parent',
    );
  });
});

describe('renderReadyTable — the BLOCKS column', () => {
  it('adds BLOCKS before TITLE and keeps every column aligned', () => {
    const out = renderReadyTable([
      readyItem({ key: 'PROD-7', title: 'Alpha', dependencies: edges({ blocks: ['PROD-8'] }) }),
      readyItem({
        key: 'PROD-90',
        title: 'Beta',
        priority: 'low',
        assignee: null,
        dependencies: edges({}),
      }),
    ]);
    const lines = out.split('\n');

    expect(lines[1]).toBe('KEY      KIND     PRIORITY  ASSIGNEE    BLOCKS  TITLE');
    // Alignment: the padded TITLE column starts at the same offset on the header
    // and on BOTH rows — including the one whose BLOCKS cell is empty.
    const titleAt = lines[1]!.indexOf('TITLE');
    expect(lines[3]!.indexOf('Alpha')).toBe(titleAt);
    expect(lines[4]!.indexOf('Beta')).toBe(titleAt);
    expect(lines[3]).toContain('PROD-8');
  });

  it('renders BLANK for a ready item that unblocks nothing — not a zero', () => {
    const out = renderReadyTable([readyItem({ title: 'Alpha', dependencies: edges({}) })]);
    expect(out).toContain('BLOCKS');
    expect(out).not.toMatch(/\b0\b/);
  });

  it('collapses a big fan-out to +n', () => {
    const out = renderReadyTable([
      readyItem({
        dependencies: edges({ blocks: ['PROD-1', 'PROD-2', 'PROD-3', 'PROD-4', 'PROD-5'] }),
      }),
    ]);
    expect(out).toContain('PROD-1, PROD-2, PROD-3 +2');
  });

  it('explains the ✓ mark only when a row actually shows one', () => {
    const withDone = renderReadyTable([
      readyItem({ dependencies: edges({ blocks: [['PROD-8', 'done']] }) }),
    ]);
    expect(withDone).toContain('PROD-8✓');
    expect(withDone).toContain('✓ = already done');
    // …and never the wave view's parent-scoped mark, which means nothing here.
    expect(withDone).not.toContain('outside this parent');

    const noMarks = renderReadyTable([readyItem({ dependencies: edges({ blocks: ['PROD-8'] }) })]);
    expect(noMarks).not.toContain('already done');
  });

  it('DEGRADES to the pre-7.9.16 columns against a server with no edge block', () => {
    // The whole page or nothing: the block comes from one batched read, so a
    // server that predates it sends none — and gets exactly its old table.
    const out = renderReadyTable([readyItem({ title: 'Alpha' })]);
    expect(out.split('\n')[1]).toBe('KEY     KIND     PRIORITY  ASSIGNEE  TITLE');
    expect(out).not.toContain('BLOCKS');
  });

  it('degrades when only SOME rows carry the block, rather than printing false blanks', () => {
    const out = renderReadyTable([
      readyItem({ key: 'PROD-7', dependencies: edges({ blocks: ['PROD-8'] }) }),
      readyItem({ key: 'PROD-9' }),
    ]);
    expect(out).not.toContain('BLOCKS');
  });
});

const sprint = (over: Partial<SprintSummary>): SprintSummary => ({
  id: 's1',
  name: 'Sprint 3',
  state: 'active',
  goal: 'Ship the CLI',
  startDate: '2026-06-10',
  endDate: '2026-06-24',
  sequence: 3,
  issueCount: 8,
  committedPoints: 21,
  committedIssueCount: 8,
  ...over,
});

describe('formatSprintWindow', () => {
  it('joins start → end, em-dashing open ends', () => {
    expect(formatSprintWindow(sprint({}))).toBe('2026-06-10 → 2026-06-24');
    expect(formatSprintWindow(sprint({ endDate: null }))).toBe('2026-06-10 → —');
    expect(formatSprintWindow(sprint({ startDate: null, endDate: null }))).toBe('');
  });
});

const pulse = (over: Partial<StatusPulse>): StatusPulse => ({
  projectKey: 'PROD',
  readyCount: 5,
  inFlightCount: 3,
  activeSprint: sprint({}),
  totalSprints: 4,
  ...over,
});

describe('renderStatusBlock', () => {
  it('shows ready / in-flight / active sprint with window + goal', () => {
    const out = renderStatusBlock(pulse({}));
    expect(out).toContain('Project:    PROD');
    expect(out).toContain('Ready:      5');
    expect(out).toContain('In flight:  3');
    expect(out).toContain('Sprint 3');
    expect(out).toContain('2026-06-10 → 2026-06-24');
    expect(out).toContain('goal: Ship the CLI');
  });
  it('degrades to "(no sprints)" when none exist', () => {
    expect(renderStatusBlock(pulse({ activeSprint: null, totalSprints: 0 }))).toContain(
      'Sprint:     (no sprints)',
    );
  });
  it('degrades to "(none active)" when sprints exist but none is active', () => {
    expect(renderStatusBlock(pulse({ activeSprint: null, totalSprints: 4 }))).toContain(
      'Sprint:     (none active)',
    );
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────
// The formatting edges a table hits with real data: a column narrower than its
// ellipsis, a ragged row, a right-aligned column, and every sprint-line shape.

describe('table + status formatting edges', () => {
  it('truncate degrades safely at widths too small for an ellipsis', () => {
    expect(truncate('abcdef', 1)).toBe('a');
    expect(truncate('abcdef', 0)).toBe('');
    expect(truncate('abcdef', -3)).toBe('');
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('formatTable pads a RAGGED row and right-aligns only the named columns', () => {
    const table = formatTable(['KEY', 'N'], [['PROD-1', '7'], ['PROD-22']], { rightAlign: [1] });
    const [header, underline, first, second] = table.split('\n');

    expect(header).toBe('KEY      N');
    expect(underline).toBe('───────  ─');
    expect(first).toBe('PROD-1   7');
    // The missing cell is padded away, not rendered as "undefined".
    expect(second).toBe('PROD-22');
  });

  it('formatSprintWindow renders an em-dash for each OPEN end, and nothing for none', () => {
    const sprint = {
      id: 's',
      name: 'S',
      state: 'active' as const,
      goal: null,
      startDate: null,
      endDate: null,
      sequence: 1,
      issueCount: 0,
      committedPoints: null,
      committedIssueCount: null,
    };
    expect(formatSprintWindow(sprint)).toBe('');
    expect(formatSprintWindow({ ...sprint, startDate: '2026-07-28' })).toBe('2026-07-28 → —');
    expect(formatSprintWindow({ ...sprint, endDate: '2026-07-31' })).toBe('— → 2026-07-31');
  });

  it('renderStatusBlock distinguishes NO sprints from none ACTIVE, and singularizes', () => {
    const base: StatusPulse = {
      projectKey: 'PROD',
      readyCount: 0,
      inFlightCount: 0,
      activeSprint: null,
      totalSprints: 0,
    };
    expect(renderStatusBlock(base)).toContain('(no sprints)');
    expect(renderStatusBlock({ ...base, totalSprints: 3 })).toContain('(none active)');

    const active = renderStatusBlock({
      ...base,
      totalSprints: 1,
      activeSprint: {
        id: 's2',
        name: 'Journey D',
        state: 'active',
        goal: 'Ship the CLI',
        startDate: '2026-07-28',
        endDate: null,
        sequence: 2,
        issueCount: 1,
        committedPoints: null,
        committedIssueCount: 1,
      },
    });
    expect(active).toContain('[active, 1 issue]');
    expect(active).toContain('2026-07-28 → —');
    expect(active).toContain('goal: Ship the CLI');
  });

  it('renderReadyTable names the empty set instead of drawing an empty table', () => {
    expect(renderReadyTable([])).toBe('No ready work items.');
    const one = renderReadyTable([
      { key: 'PROD-1', kind: 'subtask', title: 'x'.repeat(80), priority: 'high', assignee: null },
    ]);
    expect(one).toContain('1 ready work item:');
    expect(one).toContain('unassigned');
    expect(one).toContain('…');
  });
});

// ── `motir show` — the item DETAIL renderers (7.9.13 · MOTIR-1843) ──────────
//
// Every renderer here is pure (no MCP, no stdout), which is the whole point of
// keeping them in render.ts: the LAYOUT is asserted directly, on shapes a live
// tenant would take a fixture to produce — an item with every optional field
// null, one with none, an item with no children and no edges, a cascade-blocked
// item, and a title long enough to break the columns.

const summary = (over: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  identifier: 'PROD-9',
  kind: 'subtask',
  title: 'Wire the thing',
  status: 'todo',
  ...over,
});

/** An item with EVERY optional field populated. */
const fullDetail = (over: Partial<WorkItemDetail> = {}): WorkItemDetail => ({
  item: {
    id: 'row-7',
    identifier: 'PROD-7',
    kind: 'subtask',
    title: 'Read commands',
    status: 'in_progress',
    priority: 'high',
    assigneeId: 'user-1',
    type: 'code',
    executor: 'coding_agent',
    storyPoints: 3,
    estimateMinutes: 40,
    targetRepo: 'motir-core',
    sprintId: 'sprint-1',
    descriptionMd: '## Why\n\nThe CLI cannot show you a work item.\n',
  },
  ancestors: [summary({ identifier: 'PROD-1', kind: 'epic', title: 'Epic 7' })],
  parent: summary({ identifier: 'PROD-1', kind: 'epic', title: 'Epic 7' }),
  children: [summary({ identifier: 'PROD-8' }), summary({ identifier: 'PROD-9', status: 'done' })],
  blockedBy: [{ linkId: 'l1', item: summary({ identifier: 'PROD-2', status: 'in_review' }) }],
  blocks: [{ linkId: 'l2', item: summary({ identifier: 'PROD-3', status: 'blocked' }) }],
  relatesTo: [{ linkId: 'l3', item: summary({ identifier: 'PROD-4', status: 'done' }) }],
  readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  ...over,
});

/** The SAME item with every nullable field null and nothing related to it. */
const bareDetail = (over: Partial<WorkItemDetail> = {}): WorkItemDetail => ({
  item: {
    id: 'row-7',
    identifier: 'PROD-7',
    kind: 'bug',
    title: 'Read commands',
    status: 'todo',
    priority: 'low',
    assigneeId: null,
    type: null,
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    sprintId: null,
    descriptionMd: null,
  },
  ancestors: [],
  parent: null,
  children: [],
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  ...over,
});

describe('renderItemHeader', () => {
  it('renders the key, the kind/type pair, the title, and every field that is set', () => {
    const header = renderItemHeader(fullDetail().item);
    const [identity, fields] = header.split('\n');

    expect(identity).toBe('PROD-7  [subtask/code]  Read commands');
    expect(fields).toBe(
      'status in_progress · priority high · assignee user-1 · type code · ' +
        'executor coding_agent · points 3 · estimate 40m · sprint sprint-1 · repo motir-core',
    );
  });

  it('OMITS every null field rather than printing "null", and drops the type from the pair', () => {
    const header = renderItemHeader(bareDetail().item);

    expect(header).toBe('PROD-7  [bug]  Read commands\nstatus todo · priority low');
    expect(header).not.toMatch(/null|undefined/);
  });

  it('keeps a ZERO estimate — absent and zero are different facts', () => {
    const header = renderItemHeader({
      ...bareDetail().item,
      storyPoints: 0,
      estimateMinutes: 0,
    });

    expect(header).toContain('points 0');
    expect(header).toContain('estimate 0m');
  });
});

describe('renderReadinessLine', () => {
  it('reads "ready" when the server says ready', () => {
    expect(renderReadinessLine({ ready: true, openBlockers: [], blockedByAncestor: null })).toBe(
      'ready',
    );
  });

  it('NAMES the item’s own open blockers', () => {
    expect(
      renderReadinessLine({
        ready: false,
        openBlockers: [summary({ identifier: 'PROD-2' }), summary({ identifier: 'PROD-3' })],
        blockedByAncestor: null,
      }),
    ).toBe('blocked by PROD-2, PROD-3');
  });

  it('names the ANCESTOR in the cascade case — never a bare "blocked"', () => {
    expect(
      renderReadinessLine({
        ready: false,
        openBlockers: [],
        blockedByAncestor: summary({ identifier: 'PROD-1', title: 'Epic 7' }),
      }),
    ).toBe('blocked by ancestor PROD-1 — Epic 7');
  });

  it('falls back to a bare "blocked" only when there is genuinely nothing to name', () => {
    expect(renderReadinessLine({ ready: false, openBlockers: [], blockedByAncestor: null })).toBe(
      'blocked',
    );
  });
});

describe('renderLineage', () => {
  it('joins the ancestor chain root→self, ending at the item itself', () => {
    expect(renderLineage(fullDetail())).toBe('PROD-1 › PROD-7');
  });

  it('is the item alone when it has no ancestors', () => {
    expect(renderLineage(bareDetail())).toBe('PROD-7');
  });
});

describe('childRows / edgeRows / renderRelationTable', () => {
  it('childRow builds cells in CHILD_HEADERS order, truncating a long title', () => {
    expect(childRow(summary({ title: 'x'.repeat(80) }), 10)).toEqual([
      'PROD-9',
      'subtask',
      'todo',
      'xxxxxxxxx…',
    ]);
    expect(CHILD_HEADERS).toEqual(['KEY', 'KIND', 'STATUS', 'TITLE']);
  });

  it('childRows PRESERVES the order it is given — the caller decides it, not the renderer', () => {
    const children = [summary({ identifier: 'PROD-9' }), summary({ identifier: 'PROD-8' })];

    // Source order in, source order out; a later card sorts these into build
    // waves and passes them here already ordered.
    expect(childRows(children).map((row) => row[0])).toEqual(['PROD-9', 'PROD-8']);
    expect(childRows([...children].reverse()).map((row) => row[0])).toEqual(['PROD-8', 'PROD-9']);
  });

  it('edgeRows builds key · status · title cells from the link’s item', () => {
    expect(edgeRows([{ linkId: 'l1', item: summary({ status: 'done' }) }])).toEqual([
      ['PROD-9', 'done', 'Wire the thing'],
    ]);
    expect(EDGE_HEADERS).toEqual(['KEY', 'STATUS', 'TITLE']);
  });

  it('counts the rows in the heading and draws the table under it', () => {
    const block = renderRelationTable(
      'BLOCKS',
      edgeRows([{ linkId: 'l', item: summary({}) }]),
      'none',
    );
    const lines = block.split('\n');

    expect(lines[0]).toBe('BLOCKS (1)');
    expect(lines[1]).toBe('KEY     STATUS  TITLE');
    expect(lines[3]).toBe('PROD-9  todo    Wire the thing');
  });

  it('prints the empty line — not an empty table — for a group with no members', () => {
    expect(renderRelationTable('BLOCKS', [], 'none')).toBe('BLOCKS (0)\nnone');
    expect(renderRelationTable('CHILDREN', [], 'no children', CHILD_HEADERS)).toBe(
      'CHILDREN (0)\nno children',
    );
  });

  it('accepts a WIDER column set without a rewrite (what 7.9.16 needs)', () => {
    const rows = childRows([summary({})]).map((row) => ['1', ...row]);
    const block = renderRelationTable('CHILDREN', rows, 'no children', ['WAVE', ...CHILD_HEADERS]);

    expect(block.split('\n')[1]).toBe('WAVE  KEY     KIND     STATUS  TITLE');
    expect(block).toContain('1     PROD-9  subtask  todo    Wire the thing');
  });
});

// ── build-order WAVES (7.9.16b · MOTIR-1848) ────────────────────────────────
//
// The wave assignment is a PURE function over the children's `blocked_by`
// sub-graph, so every shape a real plan can take is asserted directly: a flat
// set, a chain, a fan-out, a fan-in, a node whose blockers sit in two different
// waves, blockers already done, a blocker OUTSIDE the parent, and a cycle.

const kid = (n: number, over: Partial<WorkItemChild> = {}): WorkItemChild => ({
  identifier: `PROD-${n}`,
  kind: 'subtask',
  title: `Child ${n}`,
  status: 'todo',
  dependencies: { blockedBy: [], blocks: [] },
  ...over,
});

/** `blocked_by` edges to the named siblings, `todo` unless a status is given. */
const gatedBy = (...specs: (number | [number, string])[]): WorkItemChild['dependencies'] => ({
  blockedBy: specs.map((spec) => {
    const [n, status] = Array.isArray(spec) ? spec : [spec, 'todo'];
    return { key: `PROD-${n}`, title: `Child ${n}`, status };
  }),
  blocks: [],
});

const wavesOf = (children: WorkItemChild[]) =>
  assignChildWaves(children).map((w) => [w.child.identifier, w.wave] as const);

describe('assignChildWaves', () => {
  it('puts a FLAT set — no edges at all — entirely in wave 1', () => {
    expect(wavesOf([kid(1), kid(2), kid(3)])).toEqual([
      ['PROD-1', 1],
      ['PROD-2', 1],
      ['PROD-3', 1],
    ]);
  });

  it('layers a CHAIN one wave per link', () => {
    expect(
      wavesOf([kid(1), kid(2, { dependencies: gatedBy(1) }), kid(3, { dependencies: gatedBy(2) })]),
    ).toEqual([
      ['PROD-1', 1],
      ['PROD-2', 2],
      ['PROD-3', 3],
    ]);
  });

  it('puts a FAN-OUT’s dependents all in wave 2 — they are parallel work', () => {
    expect(
      wavesOf([kid(1), kid(2, { dependencies: gatedBy(1) }), kid(3, { dependencies: gatedBy(1) })]),
    ).toEqual([
      ['PROD-1', 1],
      ['PROD-2', 2],
      ['PROD-3', 2],
    ]);
  });

  it('puts a FAN-IN behind all of its blockers', () => {
    expect(wavesOf([kid(1), kid(2), kid(3), kid(4, { dependencies: gatedBy(1, 2, 3) })])).toEqual([
      ['PROD-1', 1],
      ['PROD-2', 1],
      ['PROD-3', 1],
      ['PROD-4', 2],
    ]);
  });

  it('places a node behind its DEEPEST blocker when they sit in different waves', () => {
    // 4 is blocked by 1 (wave 1) AND 3 (wave 2) — so it is wave 3, not wave 2.
    const children = [
      kid(1),
      kid(2),
      kid(3, { dependencies: gatedBy(2) }),
      kid(4, { dependencies: gatedBy(1, 3) }),
    ];
    expect(wavesOf(children)).toEqual([
      ['PROD-1', 1],
      ['PROD-2', 1],
      ['PROD-3', 2],
      ['PROD-4', 3],
    ]);
  });

  it('does NOT count a satisfied blocker — a done gate is no gate', () => {
    const [entry] = assignChildWaves([kid(2, { dependencies: gatedBy([1, 'done']) })]);
    expect(entry?.wave).toBe(1);
    expect(entry?.satisfiedBlockers).toEqual(['PROD-1']);
    expect(entry?.siblingBlockers).toEqual([]);
    // `cancelled` is terminal too (category `done` in the default workflow).
    expect(assignChildWaves([kid(2, { dependencies: gatedBy([1, 'cancelled']) })])[0]?.wave).toBe(
      1,
    );
  });

  it('treats a blocker OUTSIDE this parent as external — named, never a layer', () => {
    // PROD-99 is not a sibling, so nothing in this table can clear it. It must
    // not push PROD-2 into wave 2 and drag every dependent down with it.
    const children = [kid(2, { dependencies: gatedBy(99) }), kid(3, { dependencies: gatedBy(2) })];
    const [second, third] = assignChildWaves(children);

    expect(second?.wave).toBe(1);
    expect(second?.externalBlockers).toEqual(['PROD-99']);
    expect(second?.siblingBlockers).toEqual([]);
    expect(third?.wave).toBe(2);
  });

  it('gives CYCLE members no wave, groups them last, and names them', () => {
    const children = [
      kid(1),
      kid(2, { dependencies: gatedBy(3) }),
      kid(3, { dependencies: gatedBy(2) }),
    ];
    const waves = assignChildWaves(children);

    expect(waves.map((w) => [w.child.identifier, w.wave])).toEqual([
      ['PROD-1', 1],
      ['PROD-2', null],
      ['PROD-3', null],
    ]);
    expect(cycleMembers(waves)).toEqual(['PROD-2', 'PROD-3']);
    // A node hanging OFF the cycle can never be placed either.
    expect(
      cycleMembers(assignChildWaves([...children, kid(4, { dependencies: gatedBy(2) })])),
    ).toEqual(['PROD-2', 'PROD-3', 'PROD-4']);
  });

  it('is STABLE — within a wave the server’s order survives, so runs match', () => {
    const children = [kid(9), kid(8), kid(7, { dependencies: gatedBy(9) }), kid(6)];
    expect(wavesOf(children)).toEqual([
      ['PROD-9', 1],
      ['PROD-8', 1],
      ['PROD-6', 1],
      ['PROD-7', 2],
    ]);
  });

  it('treats a child with NO dependencies field as edge-free rather than crashing', () => {
    const bare: WorkItemChild = {
      identifier: 'PROD-1',
      kind: 'subtask',
      title: 'x',
      status: 'todo',
    };
    expect(assignChildWaves([bare])[0]?.wave).toBe(1);
  });

  it('classifies terminal statuses off the default workflow’s done category', () => {
    expect([...TERMINAL_STATUS_KEYS]).toEqual(['done', 'cancelled']);
    expect(isSatisfiedBlocker('done')).toBe(true);
    expect(isSatisfiedBlocker('cancelled')).toBe(true);
    expect(isSatisfiedBlocker('in_review')).toBe(false);
    expect(isSatisfiedBlocker('blocked')).toBe(false);
  });
});

describe('blockedByCell', () => {
  const cellFor = (deps: WorkItemChild['dependencies'], budget?: number) =>
    blockedByCell(
      assignChildWaves([kid(1), kid(2), kid(3), kid(4, { dependencies: deps })])[3]!,
      budget,
    );

  it('renders BLANK for no edges — not a zero', () => {
    expect(cellFor(gatedBy())).toBe('');
  });

  it('renders a single blocker as its bare key', () => {
    expect(cellFor(gatedBy(1))).toBe('PROD-1');
  });

  it('renders exactly the budget without an overflow marker', () => {
    expect(EDGE_KEYS_BUDGET).toBe(3);
    expect(cellFor(gatedBy(1, 2, 3))).toBe('PROD-1, PROD-2, PROD-3');
  });

  it('collapses everything past the budget to +n', () => {
    const many = {
      blockedBy: [1, 2, 3, 4, 5].map((n) => ({ key: `PROD-${n}`, title: 'x', status: 'todo' })),
      blocks: [],
    };
    expect(blockedByCell(assignChildWaves([kid(9, { dependencies: many })])[0]!)).toBe(
      'PROD-1↗, PROD-2↗, PROD-3↗ +2',
    );
    expect(cellFor(gatedBy(1, 2, 3), 2)).toBe('PROD-1, PROD-2 +1');
  });

  it('marks a DONE blocker and an EXTERNAL one, un-done siblings first', () => {
    // The wait is about the un-done siblings, so they lead; the marks make the
    // other two kinds distinguishable at a glance.
    expect(cellFor(gatedBy([1, 'done'], 99, 2), 9)).toBe('PROD-2, PROD-99↗, PROD-1✓');
  });
});

describe('renderChildrenSection', () => {
  const chain = [
    kid(1),
    kid(2, { dependencies: gatedBy(1) }),
    kid(3, { dependencies: gatedBy(2) }),
  ];

  it('draws the WAVE table, ordered by wave and labelled as build order', () => {
    const block = renderChildrenSection(chain);
    const lines = block.split('\n');

    expect(lines[0]).toBe('CHILDREN (3) — build order');
    expect(lines[1]).toBe('WAVE  KEY     KIND     STATUS  BLOCKED BY  TITLE');
    expect(WAVE_CHILD_HEADERS).toEqual(['WAVE', 'KEY', 'KIND', 'STATUS', 'BLOCKED BY', 'TITLE']);
    expect(lines[3]).toBe('1     PROD-1  subtask  todo                Child 1');
    expect(lines[4]).toBe('2     PROD-2  subtask  todo    PROD-1      Child 2');
    expect(lines[5]).toBe('3     PROD-3  subtask  todo    PROD-2      Child 3');
  });

  it('reads as today’s plain list when the story has no internal edges', () => {
    // All wave 1, every BLOCKED BY blank — the truth about a fully parallel set.
    const block = renderChildrenSection([kid(1), kid(2)]);
    expect(block.split('\n').slice(3)).toEqual([
      '1     PROD-1  subtask  todo                Child 1',
      '1     PROD-2  subtask  todo                Child 2',
    ]);
    expect(block).not.toContain('✓');
    expect(block).not.toContain('CYCLE');
  });

  it('explains only the marks a row actually SHOWS', () => {
    // No marks at all → no legend.
    expect(renderChildrenSection(chain)).not.toContain('already done');

    // One mark → one line, not both halves of a fixed legend.
    const doneOnly = renderChildrenSection([kid(2, { dependencies: gatedBy([1, 'done']) })]);
    expect(doneOnly).toContain('✓ = already done');
    expect(doneOnly).not.toContain('outside this parent');

    const externalOnly = renderChildrenSection([kid(2, { dependencies: gatedBy(99) })]);
    expect(externalOnly).toContain('↗ = blocker outside this parent');
    expect(externalOnly).not.toContain('already done');

    expect(renderChildrenSection([kid(2, { dependencies: gatedBy([1, 'done'], 99) })])).toContain(
      '✓ = already done · ↗ = blocker outside this parent',
    );
  });

  it('does NOT explain a mark the +n budget cut from every row', () => {
    // The done blocker is real, but it fell off the end of the cell — a legend
    // for a symbol that is not on the screen is a promise the table did not keep.
    const budgeted = renderChildrenSection([
      kid(1),
      kid(2),
      kid(3),
      kid(5, { dependencies: gatedBy(1, 2, 3, [4, 'done']) }),
    ]);
    expect(budgeted).toContain('+1');
    expect(budgeted).not.toContain('already done');
  });

  it('SURFACES a cycle under an explicit marker naming its members', () => {
    const block = renderChildrenSection([
      kid(1),
      kid(2, { dependencies: gatedBy(3) }),
      kid(3, { dependencies: gatedBy(2) }),
    ]);

    // The unplaceable rows sit last, with an em-dash where the wave would be…
    const rows = block.split('\n').slice(3, 6);
    expect(rows[0]).toContain('1     PROD-1');
    expect(rows[1]).toContain('—     PROD-2');
    expect(rows[2]).toContain('—     PROD-3');
    // …and the reason is stated, not left to be inferred from the dashes.
    expect(block).toContain('⚠ dependency CYCLE — PROD-2, PROD-3 block each other');
  });

  it('DEGRADES to the 7.9.13 table when the server sends no per-child edges', () => {
    const legacy: WorkItemChild[] = [
      { identifier: 'PROD-1', kind: 'subtask', title: 'Child 1', status: 'todo' },
      { identifier: 'PROD-2', kind: 'subtask', title: 'Child 2', status: 'done' },
    ];
    const block = renderChildrenSection(legacy);

    expect(block.split('\n')[0]).toBe('CHILDREN (2)');
    expect(block.split('\n')[1]).toBe('KEY     KIND     STATUS  TITLE');
    expect(block).not.toContain('WAVE');
  });

  it('keeps the empty section exactly as it was', () => {
    expect(renderChildrenSection([])).toBe('CHILDREN (0)\nno children');
  });

  it('holds formatTable alignment with a truncated title AND an overflowing cell', () => {
    const many = {
      blockedBy: [1, 2, 3, 4, 5].map((n) => ({ key: `PROD-${n}`, title: 'x', status: 'todo' })),
      blocks: [],
    };
    const block = renderChildrenSection(
      [kid(1), kid(9, { dependencies: many, title: 'z'.repeat(90) })],
      20,
    );
    const [header, underline, ...rows] = block.split('\n').slice(1);

    expect(rows[1]).toContain('+2');
    expect(rows[1]).toContain('…');
    // The truncated title fills the TITLE column exactly, so that row fills the
    // underline — the overflowing BLOCKED BY cell cost it nothing.
    expect(rows[1]).toHaveLength(underline?.length ?? 0);
    // …and BOTH rows start their title at the header's TITLE offset: the wide
    // cell widened the column for every row, it did not shove one of them over.
    expect(rows[0]?.indexOf('Child 1')).toBe(header?.indexOf('TITLE'));
    expect(rows[1]?.indexOf('z')).toBe(header?.indexOf('TITLE'));
  });
});

describe('detailWithWaves', () => {
  const detailWith = (children: WorkItemChild[]) => bareDetail({ children });

  it('re-orders the children into build order and stamps each with its wave', () => {
    const out = detailWithWaves(
      detailWith([
        kid(3, { dependencies: gatedBy(1) }),
        kid(1),
        kid(2, { dependencies: gatedBy(3) }),
      ]),
    );
    expect(out.children.map((c) => [c.identifier, (c as { wave?: number }).wave])).toEqual([
      ['PROD-1', 1],
      ['PROD-3', 2],
      ['PROD-2', 3],
    ]);
  });

  it('carries the FULL untruncated dependency block — the +n budget is display-only', () => {
    const many = {
      blockedBy: [1, 2, 3, 4, 5].map((n) => ({
        key: `PROD-${n}`,
        title: `Child ${n}`,
        status: 'todo',
      })),
      blocks: [],
    };
    const [child] = detailWithWaves(detailWith([kid(9, { dependencies: many })])).children;
    expect(child?.dependencies?.blockedBy).toHaveLength(5);
  });

  it('stamps a cycle member with wave null rather than dropping it', () => {
    const out = detailWithWaves(
      detailWith([kid(2, { dependencies: gatedBy(3) }), kid(3, { dependencies: gatedBy(2) })]),
    );
    expect(out.children.map((c) => (c as { wave?: number | null }).wave)).toEqual([null, null]);
  });

  it('passes the aggregate through UNCHANGED when the server sends no edges', () => {
    const legacy = detailWith([
      { identifier: 'PROD-1', kind: 'subtask', title: 'Child 1', status: 'todo' },
    ]);
    expect(detailWithWaves(legacy)).toBe(legacy);
    expect(detailWithWaves(bareDetail())).toEqual(bareDetail());
  });
});

describe('waveChildRows', () => {
  it('reuses childRow, so the four shared columns cannot drift from CHILD_HEADERS', () => {
    const entry = assignChildWaves([kid(1), kid(2, { dependencies: gatedBy(1) })])[1]!;
    const shared = childRow(entry.child, 60);

    expect(waveChildRows([entry], 60)).toEqual([['2', ...shared.slice(0, 3), 'PROD-1', shared[3]]]);
  });
});

describe('renderWorkItemDetail', () => {
  it('assembles header → readiness → lineage → children → the three edge groups → body', () => {
    const block = renderWorkItemDetail(fullDetail());

    expect(block.split('\n')[0]).toBe('PROD-7  [subtask/code]  Read commands');
    // Section order is the read order: what it is, whether it can be worked,
    // where it sits, what hangs off it, what it depends on, then the body.
    const order = [
      'READINESS',
      'LINEAGE',
      'CHILDREN (2)',
      'BLOCKED BY (1)',
      'BLOCKS (1)',
      'RELATES TO (1)',
      'DESCRIPTION',
    ];
    let cursor = -1;
    for (const heading of order) {
      const at = block.indexOf(heading);
      expect(at, `${heading} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(block).toContain('PROD-8');
    expect(block).toContain('PROD-2');
  });

  it('prints the body as RAW Markdown, verbatim — the terminal is not a viewer', () => {
    const block = renderWorkItemDetail(fullDetail());

    expect(block).toContain('## Why\n\nThe CLI cannot show you a work item.');
    expect(block.endsWith('The CLI cannot show you a work item.')).toBe(true);
  });

  it('drops the DESCRIPTION section entirely when the body is null', () => {
    const block = renderWorkItemDetail(bareDetail());

    expect(block).not.toContain('DESCRIPTION');
    expect(block).toContain('CHILDREN (0)\nno children');
    expect(block).toContain('BLOCKED BY (0)\nnone');
    expect(block).not.toMatch(/null|undefined/);
  });

  it('truncates a long child title so the columns stay aligned', () => {
    const block = renderWorkItemDetail(
      fullDetail({ children: [summary({ title: 'y'.repeat(120) })] }),
      20,
    );
    const [header, underline, row] = block.slice(block.indexOf('CHILDREN')).split('\n').slice(1, 4);

    expect(row).toContain('…');
    // The title is cut to the width, so the TITLE column starts at the same
    // offset in the header and the row, and the row fills the underline exactly.
    expect(row?.indexOf('y')).toBe(header?.indexOf('TITLE'));
    expect(row).toHaveLength(underline?.length ?? 0);
  });

  it('renders the blocked verdict for an item the server says is not ready', () => {
    const block = renderWorkItemDetail(
      bareDetail({
        readiness: {
          ready: false,
          openBlockers: [summary({ identifier: 'PROD-2' })],
          blockedByAncestor: null,
        },
      }),
    );

    expect(block).toContain('READINESS\nblocked by PROD-2');
  });
});

// ── the sprint reads (7.9.14 · MOTIR-1844) ──────────────────────────────────

describe('sprintFilter', () => {
  it('is a v1 envelope selecting ONE sprint by id', () => {
    expect(sprintFilter('s1')).toEqual({
      version: FILTER_VERSION,
      combinator: 'and',
      conditions: [{ field: 'sprint', operator: 'is_any_of', value: ['s1'] }],
    });
  });
  it('ANDs a kind condition when kinds are given, and ignores an empty list', () => {
    expect(sprintFilter('s1', ['subtask', 'bug']).conditions).toEqual([
      { field: 'sprint', operator: 'is_any_of', value: ['s1'] },
      { field: 'kind', operator: 'is_any_of', value: ['subtask', 'bug'] },
    ]);
    expect(sprintFilter('s1', []).conditions).toHaveLength(1);
  });
});

describe('renderSprintsTable', () => {
  it('names the empty case instead of drawing an empty table', () => {
    expect(renderSprintsTable([])).toBe('No sprints.');
  });

  it('orders by SEQUENCE (not wire order) and marks the active row with *', () => {
    const out = renderSprintsTable([
      sprint({ id: 's3', name: 'Sprint 3', state: 'planned', sequence: 3 }),
      sprint({ id: 's1', name: 'Sprint 1', state: 'complete', sequence: 1 }),
      sprint({ id: 's2', name: 'Journey D', state: 'active', sequence: 2 }),
    ]);
    const rows = out.split('\n').slice(3); // count line, header, underline

    expect(out).toContain('3 sprints:');
    expect(rows[0]).toContain('Sprint 1');
    expect(rows[1]).toContain('Journey D');
    expect(rows[2]).toContain('Sprint 3');
    // Exactly one marked row — the active one.
    expect(rows.filter((r) => r.startsWith('*'))).toEqual([rows[1]]);
  });

  it('renders an unstarted sprint’s points and open window as em-dashes', () => {
    const out = renderSprintsTable([
      sprint({
        state: 'planned',
        committedPoints: null,
        startDate: null,
        endDate: null,
        issueCount: 0,
      }),
    ]);
    expect(out).toContain('1 sprint:');
    expect(out.split('\n')[3]).toMatch(/planned\s+Sprint 3\s+0\s+—\s+—/);
  });

  it('truncates a long name without breaking the columns', () => {
    const out = renderSprintsTable([sprint({ name: 'S'.repeat(80) })], 20);
    const [, , underline, row] = out.split('\n');

    expect(row).toContain('…');
    // The NAME column is capped at the truncation width, so ITEMS / POINTS /
    // WINDOW stay where the header puts them instead of being shoved off-screen.
    expect(underline?.split('  ')[2]).toHaveLength(20);
  });
});

describe('renderSprintHeader', () => {
  it('carries name, state, window, goal and the activation baseline', () => {
    const out = renderSprintHeader(sprint({ name: 'Journey D' }));
    expect(out.split('\n')).toEqual([
      'Journey D  [active]',
      '2026-06-10 → 2026-06-24',
      'goal: Ship the CLI',
      'committed: 8 issues · 21 points',
    ]);
  });

  it('omits an absent goal, an open window, and an unstarted sprint’s baseline', () => {
    const out = renderSprintHeader(
      sprint({
        name: 'Sprint 9',
        state: 'planned',
        goal: null,
        startDate: null,
        endDate: null,
        committedPoints: null,
        committedIssueCount: null,
      }),
    );
    expect(out).toBe('Sprint 9  [planned]');
  });

  it('em-dashes a started-but-unestimated sprint’s points rather than dropping the line', () => {
    const out = renderSprintHeader(sprint({ committedPoints: null, committedIssueCount: 8 }));
    expect(out).toContain('committed: 8 issues · — points');
  });
});

const searchItem = (over: Partial<SearchItemSummary>): SearchItemSummary => ({
  identifier: 'PROD-7',
  kind: 'subtask',
  title: 'Read commands',
  status: 'in_progress',
  priority: 'high',
  ...over,
});

describe('renderSprintItems', () => {
  it('names an empty sprint instead of drawing an empty table', () => {
    expect(renderSprintItems([], 0)).toBe('No work items in this sprint.');
  });

  it('renders key / kind / status / priority / title with a count that matches the total', () => {
    const out = renderSprintItems([searchItem({}), searchItem({ identifier: 'PROD-9' })], 2);
    expect(out).toContain('2 work items:');
    expect(out.split('\n')[1]).toBe('KEY     KIND     STATUS       PRIORITY  TITLE');
    expect(out).toContain('PROD-9');
  });

  it('singularizes a one-item sprint', () => {
    expect(renderSprintItems([searchItem({})], 1)).toContain('1 work item:');
  });

  it('SAYS SO when fewer rows were collected than the server counted', () => {
    // The silent-truncation failure, made visible: a short table can never read
    // as a complete one.
    const out = renderSprintItems([searchItem({})], 120);
    expect(out).toContain('1 of 120 work items (the rest could not be collected):');
  });

  it('truncates a long title without breaking the alignment', () => {
    const out = renderSprintItems([searchItem({ title: 'x'.repeat(200) })], 1, 30);
    const [, header, , row] = out.split('\n');
    expect(row).toContain('…');
    expect(row?.indexOf('x')).toBe(header?.indexOf('TITLE'));
  });
});

describe('renderSprintItems — the BLOCKED BY + BLOCKS columns (7.9.16 · MOTIR-1845)', () => {
  it('adds BOTH directions before TITLE, blockers first, aligned', () => {
    const out = renderSprintItems(
      [
        searchItem({
          identifier: 'PROD-7',
          title: 'Alpha',
          status: 'blocked',
          dependencies: edges({ blockedBy: ['PROD-2'], blocks: ['PROD-9'] }),
        }),
        searchItem({ identifier: 'PROD-8', title: 'Beta', dependencies: edges({}) }),
      ],
      2,
    );
    const lines = out.split('\n');

    expect(lines[1]).toBe('KEY     KIND     STATUS       PRIORITY  BLOCKED BY  BLOCKS  TITLE');
    const titleAt = lines[1]!.indexOf('TITLE');
    expect(lines[3]!.indexOf('Alpha')).toBe(titleAt);
    expect(lines[4]!.indexOf('Beta')).toBe(titleAt);
    expect(lines[3]).toContain('PROD-2');
    expect(lines[3]).toContain('PROD-9');
  });

  it('does NOT read as blocked when every blocker is already done', () => {
    // The load-bearing case for a mixed-status sprint: a row whose blockers are
    // all terminal is not waiting on anything, and the ✓ says so.
    const out = renderSprintItems(
      [
        searchItem({
          identifier: 'PROD-7',
          dependencies: edges({
            blockedBy: [
              ['PROD-2', 'done'],
              ['PROD-3', 'cancelled'],
            ],
          }),
        }),
      ],
      1,
    );
    expect(out).toContain('PROD-2✓, PROD-3✓');
    expect(out).toContain('✓ = already done');
  });

  it('NAMES the not-done blockers of a row that IS gated', () => {
    const out = renderSprintItems(
      [
        searchItem({
          identifier: 'PROD-7',
          status: 'blocked',
          dependencies: edges({ blockedBy: [['PROD-2', 'done'], 'PROD-3'] }),
        }),
      ],
      1,
    );
    // The live blocker leads; the satisfied one is visible but marked.
    expect(out).toContain('PROD-3, PROD-2✓');
  });

  it('collapses a big fan-in to +n and keeps the count line intact', () => {
    const out = renderSprintItems(
      [
        searchItem({
          dependencies: edges({ blockedBy: ['PROD-1', 'PROD-2', 'PROD-3', 'PROD-4'] }),
        }),
      ],
      1,
    );
    expect(out).toContain('1 work item:');
    expect(out).toContain('PROD-1, PROD-2, PROD-3 +1');
  });

  it('renders blank cells for an edge-free row, and DEGRADES with no edge block', () => {
    const edgeFree = renderSprintItems([searchItem({ dependencies: edges({}) })], 1);
    expect(edgeFree).toContain('BLOCKED BY');
    expect(edgeFree).not.toMatch(/\b0\b/);

    const older = renderSprintItems([searchItem({})], 1);
    expect(older.split('\n')[1]).toBe('KEY     KIND     STATUS       PRIORITY  TITLE');
    expect(older).not.toContain('BLOCKED BY');
  });
});

describe('resolveSprintRef', () => {
  const sprints = [
    sprint({ id: 's1', name: 'Sprint 1', state: 'complete', sequence: 1 }),
    sprint({ id: 's2', name: 'Journey D', state: 'active', sequence: 2 }),
    sprint({ id: 's10', name: 'Sprint 10', state: 'planned', sequence: 3 }),
  ];

  it('defaults to the ACTIVE sprint when no ref is given', () => {
    expect(resolveSprintRef(sprints).id).toBe('s2');
    expect(resolveSprintRef(sprints, '   ').id).toBe('s2');
  });

  it('errors with a hint when nothing is active and no ref is given', () => {
    const planned = sprints.map((s) => ({ ...s, state: 'planned' as const }));
    expect(() => resolveSprintRef(planned)).toThrow(CliError);
    try {
      resolveSprintRef(planned);
    } catch (err) {
      expect((err as CliError).message).toContain('No sprint is active');
      expect((err as CliError).hint).toContain('motir sprints');
    }
    expect(() => resolveSprintRef([])).toThrow(/No sprint is active/);
  });

  it('resolves an id, then an exact name case-insensitively', () => {
    expect(resolveSprintRef(sprints, 's10').name).toBe('Sprint 10');
    expect(resolveSprintRef(sprints, 'journey d').id).toBe('s2');
    expect(resolveSprintRef(sprints, '  JOURNEY D  ').id).toBe('s2');
  });

  it('resolves an unambiguous name PREFIX', () => {
    expect(resolveSprintRef(sprints, 'jour').id).toBe('s2');
    expect(resolveSprintRef(sprints, 'Sprint 10').id).toBe('s10');
  });

  it('prefers an EXACT name over a prefix, so "Sprint 1" is not ambiguous with "Sprint 10"', () => {
    expect(resolveSprintRef(sprints, 'Sprint 1').id).toBe('s1');
  });

  it('never silently picks: an ambiguous prefix errors WITH the candidates', () => {
    expect(() => resolveSprintRef(sprints, 'Sprint')).toThrow(CliError);
    try {
      resolveSprintRef(sprints, 'Sprint');
    } catch (err) {
      expect((err as CliError).message).toContain('matches 2 sprints');
      expect((err as CliError).hint).toContain('Sprint 1, Sprint 10');
    }
  });

  it('errors with a hint on an unknown ref', () => {
    expect(() => resolveSprintRef(sprints, 'nope')).toThrow(/No sprint matches "nope"/);
    try {
      resolveSprintRef(sprints, 'nope');
    } catch (err) {
      expect((err as CliError).hint).toContain('motir sprints');
    }
  });
});

describe('the output streams', () => {
  it('outVerbatim terminates with EXACTLY one newline either way', async () => {
    const { outVerbatim, out, info, json } = await import('../src/output.js');
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));

    outVerbatim('a prompt that ends in a newline\n');
    outVerbatim('a prompt that does not');
    out('payload');
    out();
    info('diagnostic');
    json({ ok: true });

    expect(written[0]).toBe('a prompt that ends in a newline\n');
    expect(written[1]).toBe('a prompt that does not\n');
    expect(written[2]).toBe('payload\n');
    expect(written[3]).toBe('\n');
    expect(written[4]).toBe('diagnostic\n');
    expect(written[5]).toBe('{\n  "ok": true\n}\n');
    spy.mockRestore();
    errSpy.mockRestore();
  });
});
