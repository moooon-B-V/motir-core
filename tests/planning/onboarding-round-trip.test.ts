import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLANNING_RETURN_PARAM,
  planningHostPathFor,
  parsePlanningOverlay,
  withoutPlanningOverlay,
} from '@/lib/planning/launcher';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { handoffDestination, readHandoffReturn } from '@/lib/planning/onboardingHandoff';
import { searchParamsToEntries } from '@/lib/navigation/searchParamsToEntries';
import { planningForwardTarget } from '@/app/(authed)/planning/page';

// THE ROUND TRIP (Story MOTIR-4753 · MOTIR-4770).
//
// ⚠️ THE PROBLEM THIS SOLVES IS STRUCTURAL, NOT COSMETIC. `PlanningWorkspaceOverlay`
// is mounted in `app/(authed)/layout.tsx` and nowhere else; `app/(onboarding)/`
// is a SIBLING group that mounts none. So the hand-off did not swap a modal — it
// unmounted the overlay and left the route group, and there was no page
// underneath to come back to. Onboarding ended by redirecting to `/roadmap`, so
// a user who pressed *Plan with AI*, was told what was read, was moved to
// onboarding and finished it landed somewhere they never asked to be. The
// journey had no end.

/** The address the hand-off writes, parsed as a destination would read it. */
const outbound = (context: Parameters<typeof handoffDestination>[1]) =>
  new URLSearchParams(
    handoffDestination(
      { outcome: 'onboard_existing_project', message: 'm', keptSteps: ['discovery'], missing: [] },
      context,
    ).split('?')[1],
  );

describe('the launch context survives the trip OUT', () => {
  it.each([
    ['project', { kind: 'project' } as const],
    ['roadmap', { kind: 'roadmap' } as const],
    ['work-item', { kind: 'work-item', itemKey: 'ACME-7' } as const],
    ['convention-refine', { kind: 'convention-refine', repoKey: 'acme/widgets' } as const],
  ])('a %s launch round-trips through the address', (_kind, context) => {
    expect(readHandoffReturn(outbound(context))).toMatchObject(context);
  });

  it('an address carrying NO return is `null`, not a guess', () => {
    // Somebody who reached onboarding by the entrance, a bookmark or a fresh
    // sign-up has no window to return to, and inventing one for them would be a
    // workspace opening around a user who never asked for it.
    expect(readHandoffReturn(new URLSearchParams('via=onboard_new_project'))).toBeNull();
  });
});

describe('COMPLETING lands back in the window they opened', () => {
  it('re-opens the overlay on the host page the context implies', () => {
    const href = onboardingReturnHref(
      outbound({ kind: 'work-item', itemKey: 'ACME-7' }),
      'completed',
    );
    expect(href).not.toBeNull();
    const [path, query] = href!.split('?');
    // The HOST is the anchor's own page — not the project root, and not the
    // roadmap every completion path used to redirect to.
    expect(path).toBe('/items/ACME-7');
    // …and the workspace is OPEN on it: the overlay's own parameters are what
    // say so, and `parsePlanningOverlay` is what reads them.
    const launch = parsePlanningOverlay(new URLSearchParams(query));
    expect(launch).not.toBeNull();
    expect(launch?.itemKey).toBe('ACME-7');
  });

  it.each([
    ['project', { kind: 'project' } as const, '/roadmap'],
    ['roadmap', { kind: 'roadmap' } as const, '/roadmap'],
    ['work-item', { kind: 'work-item', itemKey: 'ACME-7' } as const, '/items/ACME-7'],
    ['convention-refine', { kind: 'convention-refine', repoKey: 'r' } as const, '/code-health'],
  ])('a %s context returns to %s', (_kind, context, expected) => {
    expect(onboardingReturnHref(outbound(context), 'completed')!.split('?')[0]).toBe(expected);
  });

  it('carries the RETURN MARKER, so the routing verdict is not asked again', () => {
    // A user coming back was routed thirty seconds ago and has just done what
    // they were sent to do. Reading them again — and possibly routing them
    // again — is the loop this marker prevents.
    const href = onboardingReturnHref(outbound({ kind: 'project' }), 'completed')!;
    expect(new URLSearchParams(href.split('?')[1]).get(PLANNING_RETURN_PARAM)).toBe('1');
  });
});

describe('ABANDONING lands on the PAGE, with no workspace around them', () => {
  it('returns the host path and NOT one overlay parameter', () => {
    // The opposite failure to stranding them, and the easier one to write by
    // accident: the return path already knows where to go, so the temptation is
    // to take it unconditionally.
    const href = onboardingReturnHref(
      outbound({ kind: 'work-item', itemKey: 'ACME-7' }),
      'abandoned',
    );
    expect(href).toBe('/items/ACME-7');
    expect(parsePlanningOverlay(new URLSearchParams(href!.split('?')[1] ?? ''))).toBeNull();
    expect(href).not.toContain(PLANNING_RETURN_PARAM);
  });

  it('and `null` for somebody who never came from the window', () => {
    expect(onboardingReturnHref(new URLSearchParams(), 'abandoned')).toBeNull();
  });
});

