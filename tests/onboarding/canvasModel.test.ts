import { describe, expect, it } from 'vitest';
import { buildStations, captureLines, STATION_ORDER } from '@/lib/onboarding/canvasModel';
import { type DiscoveryState, initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';

function state(overrides: Partial<DiscoveryState>): DiscoveryState {
  return { ...initialDiscoveryState(), ...overrides };
}
function stateOf(kinds: DirectionDocKind[], over: Partial<DiscoveryState> = {}) {
  return state({ producedKinds: kinds, ...over });
}

describe('buildStations', () => {
  it('lists the four tiers then the design + plan forward slots', () => {
    expect(STATION_ORDER).toEqual([
      'discovery',
      'vision',
      'feasibility',
      'validation',
      'design',
      'plan',
    ]);
    const s = buildStations(initialDiscoveryState());
    expect(s.map((x) => x.kind)).toEqual([
      'discovery',
      'vision',
      'feasibility',
      'validation',
      'design',
      'plan',
    ]);
  });

  it('marks produced tiers done, the frontier active, the rest upcoming', () => {
    const s = buildStations(stateOf(['discovery', 'vision'], { activeKind: 'vision' }));
    const by = Object.fromEntries(s.map((x) => [x.kind, x.state]));
    expect(by.discovery).toBe('done');
    expect(by.vision).toBe('active'); // the frontier
    expect(by.feasibility).toBe('upcoming');
    expect(by.validation).toBe('upcoming');
    expect(by.design).toBe('upcoming');
    expect(by.plan).toBe('upcoming');
  });

  it('parks the validation tier as "deciding" when the blocking ask is up', () => {
    const s = buildStations(
      stateOf(['discovery', 'vision', 'feasibility', 'validation'], {
        pendingAsk: { recommendation: 'prove it' },
      }),
    );
    const by = Object.fromEntries(s.map((x) => [x.kind, x.state]));
    expect(by.validation).toBe('deciding');
    expect(by.feasibility).toBe('done');
  });

  it('flags optional tiers + design, and makes produced tiers openable', () => {
    const s = buildStations(stateOf(['discovery']));
    const find = (k: string) => s.find((x) => x.kind === k)!;
    expect(find('feasibility').optional).toBe(true);
    expect(find('validation').optional).toBe(true);
    expect(find('design').optional).toBe(true);
    expect(find('discovery').optional).toBe(false);
    expect(find('discovery').openable).toBe(true);
    expect(find('vision').openable).toBe(false); // not produced yet
  });

  it('makes the design station active once the tiers are complete', () => {
    const s = buildStations(
      stateOf(['discovery', 'vision', 'feasibility', 'validation'], {
        session: { ...initialDiscoveryState().session, status: 'tiers_complete' },
      }),
    );
    expect(s.find((x) => x.kind === 'design')!.state).toBe('active');
  });
});

describe('captureLines', () => {
  it('extracts the first meaningful lines, stripping title, headings and emphasis', () => {
    const md =
      '# Discovery (Tier 1)\n\n## 1. What\n\n**Send** and track invoices.\n\nChase late payers.';
    expect(captureLines(md)).toEqual(['Send and track invoices.', 'Chase late payers.']);
  });

  it('drops list markers and clamps long lines', () => {
    const long = 'x'.repeat(150);
    const md = `- ${long}`;
    const out = captureLines(md, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith('…')).toBe(true);
    expect(out[0]!.length).toBe(100);
  });

  it('returns [] for an empty or heading-only body', () => {
    expect(captureLines('')).toEqual([]);
    expect(captureLines(undefined)).toEqual([]);
    expect(captureLines('# Title\n\n## Section')).toEqual([]);
  });
});
