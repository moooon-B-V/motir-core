// @vitest-environment happy-dom
//
// `PlanningCanvas`'s opt-in MOTION (MOTIR-6297 · `design/ai-planning/design-notes.md`
// Part XXIII §23.3–§23.5).
//
// happy-dom evaluates no media query and runs no CSS animation, so this pins the
// STATE MACHINE the stylesheet keys off — which node / edge carries which
// `data-motion` and class, for a given before → after snapshot pair, stage by stage
// on fake timers — plus a static read of `app/globals.css` that every new animation
// rule sits behind `prefers-reduced-motion: no-preference`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';

// The theme defaults (`lib/planning/canvasMotion` DEFAULT_DURATIONS): happy-dom
// resolves no custom property, so the canvas falls back to exactly these.
const FAST = 100;
const BASE = 150;
const SLOW = 250;

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.useFakeTimers();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduced : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const A: CanvasNode = { id: 'a', x: 0, y: 0 };
const B: CanvasNode = { id: 'b', x: 300, y: 0 };
const C: CanvasNode = { id: 'c', x: 300, y: 300 };
const AB: CanvasEdge = { from: 'a', to: 'b' };
const BC: CanvasEdge = { from: 'b', to: 'c', variant: 'pending' };
const renderNode = (n: CanvasNode) => (
  <div>
    Node {n.id}
    <span data-testid={`inner-${n.id}`} />
  </div>
);

function mount(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  opts: { motion?: boolean } = { motion: true },
) {
  const motion = opts.motion;
  const r = render(
    <PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} motion={motion} />,
  );
  return (next: CanvasNode[], nextEdges: CanvasEdge[], nextMotion: boolean | undefined = motion) =>
    r.rerender(
      <PlanningCanvas nodes={next} edges={nextEdges} renderNode={renderNode} motion={nextMotion} />,
    );
}

const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const nodesById = (id: string) => document.querySelectorAll(`[data-node-id="${id}"]`);
const motionOf = (el: Element | null) => el?.getAttribute('data-motion') ?? null;
const cls = (el: Element | null) => el?.getAttribute('class') ?? '';
const livePaths = () => [...screen.getByTestId('canvas-edges').querySelectorAll('path')];
const exitPaths = () => [
  ...(screen.queryByTestId('canvas-edges-exit')?.querySelectorAll('path') ?? []),
];
const anyMotion = () => document.querySelectorAll('[data-motion]').length;
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('PlanningCanvas motion — what plays nothing', () => {
  it('the FIRST read plays nothing: a pane opening on a populated level draws it settled', () => {
    mount([A, B, C], [AB, BC]);
    expect(anyMotion()).toBe(0);
    expect(screen.queryByTestId('canvas-edges-exit')).toBeNull();
    expect(cls(node('a'))).not.toMatch(/canvas-(node|motion)/);
  });

  it('a read that changes NOTHING plays nothing — fresh objects, the same snapshot', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([{ ...A }, { ...B }, { ...C }], [{ ...AB }, { ...BC }]);
    expect(anyMotion()).toBe(0);
    tick(5000);
    expect(anyMotion()).toBe(0);
  });

  it('a variant change is not motion (an edge is identified by its two ends)', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([A, B, C], [AB, { ...BC, variant: 'firm' }]);
    expect(anyMotion()).toBe(0);
  });
});