describe('AC4 · the host mapping exists in ONE place', () => {
  it('the FORWARD consumes the lifted function and still answers what it did', () => {
    // `hostPathFor` lived in `app/(authed)/planning/page.tsx` because that was
    // its only caller. The return asks the same question — *this context belongs
    // to which page?* — and two copies of it is the drift MOTIR-4732's own note
    // is about.
    expect(
      planningForwardTarget({ mode: 'contextual', from: 'work-item', item: 'ACME-7' }),
    ).toMatch(/^\/items\/ACME-7\?/);
    expect(planningForwardTarget({ mode: 'contextual', from: 'roadmap' })).toMatch(/^\/roadmap\?/);
    expect(
      planningForwardTarget({ mode: 'contextual', from: 'convention-refine', repo: 'r' }),
    ).toMatch(/^\/code-health\?/);
  });

  it('and the forward declares no mapping of its own any more', () => {
    const forward = readFileSync(join(process.cwd(), 'app/(authed)/planning/page.tsx'), 'utf8');
    expect(forward).not.toMatch(/function hostPathFor/);
    expect(forward).toContain('planningHostPathFor');
  });

  it('the lifted mapping is total over every context kind', () => {
    // Asserted as a property rather than a table so a fifth kind cannot be added
    // to `PlanningLaunchContext` and silently fall through to the roadmap.
    for (const context of [
      { kind: 'project' } as const,
      { kind: 'roadmap' } as const,
      { kind: 'work-item', itemKey: 'A-1' } as const,
      { kind: 'convention-refine', repoKey: 'r' } as const,
    ]) {
      expect(planningHostPathFor(context).startsWith('/')).toBe(true);
    }
  });
});

describe('the RETURN MARKER is an overlay parameter for stripping, not for launching', () => {
  it('does not make a workspace open on its own', () => {
    // It says *you have just come back*, not *the workspace is open*. Only the
    // four launch parameters say the second thing.
    expect(parsePlanningOverlay(new URLSearchParams(`${PLANNING_RETURN_PARAM}=1`))).toBeNull();
  });

  it('is STRIPPED by Close, so it cannot linger and change the next open', () => {
    expect(withoutPlanningOverlay(`/roadmap?${PLANNING_RETURN_PARAM}=1&filter=type%3Acode`)).toBe(
      '/roadmap?filter=type%3Acode',
    );
  });
});

describe('every onboarding EXIT reads the return address', () => {
  // The five sites that hard-coded `/roadmap`. A completion path that kept the
  // literal is a journey that still has no end, and it would look exactly like
  // one that works for every user who arrived by another door.
  it.each([
    'app/(onboarding)/onboarding/page.tsx',
    'app/(onboarding)/onboarding/discovery/page.tsx',
    'app/(onboarding)/onboarding/migrate/page.tsx',
    'app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx',
  ])('%s asks where to return', (rel) => {
    const src = readFileSync(join(process.cwd(), rel), 'utf8');
    expect(src).toContain('onboardingReturnHref');
    // The literal survives only as the FALLBACK for somebody with no return
    // address — never on its own.
    for (const m of src.match(/'\/roadmap'/g) ?? []) expect(m).toBe("'/roadmap'");
    expect(src).not.toMatch(/redirect\('\/roadmap'\)/);
    expect(src).not.toMatch(/router\.push\('\/roadmap'\)/);
  });
});

describe('a repeated query parameter is not silently dropped', () => {
  it('every value survives the bag → entries conversion', () => {
    // Dropping the rest of an array is the quiet way to lose the one that
    // mattered.
    expect(searchParamsToEntries({ a: ['1', '2'], b: 'x', c: undefined })).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', 'x'],
    ]);
  });
});

describe('AC8 · the return is ACKNOWLEDGED in the CONVERSATION', () => {
  // ⚠️ ASSERTED AT THE SEAM AND AT THE SOURCE, and the reason is worth stating:
  // the flag's TRAVEL is asserted where it travels (`tests/components/
  // planning-workspace-overlay.test.tsx` drives the overlay and reads it off the
  // host), and the LINE itself has no render harness of its own — `PlanChangeRail`
  // is only ever rendered through the host today. What a source read can hold is
  // that the line is in the rail rather than anywhere else, which is the whole
  // decision: the rail is where the session speaks, a toast fades and a returning
  // user can miss it, and a banner over the canvas would put chrome between them
  // and the thing they came back for. MOTIR-4762's recording is what watches a
  // person read it.
  const rail = readFileSync(join(process.cwd(), 'components/planning/PlanChangeRail.tsx'), 'utf8');

  it('the line lives in the RAIL, above the opener', () => {
    expect(rail).toContain('justReturnedFromOnboarding');
    expect(rail).toContain('data-testid="planning-return-ack"');
    const ack = rail.indexOf('planning-return-ack');
    const opener = rail.indexOf('The opener —');
    expect(ack).toBeGreaterThan(-1);
    expect(ack).toBeLessThan(opener);
  });

  it('it is NOT a toast and NOT a banner over the canvas', () => {
    for (const surface of ['components/planning/PlanningWorkspaceHost.tsx']) {
      const src = readFileSync(join(process.cwd(), surface), 'utf8');
      // The host passes the flag straight through; it draws nothing itself.
      expect(src).toContain('justReturnedFromOnboarding');
      expect(src).not.toContain('planning-return-ack');
      expect(src).not.toMatch(/toast/i);
    }
  });

  it('the ABANDONED path can never set it — nothing was completed', () => {
    // The flag rides the return MARKER, and only the completed exit writes one.
    const abandoned = onboardingReturnHref(outbound({ kind: 'project' }), 'abandoned')!;
    expect(abandoned).not.toContain(PLANNING_RETURN_PARAM);
  });
});
