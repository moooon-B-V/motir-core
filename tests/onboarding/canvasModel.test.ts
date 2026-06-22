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

  it('anchors the first step "active" in the empty/initial state — never an all-ghosted skeleton (MOTIR-1258)', () => {
    // The state every never-onboarded project hydrates to: no tier produced,
    // session still active. The canvas must still show a current position.
    const s = buildStations(initialDiscoveryState());
    const by = Object.fromEntries(s.map((x) => [x.kind, x.state]));
    expect(by.discovery).toBe('active'); // "you are here" on the first step
    expect(by.vision).toBe('upcoming');
    expect(by.feasibility).toBe('upcoming');
    expect(by.validation).toBe('upcoming');
    expect(by.design).toBe('upcoming');
    expect(by.plan).toBe('upcoming');
    // Exactly one station is the current position — not zero (the bug), not many.
    expect(s.filter((x) => x.state === 'active' || x.state === 'deciding')).toHaveLength(1);
    // The active first step is not openable yet — there is no saved doc to re-open.
    expect(s.find((x) => x.kind === 'discovery')!.openable).toBe(false);
  });

  it('marks the tier the conductor is mid-draft on as "working" (a loading station), not "active" or "upcoming"', () => {
    // Discovery captured; the conductor is now drafting vision (no doc saved yet).
    // A mid-draft tier reads as LOADING ("Drafting now…"), never a settled pill.
    const s = buildStations(
      stateOf(['discovery'], { working: { phase: 'drafting', tier: 'vision' } }),
    );
    const by = Object.fromEntries(s.map((x) => [x.kind, x.state]));
    expect(by.discovery).toBe('done');
    expect(by.vision).toBe('working'); // loading, not "you are here"
    expect(by.feasibility).toBe('upcoming');
    // The drafting tier is the only live station; no second "you are here".
    expect(s.filter((x) => x.state === 'active')).toHaveLength(0);
    expect(s.filter((x) => x.state === 'working')).toHaveLength(1);
  });

  it('marks the first step "working" while grounding before any tier exists (loading, not "you are here")', () => {
    // Conductor is grounding with no tier yet — discovery is the loading station.
    const s = buildStations(state({ working: { phase: 'grounding', tier: null } }));
    expect(s.find((x) => x.kind === 'discovery')!.state).toBe('working');
    expect(s.filter((x) => x.state === 'active')).toHaveLength(0);
  });

  it('keeps the idle empty state "active" — only a working session shows the loading station', () => {
    // No `working` → the empty state is a settled "you are here", not loading.
    const idle = buildStations(initialDiscoveryState());
    expect(idle.find((x) => x.kind === 'discovery')!.state).toBe('active');
    expect(idle.filter((x) => x.state === 'working')).toHaveLength(0);
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
