import { describe, expect, it } from 'vitest';
import type { DirectionDocView, FeatureCatalogView } from '@/lib/onboarding/directionDoc';
import type { PreplanRevisionDTO } from '@/lib/dto/aiPreplan';
import {
  type DiscoveryState,
  activeDoc,
  activeRevisions,
  initialDiscoveryState,
  isGoingBack,
  isTiersComplete,
  normalizeFrame,
  reduceDiscovery,
  shouldShowDesignStep,
  willRefreshKinds,
} from '@/lib/onboarding/discoveryLoop';

const doc = (kind: DirectionDocView['kind'], body = `# ${kind}\n\nbody`): DirectionDocView => ({
  kind,
  contentMd: body,
  version: 1,
});

const revDto = (version: number, changeKind: string): PreplanRevisionDTO => ({
  version,
  changeReason: changeKind === 'created' ? null : 'you asked to broaden the audience',
  changeKind,
  diff:
    version === 1 ? null : [{ path: 'pitch.headline', kind: 'changed', before: 'a', after: 'b' }],
  createdAt: `2026-06-2${version}T00:00:00.000Z`,
});

const catalog = (title = 'Work Items'): FeatureCatalogView => ({
  categories: [
    {
      id: 'cat_1',
      title,
      features: [
        { id: 'f1', name: 'Boards', descriptionMd: 'Kanban', phase: 'mvp', status: 'todo' },
      ],
    },
  ],
  glossary: [],
});

// Drive a sequence of actions from the initial (or given) state.
function run(
  actions: Parameters<typeof reduceDiscovery>[1][],
  start: DiscoveryState = initialDiscoveryState(),
): DiscoveryState {
  return actions.reduce((s, a) => reduceDiscovery(s, a), start);
}

describe('normalizeFrame', () => {
  it('narrows the known conductor frames', () => {
    expect(normalizeFrame('assistant', { text: 'hi' })).toEqual({
      event: 'assistant',
      data: { text: 'hi' },
    });
    expect(normalizeFrame('status', { phase: 'drafting', tier: 'vision' })).toEqual({
      event: 'status',
      data: { phase: 'drafting', tier: 'vision' },
    });
    expect(normalizeFrame('docs', { docs: [{ id: 'a', kind: 'discovery', version: 2 }] })).toEqual({
      event: 'docs',
      data: { docs: [{ id: 'a', kind: 'discovery', version: 2 }] },
    });
    expect(
      normalizeFrame('validate_early_ask', {
        recommendation: 'prove it',
        defaultTiming: 'standard',
      }),
    ).toEqual({
      event: 'validate_early_ask',
      data: { recommendation: 'prove it', defaultTiming: 'standard' },
    });
  });

  it('is tolerant: drops empty/unknown frames and bad tiers without throwing', () => {
    expect(normalizeFrame('assistant', { text: '' })).toBeNull();
    expect(normalizeFrame('assistant', {})).toBeNull();
    expect(normalizeFrame('mystery', { x: 1 })).toBeNull();
    expect(normalizeFrame('status', { phase: 'nope' })).toBeNull();
    expect(normalizeFrame('docs', { docs: [{ id: 'a', kind: 'not-a-tier' }] })).toBeNull();
    // a partial state patch keeps only present keys
    expect(normalizeFrame('state', { platform: 'web', extra: 1 })).toEqual({
      event: 'state',
      data: { platform: 'web' },
    });
  });

  it('drops a status:grounding tier when absent but keeps the phase', () => {
    expect(normalizeFrame('status', { phase: 'grounding' })).toEqual({
      event: 'status',
      data: { phase: 'grounding', tier: null },
    });
  });

  it('defaults an error frame code/message defensively', () => {
    expect(normalizeFrame('error', {})).toEqual({
      event: 'error',
      data: { code: 'MOTIR_AI_UNAVAILABLE', message: null },
    });
  });
});

