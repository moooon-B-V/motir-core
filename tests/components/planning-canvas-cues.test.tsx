// @vitest-environment happy-dom
//
// `PlanningCanvas`'s DRAFTING / LAYING cue layer (Story MOTIR-7820 · MOTIR-7830;
// `design/ai-planning/design-notes.md` Part XXVI §26.6–26.8). The cue is a class
// and two children on the NODE BOX, never on the card `renderNode` returns, it is
// independent of `motion`, it composes with the motion marks, and an absent map
// leaves the DOM byte for byte as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DEFAULT_DURATIONS, EXIT_FALLBACK_SLACK_MS } from '@/lib/planning/canvasMotion';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
  type NodeCue,
  leavingCuesOf,
} from '@/components/planning/PlanningCanvas';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: false,
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
const renderNode = (n: CanvasNode) => (
  <div data-testid={`card-${n.id}`}>
    Node {n.id}
    <span data-testid={`inner-${n.id}`} />
  </div>
);
const DRAFT: NodeCue = { kind: 'drafting', label: 'Being drafted now', text: 'Drafting' };
const LAY: NodeCue = { kind: 'laying', label: 'Its children are being laid now', text: 'Laying' };

const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

function mount(
  nodes: CanvasNode[],
  nodeCues: ReadonlyMap<string, NodeCue> | null | undefined,
  motion?: boolean,
) {
  const r = render(
    <PlanningCanvas
      nodes={nodes}
      edges={[AB]}
      renderNode={renderNode}
      nodeCues={nodeCues}
      motion={motion}
    />,
  );
  return (next: CanvasNode[], nextCues = nodeCues) =>
    r.rerender(
      <PlanningCanvas
        nodes={next}
        edges={[AB]}
        renderNode={renderNode}
        nodeCues={nextCues}
        motion={motion}
      />,
    );
}

describe('PlanningCanvas — the cue layer', () => {
  it('puts data-cue and the class on the NODE BOX of each cued node, never inside the card', () => {
    mount(
      [A, B, C],
      new Map([
        ['a', DRAFT],
        ['b', DRAFT],
      ]),
    );
    for (const id of ['a', 'b']) {
      expect(box(id).getAttribute('data-cue')).toBe('drafting');
      expect(cls(box(id))).toContain('canvas-node--drafting');
      const card = screen.getByTestId(`card-${id}`);
      expect(card.querySelector('[data-cue]')).toBeNull();
      expect(card.className).not.toContain('canvas-node--');
    }
    expect(box('c').hasAttribute('data-cue')).toBe(false);
    expect(screen.getAllByTestId('canvas-cue-drafting')).toHaveLength(2);
  });

  it('names the cue: a labelled chip, tied to the box by aria-describedby — not a live region', () => {
    mount([A, B], new Map([['a', DRAFT]]));
    const chip = screen.getByRole('img', { name: 'Being drafted now' });
    expect(chip.textContent).toBe('Drafting');
    expect(box('a').getAttribute('aria-describedby')).toBe(chip.id);
    expect(chip.closest('[aria-live]')).toBeNull();
    expect(box('a').querySelector('.canvas-cue-ring')!.getAttribute('aria-hidden')).toBe('true');
    expect(box('b').hasAttribute('aria-describedby')).toBe(false);
  });

  it('a laying cue is its own kind', () => {
    mount([A, B], new Map([['b', LAY]]));
    expect(box('b').getAttribute('data-cue')).toBe('laying');
    expect(cls(box('b'))).toContain('canvas-node--laying');
    expect(screen.getByTestId('canvas-cue-laying').textContent).toBe('Laying');
  });

  it('renders with motion OFF (the plan page) — the cue is independent of motion', () => {
    mount([A, B], new Map([['a', DRAFT]]), false);
    expect(box('a').getAttribute('data-cue')).toBe('drafting');
    expect(box('a').hasAttribute('data-motion')).toBe(false);
  });

  it('composes with the deepen: a drafted card that deepens carries both classes', () => {
    const update = mount([{ ...A, changeKey: 'v1' }, B], new Map([['a', DRAFT]]), true);
    update([{ ...A, changeKey: 'v2' }, B]);
    expect(cls(box('a'))).toContain('canvas-node--deepened');
    expect(cls(box('a'))).toContain('canvas-node--drafting');
    expect(box('a').getAttribute('data-motion')).toBe('cue');
  });

  it('a step moving from A to B moves the cue: A loses it, B has it', () => {
    const update = mount([A, B], new Map([['a', DRAFT]]));
    update([A, B], new Map([['b', DRAFT]]));
    expect(box('a').hasAttribute('data-cue')).toBe(false);
    expect(box('a').querySelector('.canvas-cue-chip')).toBeNull();
    expect(box('b').getAttribute('data-cue')).toBe('drafting');
  });

  it('an EXITING node carries no cue', () => {
    const update = mount([A, B, C], new Map([['c', DRAFT]]), true);
    update([A, B]);
    const c = box('c');
    expect(c.getAttribute('data-motion')).toBe('exit');
    expect(c.hasAttribute('data-cue')).toBe(false);
    expect(cls(c)).not.toContain('canvas-node--drafting');
  });

  it('absent or null nodeCues — and an EMPTY map — leave the markup as it was', () => {
    const html = (cues: ReadonlyMap<string, NodeCue> | null | undefined) => {
      const r = render(
        <PlanningCanvas nodes={[A, B, C]} edges={[AB]} renderNode={renderNode} nodeCues={cues} />,
      );
      const out = r.container.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_ID_');
      cleanup();
      return out;
    };
    const absent = html(undefined);
    expect(html(null)).toBe(absent);
    expect(html(new Map())).toBe(absent);
    expect(absent).not.toMatch(/data-cue|canvas-cue|aria-describedby/);
  });
});