describe('PlanningCanvas motion — ARRIVAL', () => {
  it('a new node carries data-motion="enter" on its first render, then its arrows draw in', () => {
    const update = mount([A, B], [AB]);
    const D: CanvasNode = { id: 'd', x: 600, y: 0 };
    update([A, B, D], [AB, { from: 'b', to: 'd' }]);

    const d = node('d')!;
    expect(motionOf(d)).toBe('enter');
    // no glide in this batch, so the entrance is the first stage
    expect(cls(d)).toContain('canvas-node--enter');
    expect(d.style.animationDelay).toBe('0ms');
    expect(motionOf(node('a'))).toBeNull();
    // its arrow waits for the card to land (§23.6)
    const [ab, bd] = livePaths();
    expect(motionOf(ab!)).toBeNull();
    expect(motionOf(bd!)).toBe('enter');
    expect(cls(bd!)).toContain('canvas-motion-held');

    tick(SLOW);
    expect(cls(livePaths()[1]!)).toContain('canvas-edge--enter');
    expect(cls(livePaths()[1]!)).not.toContain('canvas-motion-held');

    tick(BASE);
    expect(anyMotion()).toBe(0);
    expect(cls(node('d'))).not.toContain('canvas-node--enter');
  });

  it('a batch STAGGERS 40ms apart, capped at 160ms, and the stage waits for the last', () => {
    const update = mount([A], []);
    const batch = ['d', 'e', 'f', 'g', 'h', 'i'].map((id, i) => ({ id, x: i * 300, y: 400 }));
    update([A, ...batch], [{ from: 'a', to: 'd' }]);
    expect(batch.map((n) => node(n.id)!.style.animationDelay)).toEqual([
      '0ms',
      '40ms',
      '80ms',
      '120ms',
      '160ms',
      '160ms',
    ]);
    tick(SLOW + 160 - 1);
    expect(cls(livePaths()[0]!)).toContain('canvas-motion-held');
    tick(1);
    expect(cls(livePaths()[0]!)).toContain('canvas-edge--enter');
  });
});

describe('PlanningCanvas motion — EXIT', () => {
  it('a removed node is RETAINED with data-motion="exit" for its duration + 50ms, then gone', () => {
    const update = mount([A, B, C], [AB, BC]);
    const before = node('c');
    update([A, B], [AB]);

    const c = node('c');
    expect(c).toBe(before); // the same element — retained, not remounted
    expect(motionOf(c)).toBe('exit');
    expect(cls(c)).toContain('canvas-node--exit');
    // the removed edge fades in its OWN layer, so the live count is the edge count
    expect(livePaths()).toHaveLength(1);
    expect(exitPaths()).toHaveLength(1);
    expect(motionOf(exitPaths()[0]!)).toBe('exit');
    expect(cls(exitPaths()[0]!)).toContain('canvas-edge--exit');

    tick(BASE + 50 - 1);
    expect(node('c')).not.toBeNull();
    expect(exitPaths()).toHaveLength(1);
    tick(1);
    expect(node('c')).toBeNull();
    expect(screen.queryByTestId('canvas-edges-exit')).toBeNull();
    expect(anyMotion()).toBe(0);
  });

  it('is removed on its own animationend — not on one bubbling up from the card inside', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([A, B], [AB]);
    fireEvent.animationEnd(screen.getByTestId('inner-c'));
    expect(node('c')).not.toBeNull();
    fireEvent.animationEnd(node('c')!);
    expect(node('c')).toBeNull();
    fireEvent.animationEnd(exitPaths()[0]!);
    expect(screen.queryByTestId('canvas-edges-exit')).toBeNull();
    // the fallback timer that would have removed them is cleared, not left to fire
    tick(1000);
    expect(node('c')).toBeNull();
  });

  it('keeps its DOM place, and a focused card that leaves hands focus to the canvas', () => {
    const update = mount([A, B, C], [AB, BC]);
    node('b')!.focus();
    expect(document.activeElement).toBe(node('b'));
    update([A, C], []);
    const ids = [...document.querySelectorAll('[data-node-id]')].map((e) =>
      e.getAttribute('data-node-id'),
    );
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(document.activeElement).toBe(node('b'));
    tick(BASE + 50);
    expect(node('b')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('application'));
  });

  it('an id that comes BACK while it is still leaving is drawn once, live, as an arrival', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([A, B], [AB]);
    update([A, B, C], [AB, BC]); // lands mid-flight: waits for the exit stage
    expect(motionOf(node('c'))).toBe('exit');
    tick(BASE);
    expect(nodesById('c')).toHaveLength(1);
    expect(motionOf(node('c'))).toBe('enter');
    tick(BASE + 50);
    expect(nodesById('c')).toHaveLength(1);
  });
});

