import { describe, expect, it } from 'vitest';
import { stepLevel } from '@/lib/planning/livePane';
import {
  drivenFollowRequest,
  drivenStepId,
  nextDrivenStep,
  type DrivenStep,
} from '@/lib/planning/plannerDrive';
import type { PlanProgressStep } from '@/lib/plans/planProgress';
import { planReviewItem } from '../helpers/planReview';

// The planner-driven canvas's PURE half (MOTIR-8592, Story MOTIR-8590): which
// live step the canvas follows, the level it names, and the keyed request it
// makes. Every case is plain fixtures — the live steps exactly as
// `readPlanProgress` hands them over (already ordered, already live).

// A root proposed story with one proposed child task, and a second root.
const story = planReviewItem({ planItemId: 'ps', nodeId: 'ps', title: 'Story', kind: 'story' });
const task = planReviewItem({
  planItemId: 'pt',
  nodeId: 'pt',
  parentNodeId: 'ps',
  title: 'Task',
});
const other = planReviewItem({ planItemId: 'po', nodeId: 'po', title: 'Other', kind: 'story' });
const items = [story, task, other];

let seq = 0;
function step(over: Partial<PlanProgressStep> = {}): PlanProgressStep {
  seq += 1;
  return {
    sessionKey: 's1',
    kind: 'author',
    phrase: 'authoring',
    targetRef: `planItem:${over.targetNodeId ?? `x${seq}`}`,
    targetNodeId: null,
    targetTitle: null,
    startedAt: '2026-10-15T00:00:00.000Z',
    ...over,
  } as PlanProgressStep;
}

describe('stepLevel — the level a step names', () => {
  it('author: the level the item SITS on; a root item is the top level', () => {
    expect(stepLevel(items, { kind: 'author', targetNodeId: 'ps' }, 'New')).toEqual({
      levelId: null,
      trail: [],
    });
    const level = stepLevel(items, { kind: 'author', targetNodeId: 'pt' }, 'New');
    expect(level?.levelId).toBe('ps');
    expect(level?.trail.at(-1)?.id).toBe('ps');
  });

  it("lay: the target's own children level", () => {
    const level = stepLevel(items, { kind: 'lay', targetNodeId: 'ps' }, 'New');
    expect(level?.levelId).toBe('ps');
    expect(level?.trail.at(-1)?.id).toBe('ps');
  });

  it('null for settle, a null target, an absent target and a laid parent with no child', () => {
    expect(stepLevel(items, { kind: 'settle', targetNodeId: 'ps' }, 'New')).toBeNull();
    expect(stepLevel(items, { kind: 'author', targetNodeId: null }, 'New')).toBeNull();
    expect(stepLevel(items, { kind: 'lay', targetNodeId: null }, 'New')).toBeNull();
    expect(stepLevel(items, { kind: 'author', targetNodeId: 'gone' }, 'New')).toBeNull();
    expect(stepLevel(items, { kind: 'lay', targetNodeId: 'po' }, 'New')).toBeNull();
  });
});

