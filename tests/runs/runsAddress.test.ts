import { describe, expect, it } from 'vitest';
import { RUNS_RUN_PARAM, RUNS_SCOPE_PARAM, parseRunsScope, runsHref } from '@/lib/runs/runsAddress';

// The `/runs` ADDRESS (Story MOTIR-5363 · design MOTIR-5402 panel 5).
//
// ⚠️ THE PROPERTY THIS FILE HOLDS IS COMPOSITION. `?scope=` and `?run=` are two
// halves of one address, and the defect it replaces wrote each literally —
// `/runs?run=<id>` to open, `/runs` to close — so a narrowed list lost its
// narrowing on the first click. Every surface spells the address through
// `runsHref`, so it is asserted here once rather than guessed at three sites.

describe('parseRunsScope — what a `?scope=` value narrows to', () => {
  it('upper-cases and trims a key, because every link the product writes is upper-case', () => {
    expect(parseRunsScope('motir-1789')).toBe('MOTIR-1789');
    expect(parseRunsScope('  MOTIR-1789 ')).toBe('MOTIR-1789');
  });

  it('narrows nothing for an absent, blank or REPEATED parameter', () => {
    expect(parseRunsScope(undefined)).toBeNull();
    expect(parseRunsScope(null)).toBeNull();
    expect(parseRunsScope('   ')).toBeNull();
    // A repeated parameter has no right answer to which one was meant.
    expect(parseRunsScope(['MOTIR-1', 'MOTIR-2'])).toBeNull();
  });
});

describe('runsHref — the two parameters compose, neither replaces the other', () => {
  it('names the parameters the design records', () => {
    expect(RUNS_SCOPE_PARAM).toBe('scope');
    expect(RUNS_RUN_PARAM).toBe('run');
  });

  it('spells every combination', () => {
    expect(runsHref()).toBe('/runs');
    // MOTIR-6335 — WHOSE runs, first, and composing with both other parameters.
    expect(runsHref({ view: 'mine' })).toBe('/runs?view=mine');
    expect(runsHref({ view: 'mine', scope: 'MOTIR-1789', run: 'r' })).toBe(
      '/runs?view=mine&scope=MOTIR-1789&run=r',
    );
    expect(runsHref({ scope: 'MOTIR-1789' })).toBe('/runs?scope=MOTIR-1789');
    expect(runsHref({ run: 'run_7f2c' })).toBe('/runs?run=run_7f2c');
    expect(runsHref({ scope: 'MOTIR-1789', run: 'run_7f2c' })).toBe(
      '/runs?scope=MOTIR-1789&run=run_7f2c',
    );
  });

  it('treats a null half as absent, so closing a run over a narrowing keeps only the scope', () => {
    expect(runsHref({ scope: 'MOTIR-1789', run: null })).toBe('/runs?scope=MOTIR-1789');
    expect(runsHref({ scope: null, run: null })).toBe('/runs');
  });

  it('encodes a value rather than trusting it — in the `%20` form the section already shipped', () => {
    // `encodeURIComponent`, not `URLSearchParams`: the run section's deep link
    // pinned `%20` for a space (MOTIR-5398), and one address keeps one spelling.
    expect(runsHref({ run: 'a b&c' })).toBe('/runs?run=a%20b%26c');
    expect(runsHref({ scope: 'PROD 7', run: 'r/1' })).toBe('/runs?scope=PROD%207&run=r%2F1');
  });
});
