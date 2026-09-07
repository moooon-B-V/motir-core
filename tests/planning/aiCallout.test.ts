import { describe, it, expect } from 'vitest';
import { AI_CALLOUT_NAME_KEY, aiCalloutActions } from '@/lib/planning/aiCallout';
import { planningOverlaySearch, type PlanningLaunchContext } from '@/lib/planning/launcher';

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

// ⚠️ RE-POINTED (MOTIR-4730). The registry used to RESOLVE the href from a
// context; it now RECEIVES one, because the workspace is an overlay on the
// current page and only a component can read that address
// (`useOpenPlanningWorkspace`). The invariant these tests exist for is
// untouched — one href, shared by every row — so they assert the same thing
// against the new signature rather than being deleted.
//
// The address a door would actually produce, for the contexts below: composed
// from the launcher's own `planningOverlaySearch`, so this file cannot drift
// from the names the design records.
function overlayHref(context: PlanningLaunchContext, page = '/backlog'): string {
  return `${page}?${planningOverlaySearch(context).toString()}`;
}

describe('aiCalloutActions', () => {
  it('leads with Plan with AI — the first action IS the primary row', () => {
    // The menu marks the primary action by its filled tile AND its position, so
    // the registry's ORDER is the contract, not a decorative flag.
    expect(aiCalloutActions(overlayHref({ kind: 'project' }))[0]?.id).toBe('plan');
  });

  it('points the plan action at the OVERLAY address it was handed', () => {
    const [plan] = aiCalloutActions(overlayHref({ kind: 'project' }));
    expect(plan?.href).toBe('/backlog?plan=project&planFrom=project');
    // Not a destination any more: the workspace opens on the page the callout
    // is open on.
    expect(plan?.href).not.toContain('/planning');
  });

  it('carries whatever address it is given — it builds none of its own', () => {
    const context: PlanningLaunchContext = { kind: 'work-item', itemKey: 'MOTIR-1812' };
    expect(aiCalloutActions(overlayHref(context, '/items'))[0]?.href).toBe(
      '/items?plan=contextual&planFrom=work-item&planItem=MOTIR-1812',
    );
  });

  it.each(CONTEXTS)('sends EVERY row to the one AI surface (%j)', (context) => {
    // The callout is a capability list, not a mode picker or a router: a row is
    // a LABEL, not a route. One href, shared — never a per-row destination.
    const hrefs = new Set(aiCalloutActions(overlayHref(context)).map((a) => a.href));
    expect([...hrefs]).toEqual([overlayHref(context)]);
  });

  it.each(CONTEXTS)(
    'is TOTAL — every action carries a title, a description and an href (%j)',
    (context) => {
      const actions = aiCalloutActions(overlayHref(context));
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
    const actions = aiCalloutActions(overlayHref({ kind: 'project' }));
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    expect(new Set(actions.map((a) => a.titleKey)).size).toBe(actions.length);
    expect(new Set(actions.map((a) => a.descriptionKey)).size).toBe(actions.length);
  });

  it('registers ONLY landed capabilities — no "coming soon" placeholder rows', () => {
    // A row appears when its CAPABILITY does, never before: a dead row costs a
    // tab stop and a screen-reader announcement, and it is a promise the product
    // cannot keep. `ask` joined with MOTIR-1343; `help` (MOTIR-1344) is still
    // absent, and this list is what says so.
    expect(aiCalloutActions(overlayHref({ kind: 'project' })).map((a) => a.id)).toEqual([
      'plan',
      'ask',
    ]);
  });

  it('⭐ gives every row the SAME href — the registry is a capability list', () => {
    // The one invariant the whole surface rests on (design-notes.md § "EVERY ROW
    // OPENS THE SAME SURFACE"). A second destination here would be the ask mode
    // the design deliberately does not have, arriving as a registry field.
    for (const context of [
      { kind: 'project' },
      { kind: 'roadmap' },
      { kind: 'work-item', itemKey: 'PAY-7' },
    ] as const) {
      const hrefs = aiCalloutActions(overlayHref(context)).map((a) => a.href);
      expect(hrefs.length).toBeGreaterThan(1);
      expect(new Set(hrefs).size).toBe(1);
      for (const href of hrefs) expect(href).not.toContain('intent=');
    }
  });

  it('names the callout from the shell namespace, so trigger and panel cannot drift', () => {
    expect(AI_CALLOUT_NAME_KEY).toBe('aiCallout.name');
  });
});
