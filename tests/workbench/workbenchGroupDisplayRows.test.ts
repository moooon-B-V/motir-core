import { describe, expect, it } from 'vitest';
import {
  initiallyExpandedGroups,
  workbenchGroupDisplayRows,
  type WorkbenchRowView,
} from '@/app/(authed)/workbench/_components/workbenchRows';

// The grouped work tabs' flattening (Story MOTIR-8012 · MOTIR-8016;
// `design/workbench/design-notes.md` § 36.3 and § 36.5), pure.

function row(identifier: string, over: Partial<WorkbenchRowView> = {}): WorkbenchRowView {
  return {
    id: `wi_${identifier}`,
    identifier,
    title: identifier,
    kind: 'subtask',
    role: 'assigned',
    assigneeName: null,
    agent: false,
    status: 'in_progress',
    statusLabel: 'In Progress',
    statusCategory: 'in_progress',
    ciState: null,
    completedAt: null,
    fix: null,
    canContinueHosted: false,
    canFixHosted: false,
    repairRun: null,
    fixGroupKind: null,
    members: [],
    resume: null,
    groupHead: null,
    groupMembers: [],
    ...over,
  };
}

const lines = (out: ReturnType<typeof workbenchGroupDisplayRows>) =>
  out.map((line) =>
    line.type === 'group'
      ? `group ${line.head.identifier} ${line.open ? 'open' : 'shut'}`
      : `${line.child ? '  ' : ''}${line.row.identifier}`,
  );

const S = row('S', {
  kind: 'story',
  groupHead: 'context',
  groupMembers: [row('S-3'), row('S-1'), row('S-2')],
});
const T = row('T', { kind: 'story', groupHead: 'member', groupMembers: [row('T-1')] });
const LOOSE = row('L', { kind: 'task' });

describe('workbenchGroupDisplayRows', () => {
  it('draws a shut group as its head alone, and a standalone row as itself', () => {
    expect(lines(workbenchGroupDisplayRows([S, LOOSE, T], new Set()))).toEqual([
      'group S shut',
      'L',
      'group T shut',
    ]);
  });

  it('draws an open group’s members under it, one level in, in the order SENT', () => {
    // S-3 before S-1: the service ranked them; the page never re-sorts.
    expect(lines(workbenchGroupDisplayRows([S, LOOSE, T], new Set([S.id, T.id])))).toEqual([
      'group S open',
      '  S-3',
      '  S-1',
      '  S-2',
      'L',
      'group T open',
      '  T-1',
    ]);
  });

  it('draws a member head once, as the group row, never again as a member', () => {
    const out = workbenchGroupDisplayRows([T], new Set([T.id]));
    expect(out.filter((l) => (l.type === 'group' ? l.head : l.row).id === T.id)).toHaveLength(1);
  });
});

describe('initiallyExpandedGroups', () => {
  it('opens the one group on a page that holds exactly one', () => {
    expect([...initiallyExpandedGroups([S])]).toEqual([S.id]);
    expect([...initiallyExpandedGroups([LOOSE, T, row('M', { kind: 'task' })])]).toEqual([T.id]);
  });

  it('opens nothing when a page holds two groups, or none', () => {
    expect(initiallyExpandedGroups([S, T]).size).toBe(0);
    expect(initiallyExpandedGroups([LOOSE]).size).toBe(0);
  });
});
