// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { fireEvent } from '@testing-library/dom';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';

afterEach(() => cleanup());

const nodes: CanvasNode[] = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 300, y: 0 },
  { id: 'c', x: 300, y: 300 },
];
const edges: CanvasEdge[] = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c', variant: 'pending' },
];
const renderNode = (n: CanvasNode) => <div>Node {n.id}</div>;

const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1]);

describe('PlanningCanvas', () => {
  it('renders the caller-supplied node content', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    expect(screen.getByText('Node a')).toBeTruthy();
    expect(screen.getByText('Node b')).toBeTruthy();
    expect(screen.getByText('Node c')).toBeTruthy();
  });

  it('draws one read-only edge path per resolvable edge, skipping dangling ones', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(2);
    cleanup();
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[...edges, { from: 'a', to: 'ghost' }]}
        renderNode={renderNode}
      />,
    );
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(2); // ghost edge skipped, no crash
  });

  it('is a labelled, focusable region with focusable nodes', () => {
    render(
      <PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} ariaLabel="Roadmap" />,
    );
    const region = screen.getByRole('application', { name: 'Roadmap' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const nodeEls = document.querySelectorAll('[data-node-id]');
    expect(nodeEls).toHaveLength(3);
    nodeEls.forEach((el) => expect(el.getAttribute('tabindex')).toBe('0'));
  });

  it('zoom controls change the view scale', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    const world = screen.getByTestId('canvas-world');
    expect(scaleOf(world)).toBeCloseTo(1);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(world)).toBeCloseTo(1.2);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(scaleOf(world)).toBeCloseTo(1);
  });

  it('the + / - / 0 keys zoom and fit', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    const region = screen.getByRole('application');
    const world = screen.getByTestId('canvas-world');
    fireEvent.keyDown(region, { key: '+' });
    expect(scaleOf(world)).toBeCloseTo(1.2);
    fireEvent.keyDown(region, { key: '0' }); // fit — does not throw (0-size viewport in jsdom)
    expect(world).toBeTruthy();
  });

  it('activates a node via the keyboard (Enter) when onNodeActivate is given', () => {
    const onNodeActivate = vi.fn();
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={edges}
        renderNode={renderNode}
        onNodeActivate={onNodeActivate}
      />,
    );
    fireEvent.keyDown(document.querySelector('[data-node-id="b"]')!, { key: 'Enter' });
    expect(onNodeActivate).toHaveBeenCalledWith('b');
  });

  it('draws a cross-story edge as ONE path plus a flag badge in its own layer', () => {
    const crossEdges: CanvasEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', variant: 'cross' },
    ];
    render(<PlanningCanvas nodes={nodes} edges={crossEdges} renderNode={renderNode} />);
    // the flag badge does NOT inflate the asserted edge-path count
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(2);
    const flags = screen.getAllByTestId('cross-flag');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.textContent).toContain('blocked elsewhere');
  });

  it('paints the cross-flag layer ABOVE the node layer, so the bad-plan signal is never occluded', () => {
    // MOTIR-1583: both the cross-flag layer and the node layer are position:absolute
    // with no z-index, so DOM paint order decides which wins. The flag chip sits at a
    // cross edge's midpoint, which frequently lands over a card — so the cross-flag
    // layer MUST come AFTER the node layer in the DOM to stay legible.
    const crossEdges: CanvasEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', variant: 'cross' },
    ];
    render(<PlanningCanvas nodes={nodes} edges={crossEdges} renderNode={renderNode} />);
    const world = screen.getByTestId('canvas-world');
    const crossFlags = screen.getByTestId('canvas-cross-flags');
    // siblings in the same pan/zoom container…
    expect(crossFlags.parentElement).toBe(world.parentElement);
    // …with the cross-flag layer following the node layer, so it paints on top.
    const rel = world.compareDocumentPosition(crossFlags);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and the overlay must not intercept pointer events (drags/clicks pass through to cards).
    expect(crossFlags.className).toContain('pointer-events-none');
  });

  it('gives every edge a directional arrowhead (marker-end), markers in their own defs', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    // the markers live OUTSIDE canvas-edges, so its path count is unchanged…
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(2);
    // …and every edge path points at an arrowhead marker.
    const edgePaths = screen.getByTestId('canvas-edges').querySelectorAll('path');
    edgePaths.forEach((p) => expect(p.getAttribute('marker-end')).toMatch(/^url\(#/));
    // ONE MARKER PER VARIANT, and the count is frozen on purpose: an edge that
    // inherited another variant's arrowhead would still point the right way and
    // be the one inconsistency in the set. Five since MOTIR-3972 added `running`
    // (committed / pending / warning / emphasis / running).
    expect(document.querySelectorAll('marker')).toHaveLength(5);
  });

  it('emphasises a selected node’s edges in the accent (so a dashed one still pops)', () => {
    // edges: a→b (firm), b→c (pending). Select b → both are b’s connections.
    const { container } = render(
      <PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} selectedId="b" />,
    );
    const paths = [...container.querySelectorAll('[data-testid="canvas-edges"] path')];
    // every lit edge (here both) points at the accent emphasis marker…
    paths.forEach((p) => expect(p.getAttribute('marker-end')).toContain('-emphasis'));
    // …including the pending (dashed) one, which is now accent-stroked.
    const dashed = paths.find((p) => p.getAttribute('stroke-dasharray'));
    expect(dashed?.getAttribute('class')).toContain('stroke-(--el-accent)');
  });

  it('renders no cross-flag layer content when there are no cross edges', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    expect(screen.queryByTestId('cross-flag')).toBeNull();
  });

  it('accepts focusNodeId / focusNonce without throwing (search-to-focus)', () => {
    const { rerender } = render(
      <PlanningCanvas
        nodes={nodes}
        edges={edges}
        renderNode={renderNode}
        focusNodeId="c"
        focusNonce={0}
      />,
    );
    rerender(
      <PlanningCanvas
        nodes={nodes}
        edges={edges}
        renderNode={renderNode}
        focusNodeId="c"
        focusNonce={1}
      />,
    );
    expect(screen.getByTestId('canvas-world')).toBeTruthy();
  });

  it('exposes ONLY zoom controls — no link create / edit / delete affordance', () => {
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .sort();
    expect(labels).toEqual(['Fit to view', 'Zoom in', 'Zoom out']);
    expect(
      screen.queryByRole('button', { name: /add|edit|delete|link|connect|remove/i }),
    ).toBeNull();
  });
});

