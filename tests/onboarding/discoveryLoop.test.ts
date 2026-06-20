import { describe, expect, it } from 'vitest';
import type { DirectionDocView } from '@/lib/onboarding/directionDoc';
import {
  type DiscoveryState,
  activeDoc,
  initialDiscoveryState,
  isTiersComplete,
  normalizeFrame,
  reduceDiscovery,
} from '@/lib/onboarding/discoveryLoop';

const doc = (kind: DirectionDocView['kind'], body = `# ${kind}\n\nbody`): DirectionDocView => ({
  kind,
  contentMd: body,
  version: 1,
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
      { type: 'docsLoaded', docs: [doc('discovery')] },
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
      { type: 'docsLoaded', docs: [doc('discovery')] },
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

describe('reduceDiscovery — revisions are forward-only (cascade-back is 1179)', () => {
  it('a revisions frame marks affected tiers stale but does NOT change the view', () => {
    const s = run([
      { type: 'docsLoaded', docs: [doc('discovery'), doc('vision')] },
      { type: 'openReview', kind: 'vision' },
      {
        type: 'frame',
        frame: {
          event: 'revisions',
          data: { revisions: [{ tier: 'discovery', reason: 'reframed' }] },
        },
      },
    ]);
    expect(s.staleKinds).toEqual(['discovery']);
    expect(s.view).toBe('review'); // no auto cascade-back routing
    expect(s.activeKind).toBe('vision');
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
    const s = run([{ type: 'hydrate', session: null, docs: [] }]);
    expect(s.view).toBe('hub');
    expect(s.producedKinds).toEqual([]);
    expect(s.activeKind).toBeNull();
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
      },
    ]);
    expect(s.view).toBe('hub');
    expect(s.pendingAsk).toBeNull();
    expect(isTiersComplete(s)).toBe(true);
  });
});