describe('PlanningCanvas motion — RE-LAY (the glide) and the arrows around it', () => {
  it('a moved node keeps its element, waits, then GLIDES; its arrows hide and come back', () => {
    const update = mount([A, B, C], [AB, BC]);
    const before = node('b');
    update([A, { ...B, x: 600 }, C], [AB, BC]);

    const b = node('b')!;
    expect(b).toBe(before);
    expect(motionOf(b)).toBe('relay');
    // stage 1 (`out`, --transition-fast): its arrows fade; the card holds its old cell
    expect(b.style.left).toBe('300px');
    expect(cls(b)).not.toContain('canvas-node--relay');
    for (const p of livePaths()) {
      expect(motionOf(p)).toBe('relay');
      expect(cls(p)).toContain('canvas-edge--hide');
    }

    tick(FAST);
    // stage 2 (`glide`, --transition-slow): the transition class + the new cell
    expect(node('b')).toBe(before);
    expect(node('b')!.style.left).toBe('600px');
    expect(cls(node('b'))).toContain('canvas-node--relay');
    expect(cls(livePaths()[0]!)).toContain('canvas-edge--hide');

    tick(SLOW);
    // stage 3 (`arrows`): back in, on the final route
    expect(cls(node('b'))).not.toContain('canvas-node--relay');
    expect(motionOf(node('b'))).toBeNull();
    for (const p of livePaths()) expect(cls(p)).toContain('canvas-edge--enter');

    tick(BASE);
    expect(anyMotion()).toBe(0);
  });

  it('an EXIT runs the other way: the card leaves, THEN the rest glide into the gap', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([{ ...B, x: 0 }, C], [BC]);
    expect(motionOf(node('a'))).toBe('exit');
    expect(node('b')!.style.left).toBe('300px'); // held while `a` fades (--transition-duration)
    tick(BASE - 1);
    expect(node('b')!.style.left).toBe('300px');
    tick(1);
    expect(node('b')!.style.left).toBe('0px');
    expect(cls(node('b'))).toContain('canvas-node--relay');
  });

  it('with a glide AND an arrival, the arrival waits for the glide', () => {
    const update = mount([A, B], [AB]);
    const D: CanvasNode = { id: 'd', x: 300, y: 0 };
    update([A, { ...B, x: 600 }, D], [AB]);
    expect(motionOf(node('d'))).toBe('enter');
    expect(cls(node('d'))).toContain('canvas-motion-held');
    tick(FAST); // out → glide
    expect(cls(node('d'))).toContain('canvas-motion-held');
    tick(SLOW); // glide → enter
    expect(cls(node('d'))).toContain('canvas-node--enter');
    expect(cls(node('d'))).not.toContain('canvas-motion-held');
  });
});

describe('PlanningCanvas motion — REWIRE', () => {
  it('the removed arrow fades and the new one draws in AT THE SAME TIME', () => {
    const update = mount([A, B, C], [AB]);
    update([A, B, C], [{ from: 'a', to: 'c' }]);
    expect(exitPaths()).toHaveLength(1);
    expect(motionOf(exitPaths()[0]!)).toBe('exit');
    expect(livePaths()).toHaveLength(1);
    expect(motionOf(livePaths()[0]!)).toBe('enter');
    expect(cls(livePaths()[0]!)).toContain('canvas-edge--enter');
    expect(anyMotion()).toBe(2); // no card moves
  });
});