// ── THE RUNNING EDGE (Story MOTIR-1789 · MOTIR-3972) ───────────────────────
// The variant a run uses for the edge it is travelling along. Three properties
// matter and each has its own assertion, because each fails differently:
// the edge count invariant (a broken guard), the opt-in default (a regression
// in four other surfaces), and the reduced-motion form (an accessibility cost).
describe('the RUNNING edge variant', () => {
  const paths = () =>
    Array.from(
      document.querySelector('[data-testid="canvas-edges"]')?.querySelectorAll('path') ?? [],
    );

  it('renders in the in-progress tone with its own arrowhead marker', () => {
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[{ from: 'a', to: 'b', variant: 'running' }]}
        renderNode={renderNode}
      />,
    );
    const p = paths()[0]!;
    expect(p.getAttribute('class')).toContain('stroke-(--el-status-in-progress)');
    expect(p.getAttribute('marker-end')).toContain('-running');
  });

  it('⚠️ adds NO element per edge — the path count still equals the edge count', () => {
    // The invariant the arrowhead markers live in a separate <svg> to protect.
    // An animation implemented as a second overlaid path would pass every other
    // assertion here and silently break the guard that asserts this.
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[
          { from: 'a', to: 'b', variant: 'running' },
          { from: 'b', to: 'c', variant: 'pending' },
        ]}
        renderNode={renderNode}
      />,
    );
    expect(paths()).toHaveLength(2);
  });

  it('⚠️ is OPT-IN — a consumer that sends no running edge renders as before', () => {
    // Four other surfaces compose this canvas. An onboarding canvas that grew a
    // flowing edge would be a regression, so the default must be untouched.
    render(<PlanningCanvas nodes={nodes} edges={edges} renderNode={renderNode} />);
    for (const p of paths()) {
      expect(p.getAttribute('class')).not.toContain('canvas-edge-running');
      expect(p.getAttribute('marker-end')).not.toContain('-running');
    }
  });

  it('carries the class the reduced-motion gate keys off, and no inline animation', () => {
    // The dash and its travel live in `globals.css` behind
    // `prefers-reduced-motion: no-preference`, so the STATIC form is the default.
    // Asserting the hook rather than the frame: a computed animation is not
    // observable in happy-dom, and the rule is what the gate actually reads.
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[{ from: 'a', to: 'b', variant: 'running' }]}
        renderNode={renderNode}
      />,
    );
    const p = paths()[0]!;
    expect(p.getAttribute('class')).toContain('canvas-edge-running');
    expect(p.getAttribute('style') ?? '').not.toContain('animation');
    expect(p.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('outranks the selection emphasis, and yields to `cross`', () => {
    // A run's live edge stays the live one while a reader clicks around; a plan
    // that is WRONG still outranks a plan that is in motion.
    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[
          { from: 'a', to: 'b', variant: 'running' },
          { from: 'b', to: 'c', variant: 'cross' },
        ]}
        renderNode={renderNode}
        selectedId="b"
      />,
    );
    const [runningPath, crossPath] = paths();
    expect(runningPath!.getAttribute('class')).toContain('stroke-(--el-status-in-progress)');
    expect(runningPath!.getAttribute('class')).not.toContain('stroke-(--el-accent)');
    expect(crossPath!.getAttribute('class')).toContain('stroke-(--el-warning)');
  });
});
