// @vitest-environment happy-dom
//
// `PlanningCanvas`'s DRAFTING / LAYING cue layer (Story MOTIR-7820 · MOTIR-7830;
// `design/ai-planning/design-notes.md` Part XXV §25.6–25.8). The cue is a class
// and two children on the NODE BOX, never on the card `renderNode` returns, it is
// independent of `motion`, it composes with the motion marks, and an absent map
// leaves the DOM byte for byte as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
  type NodeCue,
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
