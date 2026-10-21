import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_TYPE_IN,
  TRANSITION_SLOW_MS,
  TYPED_FIELDS,
  TYPEWRITER_CAP_MS,
  TYPEWRITER_CHAR_INTERVAL_MS,
  finishTypeIn,
  foldTypeIn,
  isUnwritten,
  parseCssTime,
  startTypeIn,
  typeInPhase,
  typedLength,
  unwrittenFields,
} from '@/lib/planning/typeIn';
import { planReviewItem } from '../helpers/planReview';

// The typewriter's pure half (MOTIR-8595; design Part XXVIII §28.6 Table C).

describe('isUnwritten / unwrittenFields', () => {
  it('null, undefined and blank strings are unwritten; anything else is written', () => {
    expect(isUnwritten(null)).toBe(true);
    expect(isUnwritten(undefined)).toBe(true);
    expect(isUnwritten('')).toBe(true);
    expect(isUnwritten('  \n ')).toBe(true);
    expect(isUnwritten('x')).toBe(false);
    expect(isUnwritten(0)).toBe(false);
  });

  it('reads the review item, and only the three text fields type (the priority default trap)', () => {
    const item = planReviewItem({ title: 'Named', descriptionMd: null, explanationMd: ' ' });
    expect([...unwrittenFields(item)]).toEqual(['descriptionMd', 'explanationMd']);
    // A null priority is NOT a typeable field: Table C has the rail scalars simply appear.
    expect(unwrittenFields(planReviewItem({ priority: null })).has('title')).toBe(false);
    expect(TYPED_FIELDS).toEqual(['title', 'descriptionMd', 'explanationMd']);
  });
});

describe('typedLength — pace, cap, never over length', () => {
  it('types at the pace while the field fits inside the cap', () => {
    expect(typedLength(10, 0)).toBe(0);
    expect(typedLength(10, 36)).toBe(3);
    expect(typedLength(10, 120)).toBe(10);
    expect(typedLength(10, 10_000)).toBe(10);
  });

  it('a field longer than cap ÷ pace types faster and lands at the cap', () => {
    const total = 1000;
    expect(typedLength(total, TYPEWRITER_CAP_MS / 2)).toBe(500);
    expect(typedLength(total, TYPEWRITER_CAP_MS - 1)).toBeLessThan(total);
    expect(typedLength(total, TYPEWRITER_CAP_MS)).toBe(total);
  });

  it('never exceeds the total and is zero for an empty field', () => {
    for (const ms of [-5, 0, 1, 37, 400, 749, 750, 99_999]) {
      const n = typedLength(137, ms);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(137);
    }
    expect(typedLength(0, 500)).toBe(0);
  });

  it('parses CSS times', () => {
    expect(parseCssTime('12ms')).toBe(12);
    expect(parseCssTime(' 0.25s ')).toBe(250);
    expect(parseCssTime('')).toBeNull();
    expect(parseCssTime('calc(1ms)')).toBeNull();
  });
});

describe('the constants equal the design tokens', () => {
  const globals = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
  const theme = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

  it('--typewriter-char-interval', () => {
    const m = /--typewriter-char-interval:\s*([^;]+);/.exec(globals);
    expect(m && parseCssTime(m[1]!)).toBe(TYPEWRITER_CHAR_INTERVAL_MS);
  });

  it('the cap is calc(var(--transition-slow) * 3) over the base --transition-slow', () => {
    const m = /@theme\s*\{[\s\S]*?--transition-slow:\s*([^;]+);/.exec(theme);
    expect(m && parseCssTime(m[1]!)).toBe(TRANSITION_SLOW_MS);
    expect(TYPEWRITER_CAP_MS).toBe(TRANSITION_SLOW_MS * 3);
  });
});

describe('the run — one open, reading order, changes shown final', () => {
  const armed = new Set(['title', 'descriptionMd', 'explanationMd'] as const);

  it('nothing armed is no run', () => {
    expect(startTypeIn(null)).toBe(NO_TYPE_IN);
    expect(startTypeIn(new Set())).toBe(NO_TYPE_IN);
  });

  it('arrivals on one snapshot queue in reading order; the head types; finish hands over', () => {
    let run = startTypeIn(armed);
    expect(typeInPhase(run, 'descriptionMd')).toBe('pending');
    run = foldTypeIn(run, { explanationMd: 'why', descriptionMd: 'body', title: '' }, true);
    expect(run.queue).toEqual(['descriptionMd', 'explanationMd']);
    expect(typeInPhase(run, 'descriptionMd')).toBe('typing');
    expect(typeInPhase(run, 'explanationMd')).toBe('queued');
    expect(typeInPhase(run, 'title')).toBe('pending');
    run = finishTypeIn(run, 'descriptionMd');
    expect(typeInPhase(run, 'descriptionMd')).toBe('final');
    expect(typeInPhase(run, 'explanationMd')).toBe('typing');
  });

  it('returns the same object when nothing changed', () => {
    const run = foldTypeIn(startTypeIn(armed), { descriptionMd: 'body' }, true);
    expect(foldTypeIn(run, { descriptionMd: 'body' }, true)).toBe(run);
  });

  it('a typing or queued value that changes is shown final at once, never re-typed', () => {
    let run = foldTypeIn(startTypeIn(armed), { descriptionMd: 'a', explanationMd: 'b' }, true);
    run = foldTypeIn(run, { descriptionMd: 'a2', explanationMd: 'b' }, true);
    expect(typeInPhase(run, 'descriptionMd')).toBe('final');
    expect(typeInPhase(run, 'explanationMd')).toBe('typing');
    run = foldTypeIn(run, { descriptionMd: 'a3', explanationMd: 'b' }, true);
    expect(typeInPhase(run, 'descriptionMd')).toBe('final');
  });

  it('disabled (the plan finished, reduced motion) shows everything at once', () => {
    const run = foldTypeIn(startTypeIn(armed), { descriptionMd: 'a' }, true);
    const off = foldTypeIn(run, { descriptionMd: 'a' }, false);
    expect(off).toBe(NO_TYPE_IN);
    for (const f of TYPED_FIELDS) expect(typeInPhase(off, f)).toBe('final');
    expect(foldTypeIn(NO_TYPE_IN, {}, false)).toBe(NO_TYPE_IN);
  });
});
