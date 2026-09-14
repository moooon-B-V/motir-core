// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import type { HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The status control's HELD state (Story MOTIR-4887 · MOTIR-5528 · MOTIR-5530's
// coverage floor) — seeded from the read, folded forward by a refusal and a move,
// and REPLACED when a new read arrives (the quick view moving to another item).

const statuses: WorkflowStatusDto[] = [
  {
    id: 's1',
    projectId: 'p',
    key: 'in_review',
    label: 'In Review',
    category: 'in_progress',
    color: null,
    position: 'a0',
    isInitial: true,
  },
  {
    id: 's2',
    projectId: 'p',
    key: 'approved',
    label: 'Approved',
    category: 'in_progress',
    color: null,
    position: 'a1',
    isInitial: false,
  },
  {
    id: 's3',
    projectId: 'p',
    key: 'done',
    label: 'Done',
    category: 'done',
    color: null,
    position: 'a2',
    isInitial: false,
  },
];

const held = (over: Partial<HeldTransitionDTO>): HeldTransitionDTO => ({
  statusKey: 'done',
  statusLabel: 'Done',
  waitingOn: 'decision',
  kind: 'design_result',
  gateId: 'g1',
  canDecide: true,
  routedToLabel: 'Ada',
  ...over,
});

describe('useStatusHeld', () => {
  it('seeds its lines from the read, and an undefined read holds nothing', () => {
    const { result } = renderHook(() => useStatusHeld([held({})], statuses));
    expect(result.current.lines).toEqual([
      expect.objectContaining({ statusKey: 'done', gateRaised: true, canDecide: true }),
    ]);
    expect(result.current.held).toEqual([{ statusKey: 'done', waitingOn: 'decision' }]);

    const empty = renderHook(() => useStatusHeld(undefined, statuses));
    expect(empty.result.current.lines).toEqual([]);
  });

  it('a refusal adds (or replaces) that status’s line, labelled from the workflow; a move drops it', () => {
    const { result } = renderHook(() => useStatusHeld([held({})], statuses));

    act(() =>
      result.current.onRefused('approved', {
        itemKey: 'PROD-1',
        kind: 'pull_request_approval',
        waitingOn: 'decision',
        gateRaised: false,
        canDecide: false,
        routedToLabel: null,
      }),
    );
    expect(result.current.lines.map((l) => [l.statusKey, l.statusLabel, l.gateRaised])).toEqual([
      ['done', 'Done', true],
      ['approved', 'Approved', false],
    ]);

    // An unknown key labels itself rather than rendering blank.
    act(() =>
      result.current.onRefused('shipped', {
        itemKey: 'PROD-1',
        kind: 'design_result',
        waitingOn: 'merge',
        gateRaised: true,
        canDecide: false,
        routedToLabel: null,
      }),
    );
    expect(result.current.lines.at(-1)).toMatchObject({
      statusKey: 'shipped',
      statusLabel: 'shipped',
    });

    act(() => result.current.onMoved('done'));
    expect(result.current.lines.map((l) => l.statusKey)).toEqual(['approved', 'shipped']);
  });

  it('a NEW read replaces the folded state rather than being ignored', () => {
    const first = [held({})];
    const { result, rerender } = renderHook(({ read }) => useStatusHeld(read, statuses), {
      initialProps: { read: first },
    });
    act(() => result.current.onMoved('done'));
    expect(result.current.lines).toEqual([]);

    // Same array identity → nothing resets.
    rerender({ read: first });
    expect(result.current.lines).toEqual([]);

    // A new read (another item, or a fresh server render) → its lines.
    rerender({ read: [held({ statusKey: 'approved', statusLabel: 'Approved', gateId: null })] });
    expect(result.current.lines).toEqual([
      expect.objectContaining({ statusKey: 'approved', gateRaised: false }),
    ]);
  });
});