describe('reduceDiscovery — forward loop', () => {
  it('appends a user turn and enters the streaming state', () => {
    const s = run([{ type: 'userTurn', text: 'an invoicing tool' }]);
    expect(s.turns).toEqual([{ id: 't0', role: 'user', text: 'an invoicing tool' }]);
    expect(s.isStreaming).toBe(true);
  });

  it('an assistant frame appends a bot turn and clears the working indicator', () => {
    const s = run([
      { type: 'userTurn', text: 'hi' },
      { type: 'frame', frame: { event: 'status', data: { phase: 'grounding', tier: null } } },
      { type: 'frame', frame: { event: 'assistant', data: { text: 'Who is it for?' } } },
    ]);
    expect(s.working).toBeNull();
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Who is it for?'],
    ]);
  });

  it('a status:drafting frame surfaces the drafting tier', () => {
    const s = run([
      { type: 'frame', frame: { event: 'status', data: { phase: 'drafting', tier: 'discovery' } } },
    ]);
    expect(s.working).toEqual({ phase: 'drafting', tier: 'discovery' });
  });

  it('a docs frame marks the tier produced + stale (body fetched separately), in journey order', () => {
    const s = run([
      {
        type: 'frame',
        frame: { event: 'docs', data: { docs: [{ id: 'v', kind: 'vision', version: 1 }] } },
      },
      {
        type: 'frame',
        frame: { event: 'docs', data: { docs: [{ id: 'd', kind: 'discovery', version: 1 }] } },
      },
    ]);
    expect(s.producedKinds).toEqual(['discovery', 'vision']); // normalized to journey order
    expect(s.staleKinds).toEqual(['discovery', 'vision']);
    expect(s.docs).toEqual({}); // no body until docsLoaded
  });

  it('docsLoaded installs bodies and clears their stale flag', () => {
    const s = run([
      {
        type: 'frame',
        frame: { event: 'docs', data: { docs: [{ id: 'd', kind: 'discovery', version: 1 }] } },
      },
      { type: 'docsLoaded', docs: [doc('discovery')], catalog: null },
      { type: 'openReview', kind: 'discovery' },
    ]);
    expect(s.staleKinds).toEqual([]);
    expect(activeDoc(s)?.kind).toBe('discovery');
    expect(s.view).toBe('review');
  });

  it('openReview is a no-op until the body exists', () => {
    const s = run([{ type: 'openReview', kind: 'vision' }]);
    expect(s.view).toBe('hub');
    expect(s.activeKind).toBeNull();
  });

  it('Back returns to the hub without dropping the doc', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery')], catalog: null },
      { type: 'openReview', kind: 'discovery' },
      { type: 'backToHub' },
    ]);
    expect(s.view).toBe('hub');
    expect(s.docs.discovery).toBeTruthy();
  });

  it('merges partial state patches (a later patch keeps earlier fields)', () => {
    const s = run([
      {
        type: 'frame',
        frame: { event: 'state', data: { classification: 'startup', platform: 'web' } },
      },
      { type: 'frame', frame: { event: 'state', data: { currentGate: 'vision' } } },
    ]);
    expect(s.session.classification).toBe('startup');
    expect(s.session.platform).toBe('web');
    expect(s.session.currentGate).toBe('vision');
  });
});

describe('reduceDiscovery — validate-early ask + completion', () => {
  it('a validate_early_ask frame parks the blocking ask', () => {
    const s = run([
      {
        type: 'frame',
        frame: {
          event: 'validate_early_ask',
          data: { recommendation: 'prove demand', defaultTiming: 'standard' },
        },
      },
    ]);
    expect(s.pendingAsk).toEqual({ recommendation: 'prove demand' });
  });

  it('a tiers_complete state clears the parked ask and reads complete', () => {
    const s = run([
      {
        type: 'frame',
        frame: {
          event: 'validate_early_ask',
          data: { recommendation: 'x', defaultTiming: 'standard' },
        },
      },
      {
        type: 'frame',
        frame: { event: 'state', data: { status: 'tiers_complete', currentGate: null } },
      },
    ]);
    expect(s.pendingAsk).toBeNull();
    expect(isTiersComplete(s)).toBe(true);
  });
});

