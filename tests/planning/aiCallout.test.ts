import { describe, it, expect } from 'vitest';
import { AI_CALLOUT_NAME_KEY, aiCalloutActions } from '@/lib/planning/aiCallout';
import { planningWorkspaceHref, type PlanningLaunchContext } from '@/lib/planning/launcher';

// The "M" AI callout's action registry (MOTIR-1812). The pure core is the
// callout's testable contract — what the menu renders is derived from it, and
// the design's two invariants ("every row opens the SAME surface", "an unlanded
// capability is ABSENT, never a dead row") live here, not in the component.

const CONTEXTS: PlanningLaunchContext[] = [
  { kind: 'project' },
  { kind: 'project', hasPlan: true },
  { kind: 'work-item', itemKey: 'MOTIR-1812' },
  { kind: 'roadmap' },
  { kind: 'convention-refine', repoKey: 'motir-core' },
];

describe('aiCalloutActions', () => {
  it('leads with Plan with AI — the first action IS the primary row', () => {
    // The menu marks the primary action by its filled tile AND its position, so
    // the registry's ORDER is the contract, not a decorative flag.
    expect(aiCalloutActions({ kind: 'project' })[0]?.id).toBe('plan');
  });

  it('points the plan action at the shipped planning workspace href', () => {
    const [plan] = aiCalloutActions({ kind: 'project' });
    expect(plan?.href).toBe(planningWorkspaceHref({ kind: 'project' }));
    expect(plan?.href).toBe('/planning?mode=project&from=project');
  });

  it('carries the originating context into the href, without duplicating href-building', () => {
    const context: PlanningLaunchContext = { kind: 'work-item', itemKey: 'MOTIR-1812' };
    expect(aiCalloutActions(context)[0]?.href).toBe(
      '/planning?mode=contextual&from=work-item&item=MOTIR-1812',
    );
  });

  it.each(CONTEXTS)('sends EVERY row to the one AI surface (%j)', (context) => {
    // The callout is a capability list, not a mode picker or a router: a row is
    // a LABEL, not a route. One href, shared — never a per-row destination.
    const hrefs = new Set(aiCalloutActions(context).map((a) => a.href));
    expect([...hrefs]).toEqual([planningWorkspaceHref(context)]);
  });

  it.each(CONTEXTS)(
    'is TOTAL — every action carries a title, a description and an href (%j)',
    (context) => {
      const actions = aiCalloutActions(context);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.id).not.toBe('');
        expect(action.titleKey).not.toBe('');
        expect(action.descriptionKey).not.toBe('');
        expect(action.href).not.toBe('');
        expect(action.icon).not.toBe('');
      }
    },
  );

  it('registers each action once — ids and message keys are unique', () => {
    const actions = aiCalloutActions({ kind: 'project' });
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    expect(new Set(actions.map((a) => a.titleKey)).size).toBe(actions.length);
    expect(new Set(actions.map((a) => a.descriptionKey)).size).toBe(actions.length);
  });

  it('registers ONLY landed capabilities — no "coming soon" placeholder rows', () => {
    // MOTIR-1343 (ask) / MOTIR-1344 (help) are absent until their stories land:
    // a dead row costs a tab stop and a screen-reader announcement, and it is a
    // promise the product cannot keep.
    expect(aiCalloutActions({ kind: 'project' }).map((a) => a.id)).toEqual(['plan']);
  });

  it('names the callout from the shell namespace, so trigger and panel cannot drift', () => {
    expect(AI_CALLOUT_NAME_KEY).toBe('aiCallout.name');
  });
});
