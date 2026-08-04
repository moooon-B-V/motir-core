import { describe, expect, it } from 'vitest';
import { showsPlanEntrance } from '@/lib/planning/planEntranceVisibility';

// The ONE visibility predicate behind the per-item Plan / Re-plan entrance
// (MOTIR-910), extracted in bug MOTIR-2084 because the boolean had been inlined
// at both call sites and grown one state at a time — `archived` in MOTIR-2050,
// terminal here. What these lock is the rule itself, independent of any surface.

const LIVE = { canPlan: true, archived: false, statusCategory: 'todo' } as const;

describe('showsPlanEntrance — the door is open on live, plannable work', () => {
  it('shows on a todo item', () => {
    expect(showsPlanEntrance(LIVE)).toBe(true);
  });

  it('shows on an in-progress item — work under way is still re-plannable', () => {
    expect(showsPlanEntrance({ ...LIVE, statusCategory: 'in_progress' })).toBe(true);
  });
});

describe('showsPlanEntrance — the terminal gate (MOTIR-2084)', () => {
  it('hides on a done-category item — the engine refuses to modify finished work', () => {
    // `validatePlanProposals` step 4 throws `PlanTargetImmutableError` (409) for
    // a modify/remove against such a target, and `diffStateForItem` already draws
    // it `locked` on the canvas. The door was the last surface not to know.
    expect(showsPlanEntrance({ ...LIVE, statusCategory: 'done' })).toBe(false);
  });

  it('reads the CATEGORY, not the status key — EVERY terminal status is covered', () => {
    // The rule is category-based, so two DIFFERENT status keys that share
    // `category: 'done'` must reach the same verdict. The default workflow ships
    // exactly that pair — a gate keyed off the `'done'` KEY would have hidden the
    // door on Done and left it standing on Cancelled — and a project may define
    // further done-category statuses. This mirrors the server's own vocabulary
    // (`workflowsService.getTerminalStatusKeys` resolves `category = 'done'`).
    const workflow = [
      { key: 'todo', category: 'todo' },
      { key: 'in_progress', category: 'in_progress' },
      { key: 'in_review', category: 'in_progress' },
      { key: 'done', category: 'done' },
      { key: 'cancelled', category: 'done' },
    ] as const;

    const verdictByKey = Object.fromEntries(
      workflow.map((s) => [s.key, showsPlanEntrance({ ...LIVE, statusCategory: s.category })]),
    );
    expect(verdictByKey).toEqual({
      todo: true,
      in_progress: true,
      in_review: true,
      done: false,
      cancelled: false,
    });
  });

  it('does NOT treat an unclassifiable status as terminal — it fails safe toward showing', () => {
    expect(showsPlanEntrance({ ...LIVE, statusCategory: null })).toBe(true);
    expect(showsPlanEntrance({ ...LIVE, statusCategory: undefined })).toBe(true);
  });
});

describe('showsPlanEntrance — the gates it inherited', () => {
  it('hides on an archived item (MOTIR-2050) — a soft-delete leaves the status alone', () => {
    expect(showsPlanEntrance({ ...LIVE, archived: true })).toBe(false);
  });

  it('hides from an actor who cannot plan — planning proposes plan changes', () => {
    expect(showsPlanEntrance({ ...LIVE, canPlan: false })).toBe(false);
  });

  it('needs ALL THREE gates — any one of them closes the door', () => {
    expect(showsPlanEntrance({ canPlan: false, archived: true, statusCategory: 'done' })).toBe(
      false,
    );
    expect(showsPlanEntrance({ canPlan: true, archived: true, statusCategory: 'done' })).toBe(
      false,
    );
    expect(showsPlanEntrance({ canPlan: true, archived: false, statusCategory: 'done' })).toBe(
      false,
    );
  });
});