// AT WORK (Story MOTIR-8413 · MOTIR-8416; `design/ai-chat/design-notes.md`
// § _Motir at work_): the moving marker, and the leaving form that outlives it.
describe('PlanningCanvas — the at-work cue', () => {
  const MOVING: NodeCue = { ...DRAFT, moving: true };
  const ring = (id: string) => box(id).querySelector<HTMLElement>('.canvas-cue-ring')!;

  it('marks a MOVING drafting cue at-work, and a still one not at all', () => {
    mount(
      [A, B],
      new Map([
        ['a', MOVING],
        ['b', DRAFT],
      ]),
    );
    expect(box('a').getAttribute('data-cue-motion')).toBe('at-work');
    expect(box('b').hasAttribute('data-cue-motion')).toBe(false);
    expect(box('b').getAttribute('data-cue')).toBe('drafting');
  });

  it('a laying cue never moves, whatever its flag says', () => {
    mount([A, B], new Map([['b', { ...LAY, moving: true }]]));
    expect(box('b').getAttribute('data-cue')).toBe('laying');
    expect(box('b').hasAttribute('data-cue-motion')).toBe(false);
  });

  it('a moving cue the map drops is RETAINED leaving, then dropped when its ring fades', () => {
    const update = mount([A, B], new Map([['a', MOVING]]));
    update([A, B], new Map([['b', MOVING]]));
    expect(box('a').getAttribute('data-cue-motion')).toBe('leaving');
    expect(box('a').getAttribute('data-cue')).toBe('drafting');
    expect(box('b').getAttribute('data-cue-motion')).toBe('at-work');
    // Another animation's end changes nothing.
    fireEvent.animationEnd(ring('a'), { animationName: 'canvas-cue-glow' });
    expect(box('a').getAttribute('data-cue-motion')).toBe('leaving');
    fireEvent.animationEnd(ring('a'), { animationName: 'canvas-fade-out' });
    expect(box('a').hasAttribute('data-cue')).toBe(false);
    expect(box('a').hasAttribute('data-cue-motion')).toBe(false);
    expect(box('a').querySelector('.canvas-cue-chip')).toBeNull();
  });

  // MOTIR-8418 — the drop is idempotent: a second fade end landing before the
  // re-render (both dispatched in one act) finds nothing left to drop.
  it('two fade ends in one batch drop the cue once and change nothing else', () => {
    const update = mount([A, B], new Map([['a', MOVING]]));
    update([A, B], new Map([['b', MOVING]]));
    const r = ring('a');
    act(() => {
      fireEvent.animationEnd(r, { animationName: 'canvas-fade-out' });
      fireEvent.animationEnd(r, { animationName: 'canvas-fade-out' });
    });
    expect(box('a').hasAttribute('data-cue')).toBe(false);
    expect(box('b').getAttribute('data-cue-motion')).toBe('at-work');
  });

  it('a leaving cue whose fade end never fires is dropped after the fade duration', () => {
    const update = mount([A, B], new Map([['a', MOVING]]));
    update([A, B], null);
    expect(box('a').getAttribute('data-cue-motion')).toBe('leaving');
    act(() => {
      vi.advanceTimersByTime(EXIT_FALLBACK_SLACK_MS + DEFAULT_DURATIONS.base);
    });
    expect(box('a').hasAttribute('data-cue')).toBe(false);
  });

  it('a cue that comes back while leaving is live again, not leaving', () => {
    const update = mount([A, B], new Map([['a', MOVING]]));
    update([A, B], null);
    expect(box('a').getAttribute('data-cue-motion')).toBe('leaving');
    update([A, B], new Map([['a', MOVING]]));
    expect(box('a').getAttribute('data-cue-motion')).toBe('at-work');
  });

  it('an EXITING node keeps no leaving cue', () => {
    const update = mount([A, B, C], new Map([['c', MOVING]]), true);
    update([A, B], null);
    expect(box('c').getAttribute('data-motion')).toBe('exit');
    expect(box('c').hasAttribute('data-cue')).toBe(false);
  });

  it('under reduced motion nothing is retained: the cue goes at once', () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const update = mount([A, B], new Map([['a', MOVING]]));
    update([A, B], null);
    expect(box('a').hasAttribute('data-cue')).toBe(false);
    expect(box('a').hasAttribute('data-cue-motion')).toBe(false);
  });
});

describe('leavingCuesOf', () => {
  const MOVING: NodeCue = { ...DRAFT, moving: true };
  const all = () => true;
  it('keeps only moving drafting cues the next map drops, while drawn', () => {
    const prev = new Map<string, NodeCue>([
      ['a', MOVING],
      ['b', DRAFT],
      ['c', { ...LAY, moving: true }],
      ['d', MOVING],
    ]);
    const next = new Map<string, NodeCue>([['d', MOVING]]);
    expect(Object.keys(leavingCuesOf(prev, next, {}, all))).toEqual(['a']);
    expect(leavingCuesOf(prev, next, {}, (id) => id !== 'a')).toEqual({});
  });
  it('carries held cues forward until the map names them again or they are undrawn', () => {
    const held = { a: MOVING, b: MOVING };
    const next = new Map<string, NodeCue>([['a', MOVING]]);
    expect(Object.keys(leavingCuesOf(null, next, held, (id) => id !== 'x'))).toEqual(['b']);
    expect(leavingCuesOf(null, null, held, () => false)).toEqual({});
  });
});