describe('reduceDiscovery — auto-route to the design wizard after the last tier (MOTIR-1376)', () => {
  it('routes into the design step on the transition to tiers_complete (web, no design yet)', () => {
    const s = run([
      { type: 'frame', frame: { event: 'state', data: { platform: 'web' } } },
      { type: 'frame', frame: { event: 'state', data: { status: 'tiers_complete' } } },
    ]);
    expect(s.view).toBe('design');
  });

  it('does NOT route for a mobile project (no design step) — stays on the hub', () => {
    const s = run([
      { type: 'frame', frame: { event: 'state', data: { platform: 'mobile' } } },
      { type: 'frame', frame: { event: 'state', data: { status: 'tiers_complete' } } },
    ]);
    expect(s.view).toBe('hub');
  });

  it('does NOT route when a design has already been chosen', () => {
    const s = run([
      { type: 'frame', frame: { event: 'state', data: { platform: 'web' } } },
      {
        type: 'setDesignChoice',
        choice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
      },
      { type: 'frame', frame: { event: 'state', data: { status: 'tiers_complete' } } },
    ]);
    expect(s.view).toBe('hub');
  });

  it('does NOT bounce a returning user — a re-affirmed tiers_complete (no transition) keeps the hub', () => {
    const completed = run([
      { type: 'frame', frame: { event: 'state', data: { platform: 'web' } } },
      { type: 'frame', frame: { event: 'state', data: { status: 'tiers_complete' } } },
    ]);
    expect(completed.view).toBe('design'); // first completion routed in
    const back = run(
      [
        { type: 'backToHub' },
        { type: 'frame', frame: { event: 'state', data: { status: 'tiers_complete' } } },
      ],
      completed,
    );
    expect(back.view).toBe('hub'); // already complete → not a transition → no re-route
  });
});

describe('reduceDiscovery — pre-plan → generation hand-off (7.3.28 / MOTIR-1041)', () => {
  // Drive the loop to tiers-complete (the exit affordance shows here).
  const complete = (): DiscoveryState =>
    run([
      {
        type: 'frame',
        frame: { event: 'docs', data: { docs: [{ id: 'd', kind: 'discovery', version: 1 }] } },
      },
      { type: 'docsLoaded', docs: [doc('discovery')] },
      {
        type: 'frame',
        frame: { event: 'state', data: { status: 'tiers_complete', currentGate: null } },
      },
    ]);

  it('enterGeneration opens the generation view once the tiers are complete', () => {
    const s = run([{ type: 'enterGeneration' }], complete());
    expect(s.view).toBe('generation');
  });

  it('is a no-op before completion (the exit is unreachable mid-flow)', () => {
    const s = run([{ type: 'enterGeneration' }]);
    expect(s.view).toBe('hub');
  });

  it('freezes nothing — the baseline (docs + session) is untouched, so it stays revisable', () => {
    const before = complete();
    const s = run([{ type: 'enterGeneration' }], before);
    expect(s.docs).toEqual(before.docs);
    expect(s.producedKinds).toEqual(before.producedKinds);
    expect(s.session).toEqual(before.session);
    expect(isTiersComplete(s)).toBe(true);
  });

  it('Back (one-click re-entry) returns from generation to the hub', () => {
    const s = run([{ type: 'enterGeneration' }, { type: 'backToHub' }], complete());
    expect(s.view).toBe('hub');
    // …and the loop is still complete, so the exit can be taken again.
    expect(isTiersComplete(s)).toBe(true);
  });
});