describe('nextDrivenStep — which step the canvas follows', () => {
  it('picks the earliest live step (the snapshot order), ties already broken by sessionKey', () => {
    const early = step({ sessionKey: 'a', targetNodeId: 'pt', startedAt: '2026-10-15T00:00:01Z' });
    const late = step({ sessionKey: 'b', targetNodeId: 'po', startedAt: '2026-10-15T00:00:02Z' });
    expect(nextDrivenStep(null, [early, late], items, 'New')?.id).toBe(drivenStepId(early));

    // readPlanProgress orders equal starts by sessionKey; the snapshot order wins.
    const a = step({ sessionKey: 'a', targetNodeId: 'po', startedAt: '2026-10-15T00:00:03Z' });
    const b = step({ sessionKey: 'b', targetNodeId: 'pt', startedAt: '2026-10-15T00:00:03Z' });
    expect(nextDrivenStep(null, [a, b], items, 'New')?.id).toBe(drivenStepId(a));
  });

  it('HOLDS the driven step while it is live, even when an earlier one appears', () => {
    const first = step({ sessionKey: 'b', targetNodeId: 'pt', startedAt: '2026-10-15T00:00:05Z' });
    const held = nextDrivenStep(null, [first], items, 'New');
    const earlier = step({
      sessionKey: 'a',
      targetNodeId: 'po',
      startedAt: '2026-10-15T00:00:01Z',
    });
    const kept = nextDrivenStep(held, [earlier, first], items, 'New');
    expect(kept?.id).toBe(drivenStepId(first));
    expect(kept?.levelId).toBe('ps');
    // Only once the held step leaves does the next one take over.
    expect(nextDrivenStep(kept, [earlier], items, 'New')?.id).toBe(drivenStepId(earlier));
  });

  it("follows the held item to its new level, and drives nothing while it can't be placed", () => {
    const s = step({ targetNodeId: 'pt' });
    const held = nextDrivenStep(null, [s], items, 'New')!;
    const moved = [story, { ...task, parentNodeId: 'po' }, other];
    expect(nextDrivenStep(held, [s], moved, 'New')?.levelId).toBe('po');
    const withdrawn = [story, other];
    const other2 = step({ sessionKey: 'z', targetNodeId: 'po' });
    expect(nextDrivenStep(held, [s, other2], withdrawn, 'New')).toBeNull();
  });

  it('a session moving to a new target is a new step', () => {
    const s1 = step({ sessionKey: 's', targetNodeId: 'pt', targetRef: 'planItem:pt' });
    const s2 = step({ sessionKey: 's', targetNodeId: 'po', targetRef: 'planItem:po' });
    const held = nextDrivenStep(null, [s1], items, 'New');
    expect(nextDrivenStep(held, [s2], items, 'New')?.id).toBe(drivenStepId(s2));
  });

  it('skips a step that names nothing on the plan for the first resolvable one', () => {
    const settle = step({ kind: 'settle', phrase: 'settling' as PlanProgressStep['phrase'] });
    const topLay = step({ kind: 'lay', targetNodeId: null });
    const drafting = step({ kind: 'author', targetNodeId: null });
    const unresolved = step({ targetNodeId: 'gone' });
    const empty = step({ kind: 'lay', targetNodeId: 'po' });
    const real = step({ sessionKey: 'z', targetNodeId: 'pt' });
    const steps = [settle, topLay, drafting, unresolved, empty, real];
    expect(nextDrivenStep(null, steps, items, 'New')?.id).toBe(drivenStepId(real));
    expect(nextDrivenStep(null, steps.slice(0, -1), items, 'New')).toBeNull();
    expect(nextDrivenStep(null, [], items, 'New')).toBeNull();
  });
});

describe('drivenFollowRequest — keyed, one per transition', () => {
  const driven: DrivenStep = {
    id: 'd1',
    levelId: 'ps',
    trail: [{ id: 'ps', label: 'New · Story' }],
  };

  it('the same driven step on the same level is the same key', () => {
    const a = drivenFollowRequest(driven, 0);
    expect(drivenFollowRequest({ ...driven, trail: [...driven.trail] }, 0)?.key).toBe(a?.key);
    expect(a?.trail).toEqual(driven.trail);
  });

  it('a new step, a level move or a new epoch is a new key', () => {
    const key = drivenFollowRequest(driven, 0)!.key;
    expect(drivenFollowRequest({ ...driven, id: 'd2' }, 0)!.key).not.toBe(key);
    expect(drivenFollowRequest({ ...driven, levelId: 'po' }, 0)!.key).not.toBe(key);
    expect(drivenFollowRequest(driven, 1)!.key).not.toBe(key);
  });

  it('passes null through, and a top-level target asks for the top level', () => {
    expect(drivenFollowRequest(null, 0)).toBeNull();
    const top = nextDrivenStep(null, [step({ targetNodeId: 'po' })], items, 'New');
    expect(drivenFollowRequest(top, 0)?.trail).toEqual([]);
  });
});
