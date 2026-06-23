import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SWITCH_LANDING,
  afterContextSwitchTarget,
} from '@/lib/navigation/afterContextSwitch';

// MOTIR-1312 — after switching the active org / workspace the page must NOT just
// refresh in place (stale client islands + an old-context-scoped URL). The pure
// decision: navigate to the work-items landing, unless already there → refresh.
describe('afterContextSwitchTarget', () => {
  it('lands on the work-items surface from any other page', () => {
    for (const path of [
      '/dashboard',
      '/boards',
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
    expect(afterContextSwitchTarget('/items')).toBeNull();
  });

  it('treats a null pathname as "navigate" (never silently refreshes a stale body)', () => {
    expect(afterContextSwitchTarget(null)).toBe(CONTEXT_SWITCH_LANDING);
  });

  it('the landing surface is the work-items list', () => {
    expect(CONTEXT_SWITCH_LANDING).toBe('/items');
  });
});