describe('reduceDiscovery — revisions route the downstream cascade-back (1179)', () => {
  it('normalizeFrame parses the revisions `gate` (the route-back tier)', () => {
    expect(
      normalizeFrame('revisions', {
        revisions: [{ tier: 'discovery', reason: 'direct' }],
        gate: 'discovery',
      }),
    ).toEqual({
      event: 'revisions',
      data: { revisions: [{ tier: 'discovery', reason: 'direct' }], gate: 'discovery' },
    });
    // A non-tier / absent gate narrows to null, never throws.
    expect(
      normalizeFrame('revisions', { revisions: [{ tier: 'vision', reason: 'cascade' }] }),
    ).toEqual({
      event: 'revisions',
      data: { revisions: [{ tier: 'vision', reason: 'cascade' }], gate: null },
    });
  });

  it('routes BACK to the attributed tier, marks downstream "will refresh", keeps nothing locked', () => {
    // Reviewing validation (a LATER gate); a reaction is attributed upstream to
    // discovery, cascading through vision + validation.
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery'), doc('vision'), doc('validation')] },
      { type: 'openReview', kind: 'validation' },
      {
        type: 'frame',
        frame: {
          event: 'revisions',
          data: {
            revisions: [
              { tier: 'discovery', reason: 'direct' },
              { tier: 'vision', reason: 'cascade' },
              { tier: 'validation', reason: 'cascade' },
            ],
            gate: 'discovery',
          },
        },
      },
    ]);
    // Sent back to the attributed (earliest) tier.
    expect(s.activeKind).toBe('discovery');
    expect(s.view).toBe('review');
    expect(s.cascade).toEqual({
      directTier: 'discovery',
      tiers: ['discovery', 'vision', 'validation'],
      fromKind: 'validation',
    });
    // Every affected tier's body is stale (re-fetch pending).
    expect(s.staleKinds).toEqual(['discovery', 'vision', 'validation']);
    // Downstream tiers (not the attributed one) read "will refresh" while stale.
    expect(willRefreshKinds(s)).toEqual(['vision', 'validation']);
    // Going truly BACK (the attributed tier is upstream of where the user was).
    expect(isGoingBack(s)).toBe(true);
  });

  it('docsLoaded threads the new revision logs + diffs and clears "will refresh"', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery'), doc('vision')], catalog: null },
      { type: 'openReview', kind: 'vision' },
      {
        type: 'frame',
        frame: {
          event: 'revisions',
          data: {
            revisions: [
              { tier: 'discovery', reason: 'direct' },
              { tier: 'vision', reason: 'cascade' },
            ],
            gate: 'discovery',
          },
        },
      },
      // The hook re-fetches the seam and threads the forward logs.
      {
        type: 'docsLoaded',
        docs: [doc('discovery'), doc('vision')],
        revisions: {
          discovery: [revDto(2, 'direct'), revDto(1, 'created')],
          vision: [revDto(2, 'cascade'), revDto(1, 'created')],
        },
      },
    ]);
    expect(s.staleKinds).toEqual([]);
    expect(willRefreshKinds(s)).toEqual([]); // bodies landed → no longer refreshing
    expect(activeRevisions(s).map((v) => v.version)).toEqual([2, 1]);
    expect(activeRevisions(s)[0]!.changeKind).toBe('direct');
  });

  it('moving forward (Continue → Back) clears the cascade — nothing is locked', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery'), doc('vision')] },
      { type: 'openReview', kind: 'vision' },
      {
        type: 'frame',
        frame: {
          event: 'revisions',
          data: { revisions: [{ tier: 'discovery', reason: 'direct' }], gate: 'discovery' },
        },
      },
      { type: 'backToHub' },
    ]);
    expect(s.cascade).toBeNull();
    expect(s.view).toBe('hub');
    expect(willRefreshKinds(s)).toEqual([]);
  });

  it('a fresh user reaction supersedes a prior cascade banner', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery')] },
      {
        type: 'frame',
        frame: {
          event: 'revisions',
          data: { revisions: [{ tier: 'discovery', reason: 'direct' }], gate: 'discovery' },
        },
      },
      { type: 'userTurn', text: 'actually, change the audience' },
    ]);
    expect(s.cascade).toBeNull();
  });

  it('there is NO rollback/restore action — the log is forward-only by construction', () => {
    // The action union admits no rollback/restore/revert/undo; a dispatched
    // "rollback" hits the reducer's default branch and is a no-op (the forward-only
    // guarantee — undo is only ever a new forward revision the user asks for).
    const before = run([{ type: 'docsLoaded', docs: [doc('discovery')] }]);
    const after = reduceDiscovery(before, { type: 'rollback' } as never);
    expect(after).toEqual(before);
  });
});

describe('reduceDiscovery — errors', () => {
  it('an error frame stops streaming and records the code', () => {
    const s = run([
      { type: 'userTurn', text: 'hi' },
      {
        type: 'frame',
        frame: { event: 'error', data: { code: 'MOTIR_AI_TIMEOUT', message: 'slow' } },
      },
    ]);
    expect(s.isStreaming).toBe(false);
    expect(s.error).toEqual({ code: 'MOTIR_AI_TIMEOUT', message: 'slow' });
  });

  it('streamError + dismissError clear cleanly', () => {
    const s = run([
      { type: 'userTurn', text: 'hi' },
      { type: 'streamError', code: 'NETWORK' },
      { type: 'dismissError' },
    ]);
    expect(s.error).toBeNull();
    expect(s.isStreaming).toBe(false);
  });
});

