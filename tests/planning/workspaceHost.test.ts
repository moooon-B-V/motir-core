import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';

// The planning-workspace host's GATE (Subtask MOTIR-1729) — the decision the
// overlay makes before it renders the workspace, extracted as a pure function so
// it is testable without a route (the `toIssueRows` pattern).
//
// ── WHAT MOTIR-4765 CHANGED, AND WHAT IT DID NOT ────────────────────────────
// The suite this replaces asserted the OPPOSITE of the first test below: that a
// never-onboarded project is "forwarded to onboarding — the gate is not
// bypassed", and that the host and `/onboarding` "split ownership on the same
// marker — never both, never neither". Both were faithful to the gate as it
// stood, and the model underneath them was wrong: `onboardingRanAt` is stamped
// once, by `plansService.approvePlan`, so `null` means *"has never had a plan
// APPROVED"* — not *"has never planned"*. Under that split a project with an
// indexed repository and two hundred imported work items was refused the plan
// window and sent to an interview about what it was building.
//
// So the marker is not a routing verdict any more. **This is not an assertion
// updated to match today** (`CLAUDE.md` § the receipt reflex) — the behaviour it
// described was deliberately removed by a card whose whole subject is that it
// was wrong, and the test moves with it.
//
// ⚠️ THE ACCESS HALF IS UNTOUCHED and is asserted here at least as hard as
// before: an actor who cannot browse is told `no-access` and nothing about the
// project's planning state.

describe('resolvePlanningHostGate', () => {
  it('opens the workspace for an ESTABLISHED project', () => {
    expect(resolvePlanningHostGate({ hasActiveProject: true, canBrowse: true })).toBe('workspace');
  });

  it('opens the workspace for a NEVER-ONBOARDED project — the wall is gone (MOTIR-4765)', () => {
    // There is no marker to pass any more, which is the shape of the change: the
    // same call, for both kinds of project, returns the same verdict. Whether
    // this project can be PLANNED is the planner's judgement inside the session
    // (MOTIR-4767), made after it has read the project rather than before.
    expect(resolvePlanningHostGate({ hasActiveProject: true, canBrowse: true })).toBe('workspace');
  });

  it('hints at the switcher when there is no active project', () => {
    expect(resolvePlanningHostGate({ hasActiveProject: false, canBrowse: false })).toBe(
      'no-project',
    );
    // `no-project` wins even when the actor could browse — the order is
    // deliberate and unchanged.
    expect(resolvePlanningHostGate({ hasActiveProject: false, canBrowse: true })).toBe(
      'no-project',
    );
  });

  it('refuses a non-browser, and that arm is UNCHANGED by MOTIR-4765', () => {
    // A project made private while pinned: the actor is told "no access", and
    // learns nothing about whether it has ever been planned.
    expect(resolvePlanningHostGate({ hasActiveProject: true, canBrowse: false })).toBe('no-access');
  });

  it('has exactly THREE verdicts, and `onboarding` is not one of them', () => {
    // The type-level half of the change, asserted at runtime so a re-added
    // branch fails here rather than being caught only by whoever reads the file.
    // Every reachable input combination is enumerated — there are four.
    const verdicts = new Set(
      [true, false].flatMap((hasActiveProject) =>
        [true, false].map((canBrowse) => resolvePlanningHostGate({ hasActiveProject, canBrowse })),
      ),
    );
    expect([...verdicts].sort()).toEqual(['no-access', 'no-project', 'workspace']);
    expect(verdicts.has('onboarding' as never)).toBe(false);
  });

  it('the MEMBER is gone from the type, not merely unreachable', () => {
    // The union is erased at runtime, so the source is the only place this is
    // checkable — and it matters: a member left in the type keeps every
    // `switch` arm and every `=== 'onboarding'` comparison compiling, which is
    // exactly the dead branch MOTIR-4765 AC1 asks to be forced out.
    const src = readFileSync(join(process.cwd(), 'lib/planning/workspaceHost.ts'), 'utf8');
    const union = src.slice(
      src.indexOf('export type PlanningHostGate'),
      src.indexOf('export interface PlanningHostGateInput'),
    );
    expect(union).toContain("| 'workspace'");
    expect(union).not.toContain("| 'onboarding'");
    // …and the marker is not an INPUT any more either, so nothing can quietly
    // start weighing it again without touching the signature.
    const input = src.slice(
      src.indexOf('export interface PlanningHostGateInput'),
      src.indexOf('export function resolvePlanningHostGate'),
    );
    expect(input).not.toContain('onboardingRanAt');
  });

  it('stays PURE — no I/O is reachable from the module (AC5)', () => {
    // Asserted from the import graph rather than by inspection: the file has no
    // imports at all, which is the strongest form of the property and the reason
    // the gate can be called from a client island and from a service alike.
    const src = readFileSync(join(process.cwd(), 'lib/planning/workspaceHost.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toContain('server-only');
  });
});
