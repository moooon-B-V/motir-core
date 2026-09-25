import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DURATIONS,
  diffSnapshots,
  edgeKey,
  enterDelayMs,
  isQuietDiff,
  parseDurationMs,
  planStages,
  readDurations,
  stageMs,
  type MotionDiff,
} from '@/lib/planning/canvasMotion';

// The PURE half of the canvas motion (MOTIR-6297 · Part XXIII §23.3–§23.4): what a
// snapshot pair IS, and the order a change plays in.

const a = { id: 'a', x: 0, y: 0 };
const b = { id: 'b', x: 300, y: 0 };
const c = { id: 'c', x: 600, y: 0 };
const ab = { from: 'a', to: 'b' };
const bc = { from: 'b', to: 'c' };

const empty: MotionDiff = {
  enters: [],
  exits: [],
  movers: [],
  cues: [],
  edgeEnters: [],
  edgeExits: [],
  hiddenEdges: [],
  dirty: false,
};

describe('diffSnapshots', () => {
  it('an id that appears is an ARRIVAL, one that disappears an EXIT, a changed edge set a REWIRE', () => {
    const d = diffSnapshots({ nodes: [a, b], edges: [ab] }, { nodes: [b, c], edges: [bc] });
    expect(d.enters).toEqual(['c']);
    expect(d.exits).toEqual(['a']);
    expect(d.edgeEnters).toEqual(['b~c']);
    expect(d.edgeExits).toEqual(['a~b']);
    expect(d.movers).toEqual([]);
  });

  it('a kept id whose cell changed is a RE-LAY, and its kept arrows are hidden for the glide', () => {
    const d = diffSnapshots(
      { nodes: [a, b, c], edges: [ab, bc] },
      { nodes: [a, { ...b, y: 200 }, c], edges: [ab, bc, { from: 'a', to: 'c' }] },
    );
    expect(d.movers).toEqual(['b']);
    expect(d.hiddenEdges).toEqual(['a~b', 'b~c']);
    expect(d.edgeEnters).toEqual(['a~c']); // new, so it draws in — not "hidden"
  });

  it('a changed changeKey on a kept id is a DEEPEN; absent → present counts', () => {
    const d = diffSnapshots(
      { nodes: [a, { ...b, changeKey: 'v1' }], edges: [] },
      {
        nodes: [
          { ...a, changeKey: 'v1' },
          { ...b, changeKey: 'v1' },
        ],
        edges: [],
      },
    );
    expect(d.cues).toEqual(['a']);
  });

  it('a move the reader made by DRAGGING is not a re-lay — it only dirties the baseline', () => {
    const d = diffSnapshots(
      { nodes: [a, b], edges: [ab] },
      { nodes: [a, { ...b, x: 999 }], edges: [ab] },
      new Set(['b']),
    );
    expect(d.movers).toEqual([]);
    expect(d.hiddenEdges).toEqual([]);
    expect(d.dirty).toBe(true);
    expect(isQuietDiff(d)).toBe(true);
  });

  it('identical content is quiet and clean; duplicate edges collapse to one key', () => {
    const d = diffSnapshots(
      { nodes: [a, b], edges: [ab] },
      { nodes: [{ ...a }, { ...b }], edges: [{ ...ab }, { ...ab, variant: 'x' } as typeof ab] },
    );
    expect(d).toEqual(empty);
    expect(isQuietDiff(d)).toBe(true);
    const dup = diffSnapshots({ nodes: [a, b], edges: [] }, { nodes: [a, b], edges: [ab, ab] });
    expect(dup.edgeEnters).toEqual(['a~b']);
  });

  it('edgeKey is the two ends', () => {
    expect(edgeKey(ab)).toBe('a~b');
  });
});

describe('isQuietDiff', () => {
  it('any one change makes it loud', () => {
    for (const k of ['enters', 'exits', 'movers', 'cues', 'edgeEnters', 'edgeExits'] as const) {
      expect(isQuietDiff({ ...empty, [k]: ['x'] }), k).toBe(false);
    }
  });
});

describe('planStages — a change is STAGED (§23.3)', () => {
  it('orders out → glide → enter → arrows, and only the stages the change needs', () => {
    expect(
      planStages({ ...empty, exits: ['a'], movers: ['b'], enters: ['c'], edgeEnters: ['x'] }),
    ).toEqual(['out', 'glide', 'enter', 'arrows']);
    expect(planStages({ ...empty, enters: ['c'] })).toEqual(['enter']);
    expect(planStages({ ...empty, exits: ['a'] })).toEqual(['out']);
    expect(planStages({ ...empty, movers: ['b'], hiddenEdges: ['a~b'] })).toEqual([
      'out',
      'glide',
      'arrows',
    ]);
    // a pure rewire: the old arrow fades from the start, the new one draws at once
    expect(planStages({ ...empty, edgeExits: ['a~b'], edgeEnters: ['a~c'] })).toEqual(['arrows']);
    // a deepen and a removed arrow play outside the stages
    expect(planStages({ ...empty, cues: ['a'], edgeExits: ['a~b'] })).toEqual([]);
  });
});

describe('stageMs — the design system tokens, the stagger, the cap', () => {
  const dur = { fast: 10, base: 20, slow: 30 };
  it('times each stage', () => {
    expect(stageMs('out', { ...empty, exits: ['a'] }, dur)).toBe(20);
    expect(stageMs('out', { ...empty, movers: ['a'] }, dur)).toBe(10);
    expect(stageMs('glide', empty, dur)).toBe(30);
    expect(stageMs('enter', { ...empty, enters: ['a'] }, dur)).toBe(30);
    expect(stageMs('enter', { ...empty, enters: ['a', 'b', 'c'] }, dur)).toBe(30 + 80);
    expect(stageMs('enter', { ...empty, enters: 'abcdefghij'.split('') }, dur)).toBe(30 + 160);
    expect(stageMs('arrows', empty, dur)).toBe(20);
  });
  it('staggers arrivals 40ms apart, capped at 160ms', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(enterDelayMs)).toEqual([0, 40, 80, 120, 160, 160, 160]);
  });
});

describe('parseDurationMs / readDurations', () => {
  it('reads ms and s, and falls back on anything else', () => {
    expect(parseDurationMs('150ms', 1)).toBe(150);
    expect(parseDurationMs(' .25s ', 1)).toBe(250);
    expect(parseDurationMs('2S', 1)).toBe(2000);
    expect(parseDurationMs('', 7)).toBe(7);
    expect(parseDurationMs(null, 7)).toBe(7);
    expect(parseDurationMs('fast', 7)).toBe(7);
    expect(parseDurationMs('-5ms', 7)).toBe(7);
    expect(parseDurationMs('1.2.3ms', 7)).toBe(7);
  });
  it('resolves the three tokens, defaulting to the theme values', () => {
    const style = {
      getPropertyValue: (p: string) =>
        ({ '--transition-fast': '40ms', '--transition-duration': '60ms' })[p] ?? '',
    };
    expect(readDurations(style)).toEqual({ fast: 40, base: 60, slow: DEFAULT_DURATIONS.slow });
    expect(readDurations(null)).toEqual(DEFAULT_DURATIONS);
  });
});