describe('reduceDiscovery — hydrate (resume across visits)', () => {
  it('a fresh project hydrates to an empty hub', () => {
    const s = run([{ type: 'hydrate', session: null, docs: [], catalog: null }]);
    expect(s.view).toBe('hub');
    expect(s.producedKinds).toEqual([]);
    expect(s.activeKind).toBeNull();
  });

  // MOTIR-1487: the loop starts `hydrating` (the resume read is in flight — the
  // real current step is not yet known), and both settle actions clear it so the
  // shell can stop showing "Resuming…" and paint the correct step.
  it('starts hydrating and clears it on hydrate / hydrateSettled', () => {
    expect(initialDiscoveryState().hydrating).toBe(true);
    expect(run([{ type: 'hydrate', session: null, docs: [], catalog: null }]).hydrating).toBe(
      false,
    );
    expect(
      run([
        {
          type: 'hydrate',
          session: {
            classification: 'startup',
            platform: 'web',
            validationTiming: null,
            currentGate: 'feasibility',
            status: 'active',
          },
          docs: [doc('discovery'), doc('vision'), doc('feasibility')],
          catalog: null,
        },
      ]).hydrating,
    ).toBe(false);
    expect(run([{ type: 'hydrateSettled' }]).hydrating).toBe(false);
  });

  it('resumes INTO the review gate the session parks at', () => {
    const s = run([
      {
        type: 'hydrate',
        session: {
          classification: 'startup',
          platform: 'web',
          validationTiming: null,
          currentGate: 'vision',
          status: 'active',
        },
        docs: [doc('discovery'), doc('vision')],
        catalog: null,
      },
    ]);
    expect(s.view).toBe('review');
    expect(s.activeKind).toBe('vision');
    expect(s.producedKinds).toEqual(['discovery', 'vision']);
  });

  it('resumes the validate-early gate onto the validation doc with the ask parked', () => {
    const s = run([
      {
        type: 'hydrate',
        session: {
          classification: null,
          platform: null,
          validationTiming: 'standard',
          currentGate: 'validate_early',
          status: 'active',
        },
        docs: [doc('discovery'), doc('vision'), doc('feasibility'), doc('validation')],
        catalog: null,
      },
    ]);
    expect(s.activeKind).toBe('validation');
    expect(s.view).toBe('review');
    expect(s.pendingAsk).toEqual({ recommendation: '' });
  });

  it('a completed session resumes to the hub with no ask', () => {
    const s = run([
      {
        type: 'hydrate',
        session: {
          classification: 'startup',
          platform: 'web',
          validationTiming: 'standard',
          currentGate: null,
          status: 'tiers_complete',
        },
        docs: [doc('discovery'), doc('vision')],
        catalog: null,
      },
    ]);
    expect(s.view).toBe('hub');
    expect(s.pendingAsk).toBeNull();
    expect(isTiersComplete(s)).toBe(true);
  });
});

describe('reduceDiscovery — feature catalog (folded into vision, 7.3.79)', () => {
  it('initial state has a null catalog', () => {
    expect(initialDiscoveryState().catalog).toBeNull();
  });

  it('hydrate installs the catalog from the resumed pre-plan read', () => {
    const s = run([
      {
        type: 'hydrate',
        session: {
          classification: 'startup',
          platform: 'web',
          validationTiming: null,
          currentGate: 'vision',
          status: 'active',
        },
        docs: [doc('discovery'), doc('vision')],
        catalog: catalog(),
      },
    ]);
    expect(s.catalog?.categories[0]?.title).toBe('Work Items');
  });

  it('docsLoaded refreshes the catalog from the authoritative re-read (vision (re)drafted it)', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery')], catalog: null },
      { type: 'docsLoaded', docs: [doc('vision')], catalog: catalog('Updated') },
    ]);
    expect(s.catalog?.categories[0]?.title).toBe('Updated');
  });

  it('a null catalog on re-read clears a stale one (forward-truthful)', () => {
    const seeded = run([{ type: 'docsLoaded', docs: [doc('vision')], catalog: catalog() }]);
    const cleared = reduceDiscovery(seeded, {
      type: 'docsLoaded',
      docs: [doc('vision')],
      catalog: null,
    });
    expect(cleared.catalog).toBeNull();
  });
});

describe('shouldShowDesignStep (the 7.3.69 design-phase gate)', () => {
  it('shows the design step for web / desktop projects', () => {
    expect(shouldShowDesignStep('web')).toBe(true);
    expect(shouldShowDesignStep('desktop')).toBe(true);
  });

  it('hides it for mobile / other projects', () => {
    expect(shouldShowDesignStep('mobile')).toBe(false);
    expect(shouldShowDesignStep('other')).toBe(false);
  });

  it('defaults to showing it when the platform is not yet inferred (null) or unknown', () => {
    expect(shouldShowDesignStep(null)).toBe(true);
    expect(shouldShowDesignStep('vr')).toBe(true);
  });
});
