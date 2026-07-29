import { describe, expect, it, vi } from 'vitest';
import {
  FILTER_VERSION,
  IN_FLIGHT_STATUS_KEYS,
  formatSprintWindow,
  formatTable,
  inFlightFilter,
  issueUrl,
  renderReadyTable,
  renderStatusBlock,
  truncate,
  type StatusPulse,
} from '../src/render.js';
import type { ReadyItemSummary, SprintSummary } from '../src/mcpClient.js';

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

const sprint = (over: Partial<SprintSummary>): SprintSummary => ({
  id: 's1',
  name: 'Sprint 3',
  state: 'active',
  goal: 'Ship the CLI',
  startDate: '2026-06-10',
  endDate: '2026-06-24',
  issueCount: 8,
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
      issueCount: 0,
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
        issueCount: 1,
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
