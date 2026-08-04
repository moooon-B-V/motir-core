import { describe, expect, it } from 'vitest';
import { planEntranceFace, showsPlanEntrance } from '@/lib/planning/planEntranceVisibility';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// THE Plan / Re-plan rule (Yue, 2026-08-04), which every planning surface asks
// this one function for:
//   1. a `done` card offers neither face, parent or child, any kind;
//   2. a LEAF's face comes from its DESCRIPTION;
//   3. an epic/story's face comes from its CHILDREN.
// Extracted in MOTIR-2084 and completed in MOTIR-2097 because the boolean had
// been inlined at each call site and grown one bug at a time — MOTIR-2050 added
// the archived gate, MOTIR-2084 the terminal one, and a third surface had
// neither.

const LIVE = {
  canPlan: true,
  archived: false,
  statusCategory: 'todo',
  kind: 'story' as WorkItemKindDto,
  hasChildren: false,
  hasDescription: false,
} as const;

const CONTAINERS: WorkItemKindDto[] = ['epic', 'story'];
const LEAVES: WorkItemKindDto[] = ['task', 'bug', 'subtask'];

describe('rule 1 — a done card offers NO Plan and NO Re-plan', () => {
  it('hides on every kind, parent or child, whatever else is true', () => {
    // The rule is unconditional, and the done PARENT is the case that motivated
    // it: still hidden, even though an `add` under it would survive the approve
    // gate. The engine refuses modify/remove on terminal work
    // (`PlanTargetImmutableError`, 409) and the canvas draws it `locked`.
    for (const kind of [...CONTAINERS, ...LEAVES]) {
      for (const hasChildren of [true, false]) {
        for (const hasDescription of [true, false]) {
          expect(
            planEntranceFace({
              ...LIVE,
              statusCategory: 'done',
              kind,
              hasChildren,
              hasDescription,
            }),
          ).toBeNull();
        }
      }
    }
  });

  it('reads the CATEGORY, not the status key — every terminal status is covered', () => {
    // Two DIFFERENT status keys share `category: 'done'` in the default workflow,
    // so a key-based gate would have hidden Done and left Cancelled standing. A
    // project may define further done-category statuses. Same vocabulary the
    // server uses (`workflowsService.getTerminalStatusKeys`).
    const workflow = [
      { key: 'todo', category: 'todo' },
      { key: 'in_progress', category: 'in_progress' },
      { key: 'in_review', category: 'in_progress' },
      { key: 'done', category: 'done' },
      { key: 'cancelled', category: 'done' },
    ] as const;

    expect(
      Object.fromEntries(
        workflow.map((s) => [s.key, showsPlanEntrance({ ...LIVE, statusCategory: s.category })]),
      ),
    ).toEqual({
      todo: true,
      in_progress: true,
      in_review: true,
      done: false,
      cancelled: false,
    });
  });

  it('does NOT treat an unclassifiable status as terminal — it fails safe toward showing', () => {
    expect(planEntranceFace({ ...LIVE, statusCategory: null })).toBe('plan');
    expect(planEntranceFace({ ...LIVE, statusCategory: undefined })).toBe('plan');
  });
});

describe('rule 2 — a LEAF takes its face from its DESCRIPTION', () => {
  it('a described leaf is Re-plan; an empty one is Plan', () => {
    // A leaf can never have children, so `hasChildren` cannot pick its face —
    // the description is the signal that there is already something to re-plan.
    for (const kind of LEAVES) {
      expect(planEntranceFace({ ...LIVE, kind, hasDescription: true })).toBe('replan');
      expect(planEntranceFace({ ...LIVE, kind, hasDescription: false })).toBe('plan');
    }
  });

  it('ignores hasChildren for a leaf — the description decides, nothing else', () => {
    for (const kind of LEAVES) {
      expect(planEntranceFace({ ...LIVE, kind, hasChildren: true, hasDescription: false })).toBe(
        'plan',
      );
      expect(planEntranceFace({ ...LIVE, kind, hasChildren: false, hasDescription: true })).toBe(
        'replan',
      );
    }
  });
});

describe('rule 3 — an epic or story takes its face from its CHILDREN', () => {
  it('with children it is Re-plan; without them it is always Plan', () => {
    for (const kind of CONTAINERS) {
      expect(planEntranceFace({ ...LIVE, kind, hasChildren: true })).toBe('replan');
      expect(planEntranceFace({ ...LIVE, kind, hasChildren: false })).toBe('plan');
    }
  });

  it('a DESCRIBED but childless container is still Plan — rule 3 wins for containers', () => {
    // For a container it is the CHILDREN that constitute the plan, not the prose.
    // This is the case where rules 2 and 3 disagree, and rule 3 is explicit.
    for (const kind of CONTAINERS) {
      expect(planEntranceFace({ ...LIVE, kind, hasChildren: false, hasDescription: true })).toBe(
        'plan',
      );
    }
  });
});

describe('the gates that precede all three rules', () => {
  it('hides on an archived item (MOTIR-2050) — a soft-delete leaves the status alone', () => {
    expect(planEntranceFace({ ...LIVE, archived: true })).toBeNull();
  });

  it('hides from an actor who cannot plan — planning proposes plan changes', () => {
    expect(planEntranceFace({ ...LIVE, canPlan: false })).toBeNull();
  });

  it('any one gate closes the door, whatever the other two say', () => {
    expect(planEntranceFace({ ...LIVE, canPlan: false, archived: true })).toBeNull();
    expect(planEntranceFace({ ...LIVE, archived: true, statusCategory: 'done' })).toBeNull();
    expect(planEntranceFace({ ...LIVE, canPlan: false, statusCategory: 'done' })).toBeNull();
  });
});

describe('showsPlanEntrance — the boolean half stays in step with the face', () => {
  it('is true exactly when a face is drawn', () => {
    for (const kind of [...CONTAINERS, ...LEAVES]) {
      for (const statusCategory of ['todo', 'in_progress', 'done'] as const) {
        const args = { ...LIVE, kind, statusCategory };
        expect(showsPlanEntrance(args)).toBe(planEntranceFace(args) !== null);
      }
    }
  });
});
