import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SWITCH_LANDING,
  afterContextSwitchTarget,
} from '@/lib/navigation/afterContextSwitch';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// MOTIR-1312 — after switching the active org / workspace the page must NOT just
// refresh in place (stale client islands + an old-context-scoped URL). The pure
// decision: navigate to the landing, unless already there → refresh.
//
// MOTIR-5132 moved WHERE. This module used to declare `'/items'` of its own,
// making it a second answer to a question `lib/navigation/landing.ts` already
// owns; it now composes. The assertions below say so by COMPOSITION rather than
// by re-typing '/workbench' — a literal here would just be the same defect one
// directory over, and the landing guard forbids it under app/ components/ lib/
// for exactly that reason.
describe('afterContextSwitchTarget', () => {
  it('lands on the signed-in landing from any other page', () => {
    for (const path of [
      '/dashboard',
      '/boards',
      '/items', // the surface this used to land on (MOTIR-5132)
      '/items/MOTIR-804', // a deep, old-org-scoped work-item URL
      '/sprints/abc/report',
      '/settings/organization/members',
      '/items/archived',
      '/reports',
    ]) {
      expect(afterContextSwitchTarget(path)).toBe(CONTEXT_SWITCH_LANDING);
    }
  });

  it('returns null (refresh in place) when already on the landing surface', () => {
    expect(afterContextSwitchTarget(CONTEXT_SWITCH_LANDING)).toBeNull();
    expect(afterContextSwitchTarget(AUTHED_LANDING_PATH)).toBeNull();
  });

  it('treats a null pathname as "navigate" (never silently refreshes a stale body)', () => {
    expect(afterContextSwitchTarget(null)).toBe(CONTEXT_SWITCH_LANDING);
  });

  it('is the signed-in landing, COMPOSED from its owner rather than re-typed', () => {
    // The point of MOTIR-5132: one owner, one spelling. Asserting equality with
    // AUTHED_LANDING_PATH holds whatever that value becomes, which is what a
    // re-typed literal here could not do — and is why the rename that produced
    // this defect (MOTIR-4782, /home → /workbench) could not have reached it.
    expect(CONTEXT_SWITCH_LANDING).toBe(AUTHED_LANDING_PATH);
  });

  it('no longer lands on the work-items list, which is now pushed AWAY from', () => {
    // The pre-MOTIR-5132 behaviour, stated as the regression it would be.
    expect(afterContextSwitchTarget('/items')).not.toBeNull();
    expect(CONTEXT_SWITCH_LANDING).not.toBe('/items');
  });
});
