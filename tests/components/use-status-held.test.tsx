// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import type { HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { PlanHoldDTO } from '@/lib/dto/plans';

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

  it('never shows a line for the status the card ALREADY has, whatever moved it', () => {
    const read = [held({}), held({ statusKey: 'approved', statusLabel: 'Approved' })];
    const { result, rerender } = renderHook(({ status }) => useStatusHeld(read, statuses, status), {
      initialProps: { status: 'in_review' },
    });
    expect(result.current.lines.map((l) => l.statusKey)).toEqual(['done', 'approved']);

    // An approval repaints the page to Done in place — no call through the hook.
    rerender({ status: 'done' });
    expect(result.current.lines.map((l) => l.statusKey)).toEqual(['approved']);
    expect(result.current.held).toEqual([{ statusKey: 'approved', waitingOn: 'decision' }]);
  });

  // ── A PLAN HOLD (Story MOTIR-6017 · MOTIR-6267) ─────────────────────────────
  const withPlanning: WorkflowStatusDto[] = [
    { ...statuses[0]!, id: 's0', key: 'planning', label: 'Planning', category: 'todo' },
    ...statuses,
  ];
  const hold = (over: Partial<PlanHoldDTO> = {}): PlanHoldDTO => ({
    itemKey: 'PROD-1',
    workItemId: 'wi_1',
    planId: 'pln_1',
    planStatus: 'planned',
    sessionId: 'pcs_1',
    anchorKey: 'PROD-1',
    ...over,
  });

  it('a plan hold locks EVERY option but the current one, tagged as the plan’s', () => {
    const { result } = renderHook(() =>
      useStatusHeld([held({})], withPlanning, 'planning', hold()),
    );
    expect(result.current.plan).toMatchObject({ planId: 'pln_1' });
    expect(result.current.held).toEqual([
      { statusKey: 'in_review', waitingOn: 'plan' },
      { statusKey: 'approved', waitingOn: 'plan' },
      { statusKey: 'done', waitingOn: 'plan' },
    ]);
    // The gate's own line is still there, for the notice to say beneath the plan.
    expect(result.current.lines.map((l) => l.statusKey)).toEqual(['done']);
  });

  it('no plan hold → no plan, and only the gate’s own locks', () => {
    const { result } = renderHook(() => useStatusHeld([held({})], withPlanning, 'planning', null));
    expect(result.current.plan).toBeNull();
    expect(result.current.held).toEqual([{ statusKey: 'done', waitingOn: 'decision' }]);

    const bare = renderHook(() => useStatusHeld(undefined, withPlanning, 'planning'));
    expect(bare.result.current.plan).toBeNull();
    expect(bare.result.current.held).toEqual([]);
  });

  it('a PLAN_TARGET_HELD refusal folds the plan in; a move that went through drops it', () => {
    const { result } = renderHook(() => useStatusHeld(undefined, withPlanning, 'planning', null));
    act(() => result.current.onPlanHeldRefused(hold({ planStatus: 'generating' })));
    expect(result.current.plan).toMatchObject({ planStatus: 'generating' });
    expect(result.current.held).toHaveLength(3);

    act(() => result.current.onMoved('in_review'));
    expect(result.current.plan).toBeNull();
    expect(result.current.held).toEqual([]);
  });

  it('the hold drops at READ time once the card is no longer at Planning, whatever moved it', () => {
    const { result, rerender } = renderHook(
      ({ status }) => useStatusHeld(undefined, withPlanning, status, hold()),
      { initialProps: { status: 'planning' } },
    );
    expect(result.current.plan).not.toBeNull();

    rerender({ status: 'in_review' });
    expect(result.current.plan).toBeNull();
    expect(result.current.held).toEqual([]);
  });

  it('a refusal while the page still shows an OLDER status stands there, until the card shows anything else', () => {
    // The plan took the card after render: the server says Planning, the page says In Review.
    const { result, rerender } = renderHook(
      ({ status }) => useStatusHeld(undefined, withPlanning, status, null),
      { initialProps: { status: 'in_review' } },
    );
    act(() => result.current.onPlanHeldRefused(hold()));
    expect(result.current.plan).toMatchObject({ planId: 'pln_1' });
    expect(result.current.held.map((h) => h.statusKey)).toEqual(['planning', 'approved', 'done']);

    rerender({ status: 'done' });
    expect(result.current.plan).toBeNull();
  });

  it('a NEW read of the plan replaces the folded one', () => {
    const { result, rerender } = renderHook(
      ({ plan }) => useStatusHeld(undefined, withPlanning, 'planning', plan),
      { initialProps: { plan: null as PlanHoldDTO | null } },
    );
    expect(result.current.plan).toBeNull();
    rerender({ plan: hold({ planStatus: 'stale' }) });
    expect(result.current.plan).toMatchObject({ planStatus: 'stale' });
    rerender({ plan: null });
    expect(result.current.plan).toBeNull();
  });
});