describe('PlanningCanvas motion — DEEPEN', () => {
  it('a changed changeKey on a kept id holds the outline 600ms, then fades it', () => {
    const update = mount([{ ...A, changeKey: 'v1' }, B], [AB]);
    update([{ ...A, changeKey: 'v2' }, B], [AB]);
    expect(motionOf(node('a'))).toBe('cue');
    expect(cls(node('a'))).toContain('canvas-node--deepened');
    expect(motionOf(node('b'))).toBeNull();
    expect(livePaths().every((p) => motionOf(p) === null)).toBe(true);
    tick(599);
    expect(cls(node('a'))).toContain('canvas-node--deepened');
    tick(1);
    expect(cls(node('a'))).toContain('canvas-node--deepened-out');
    expect(motionOf(node('a'))).toBe('cue');
    tick(SLOW);
    expect(motionOf(node('a'))).toBeNull();
    expect(cls(node('a'))).not.toContain('canvas-node--deepened');
  });
});

describe('PlanningCanvas motion — a read that lands MID-FLIGHT', () => {
  it('completes the change in flight, then plays only the difference — never replays an arrival', () => {
    const update = mount([A], []);
    const D: CanvasNode = { id: 'd', x: 300, y: 0 };
    const E: CanvasNode = { id: 'e', x: 600, y: 0 };
    update([A, D], []);
    update([A, D, E], []);
    expect(node('e')).toBeNull(); // waits for the change in flight
    expect(motionOf(node('d'))).toBe('enter');
    tick(SLOW);
    expect(motionOf(node('e'))).toBe('enter');
    expect(motionOf(node('d'))).toBeNull();
  });
});

describe('PlanningCanvas motion — REDUCED MOTION (§23.5)', () => {
  it('draws the new state at once; an arrival and a deepen hold the outline 1200ms, no fade', () => {
    reduced = true;
    const update = mount([{ ...A, changeKey: 'v1' }, B, C], [AB, BC]);
    const D: CanvasNode = { id: 'd', x: 600, y: 0 };
    update([{ ...A, changeKey: 'v2' }, { ...B, x: 900 }, D], [AB, { from: 'b', to: 'd' }]);

    // the exit and the removed edge are simply gone; the glide is a jump
    expect(node('c')).toBeNull();
    expect(screen.queryByTestId('canvas-edges-exit')).toBeNull();
    expect(node('b')!.style.left).toBe('900px');
    expect(motionOf(node('b'))).toBeNull();
    expect(
      livePaths().every((p) => motionOf(p) === null && !/canvas-(edge--|motion)/.test(cls(p))),
    ).toBe(true);
    // the outline is the whole cue
    for (const id of ['a', 'd']) {
      expect(cls(node(id))).toContain('canvas-node--deepened');
      expect(cls(node(id))).not.toContain('canvas-node--enter');
    }
    expect(motionOf(node('d'))).toBe('enter');
    expect(motionOf(node('a'))).toBe('cue');

    tick(1199);
    expect(cls(node('d'))).toContain('canvas-node--deepened');
    tick(1);
    for (const id of ['a', 'd']) {
      expect(cls(node(id))).not.toContain('canvas-node--deepened'); // not even `-out`
      expect(motionOf(node(id))).toBeNull();
    }
  });
});

describe('PlanningCanvas motion — OFF', () => {
  it('without the prop no node or edge carries data-motion or a motion class, and a removal is immediate', () => {
    const update = mount([A, B, C], [AB, BC], {}); // the prop ABSENT
    update([{ ...A, x: 50 }, B, { id: 'd', x: 0, y: 600 }], [AB, { from: 'b', to: 'd' }]);
    expect(anyMotion()).toBe(0);
    expect(node('c')).toBeNull();
    expect(screen.queryByTestId('canvas-edges-exit')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/canvas-(node|edge)--|canvas-motion-held/);
    expect(node('a')!.getAttribute('style')).toBe('left: 50px; top: 0px;');
  });

  it('turning motion OFF mid-change drops every mark; turning it back ON plays nothing', () => {
    const update = mount([A, B, C], [AB, BC]);
    update([A, B], [AB]);
    expect(motionOf(node('c'))).toBe('exit');
    update([A, B], [AB], false);
    expect(node('c')).toBeNull();
    expect(anyMotion()).toBe(0);
    update([A, B, C], [AB, BC], true);
    expect(anyMotion()).toBe(0);
    tick(5000);
    expect(anyMotion()).toBe(0);
  });

  it('renders byte-identically to motion={false} and to the pre-motion canvas', () => {
    const fixture = (motion?: boolean) => {
      const r = render(
        <PlanningCanvas
          nodes={[A, B, C]}
          edges={[AB, BC, { from: 'a', to: 'c', variant: 'cross' }]}
          renderNode={renderNode}
          selectedId="b"
          onNodeMove={() => {}}
          motion={motion}
        />,
      );
      // `useId` numbers each mount; the marker ids are the one thing that may differ.
      const html = r.container.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_ID_');
      cleanup();
      return html;
    };
    const absent = fixture();
    expect(fixture(false)).toBe(absent);
    // Recorded from `PlanningCanvas.tsx` BEFORE this card changed it.
    expect(absent).toMatchSnapshot();
  });
});

