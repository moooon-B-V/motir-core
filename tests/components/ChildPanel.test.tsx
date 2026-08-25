// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ChildPanel } from '@/app/(authed)/items/[key]/_components/ChildPanel';

// The Children section's List ↔ Graph switcher (Story MOTIR-2284 / MOTIR-2288),
// built to `design/work-items/child-panel-graph.*`.
//
// The panel is a CLIENT wrapper around SERVER-rendered rows: list mode renders
// whatever it was handed as `children` (the shipped `ChildList`), graph mode
// mounts the subtree-rooted `WorkItemRoadmap`. So these tests hand it a marker
// node for the rows and assert the panel never re-implements them.

// `push` is kept as a spy with the OPPOSITE job it used to have (MOTIR-3434):
// the switch must NOT navigate. The URL is now written shallowly, so the
// positive assertion is on `history.pushState` and `push` is asserted absent.
const push = vi.fn();
const pushState = vi.spyOn(window.history, 'pushState');
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items/MOTIR-2284',
  useSearchParams: () => params,
}));

// The canvas fetches its own levels; keep it to one empty level so the mount is
// deterministic and these tests stay about the PANEL.
beforeEach(() => {
  push.mockClear();
  pushState.mockClear();
  params = new URLSearchParams();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ nodes: [], edges: [] }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS = <ul data-testid="server-rows" />;

function renderPanel(count = 3) {
  return render(
    <ChildPanel count={count} itemId="P9" itemIdentifier="MOTIR-2284" projectKey="MOTIR">
      {ROWS}
    </ChildPanel>,
  );
}

describe('ChildPanel', () => {
  it('defaults to LIST on a clean URL and renders the server rows it was handed', () => {
    renderPanel();
    expect(screen.getByTestId('server-rows')).toBeTruthy();
    expect(screen.queryByTestId('child-panel-graph')).toBeNull();
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Graph' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('keeps the shipped header — the section title and the count Pill', () => {
    renderPanel(5);
    expect(screen.getByText('Child work items')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    // The switcher is a labelled group, keyboard-reachable as two real buttons.
    expect(screen.getByRole('group', { name: 'Children view' })).toBeTruthy();
  });

  it('renders the GRAPH mount and NOT the rows when ?children=graph is set', async () => {
    params = new URLSearchParams('children=graph');
    renderPanel();
    expect(await screen.findByTestId('child-panel-graph')).toBeTruthy();
    expect(screen.queryByTestId('server-rows')).toBeNull();
    expect(screen.getByRole('button', { name: 'Graph' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('roots the canvas at THIS item — the level read asks for the item, not the project roots', async () => {
    params = new URLSearchParams('children=graph');
    renderPanel();
    await screen.findByTestId('child-panel-graph');
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    const level = calls.filter((u) => u.includes('/roadmap'));
    expect(level.length).toBeGreaterThan(0);
    expect(level[0]).toContain('parentId=P9');
  });

  it('writes ?children=graph SHALLOWLY on switching to Graph — no navigation', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    // MOTIR-3434: `history.pushState`, not `router.push`. The list body is the
    // already-rendered `children` prop and the graph fetches its own level, so
    // the item page's twenty-nine awaits must not be re-run to switch between
    // them. A `pushState` also does not scroll, which is what the old
    // `{ scroll: false }` was asking for.
    expect(pushState).toHaveBeenCalledWith(null, '', '/items/MOTIR-2284?children=graph');
    expect(push).not.toHaveBeenCalled();
  });

  it('clears the param on switching back to List, leaving a CLEAN url', () => {
    params = new URLSearchParams('children=graph');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/items/MOTIR-2284');
    expect(push).not.toHaveBeenCalled();
  });

  it('preserves the page’s other query state when it writes the view', () => {
    params = new URLSearchParams('tab=history');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(pushState).toHaveBeenCalledWith(
      null,
      '',
      '/items/MOTIR-2284?tab=history&children=graph',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('treats an unknown ?children value as the default list', () => {
    params = new URLSearchParams('children=nonsense');
    renderPanel();
    expect(screen.getByTestId('server-rows')).toBeTruthy();
    expect(screen.queryByTestId('child-panel-graph')).toBeNull();
  });

  it('renders NOTHING for a leaf — no section, no header, no switcher', () => {
    const { container } = renderPanel(0);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText('Child work items')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Children view' })).toBeNull();
  });

  it('renders nothing for a leaf even when the URL asks for the graph', () => {
    params = new URLSearchParams('children=graph');
    const { container } = renderPanel(0);
    expect(container.innerHTML).toBe('');
  });
});