describe('app/globals.css — the motion rules sit behind `no-preference`', () => {
  const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
  const KEYFRAMES = ['canvas-node-enter', 'canvas-node-exit', 'canvas-fade-in', 'canvas-fade-out'];
  const GATED = [
    'canvas-motion-held',
    'canvas-node--enter',
    'canvas-node--exit',
    'canvas-node--relay',
    'canvas-node--deepened-out',
    'canvas-edge--enter',
    'canvas-edge--exit',
    'canvas-edge--hide',
  ];

  /** Split the stylesheet into the bodies of `no-preference` blocks and everything else. */
  function splitGate(src: string) {
    const gate = '@media (prefers-reduced-motion: no-preference)';
    let outside = '';
    const inside: string[] = [];
    let at = 0;
    for (;;) {
      const start = src.indexOf(gate, at);
      if (start < 0) break;
      outside += src.slice(at, start);
      const open = src.indexOf('{', start);
      let depth = 1;
      let i = open + 1;
      for (; depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
      }
      inside.push(src.slice(open + 1, i - 1));
      at = i;
    }
    outside += src.slice(at);
    return { outside, inside: inside.join('\n') };
  }
  const { outside, inside } = splitGate(css);
  const ruleBody = (src: string, selector: string) =>
    new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';

  it('declares the two easing constants beside the running edge', () => {
    expect(css).toMatch(/--canvas-ease-enter:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
    expect(css).toMatch(/--canvas-ease-exit:\s*cubic-bezier\(0\.3, 0, 1, 1\)/);
    expect(css.indexOf('--canvas-ease-enter')).toBeGreaterThan(css.indexOf('.canvas-edge-running'));
  });

  it('references no new keyframe outside the gate (only its own @keyframes declaration)', () => {
    for (const k of KEYFRAMES) {
      expect(css).toContain(`@keyframes ${k} `);
      const uses = outside.split(k).length - 1;
      expect(uses, k).toBe(1); // the declaration
      expect(inside, k).toMatch(new RegExp(`animation:\\s*${k}\\b`));
    }
  });

  it('every motion class lives ONLY inside the gate, timed by the tokens and eased by the constants', () => {
    for (const c of GATED) {
      expect(outside, c).not.toContain(`.${c}`);
      expect(inside, c).toContain(`.${c}`);
    }
    for (const c of GATED.filter((g) => g !== 'canvas-motion-held')) {
      const body = ruleBody(inside, c);
      expect(body, c).toMatch(/var\(--transition-(fast|duration|slow)\)/);
      expect(body, c).toMatch(/var\(--canvas-ease-(enter|exit)\)/);
      expect(body, c).not.toMatch(/\d+m?s\b/); // no hard-coded duration
    }
  });

  it('keeps the deepen OUTLINE outside the gate — a state, not a motion — in the accent ink', () => {
    const body = ruleBody(outside, 'canvas-node--deepened');
    expect(body).toMatch(/outline:\s*2px solid var\(--el-accent-on-surface\)/);
    expect(body).not.toMatch(/animation|transition/);
  });
});
