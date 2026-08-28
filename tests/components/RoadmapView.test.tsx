// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RoadmapView } from '@/components/planning/RoadmapView';

// RoadmapView derives the roadmap SCOPE from the URL (`?scope=`, MOTIR-1541/1549) and
// writes it back on toggle via next/navigation's useRouter().push + usePathname. Mock
// all three: `push`/`replace` are spies we assert on, `usePathname` is the roadmap
// route, and `useSearchParams` reads a mutable holder (`sp.current`) so a test can
// simulate a deep-link / a browser Back/forward by setting the query + re-rendering.
// (Hoisted so the spies + holder exist when the factory runs.)
const { push, replace, sp } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  sp: { current: '' },
}));

// MOTIR-3434 — the scope toggle writes the URL SHALLOWLY now, so the positive
// assertion moved to `history.pushState`. `push` keeps its spy with the
// OPPOSITE job: the toggle must NOT navigate, because the canvas refetches on
// its `key={scope}` remount and the page's server reads produce nothing this
// body uses.
const pushState = vi.spyOn(window.history, 'pushState');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/roadmap',
  useSearchParams: () => new URLSearchParams(sp.current),
}));

// RoadmapView (MOTIR-1382) owns the roadmap SCOPE toggle and feeds the chosen scope
// to WorkItemRoadmap, which threads it into every per-level fetch (`&scope=sprint`).
// These unit tests drive the wrapper: default scope, the toggle re-keying the fetch,
// the URL as the source of truth (deep-link + Back/forward), the no-active-sprint
// state, and the Segmented + i18n composition. The canvas's own drill/edge behaviour
// is covered by WorkItemRoadmap.test.tsx; here we assert the SCOPE wiring only.
// happy-dom + the real `en` catalog (renderWithIntl).

// Per-scope roots so a scope switch is observable in the rendered tree.
// TWO roots per scope on purpose: `WorkItemRoadmap` opts into AUTO-DRILL
// (MOTIR-1807), so a root level of exactly ONE drillable node descends past it —
// these specs assert which ROOT loaded, so each scope needs a real choice.
const projectRoot = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Whole-project epic',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E2',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-2',
      title: 'Second project epic',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};
const sprintRoot = {
  nodes: [
    {
      id: 'E7',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-464',
      title: 'In-sprint epic',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E8',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-465',
      title: 'Second in-sprint epic',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};

let fetchUrls: string[] = [];

beforeEach(() => {
  fetchUrls = [];
  sp.current = '';
  push.mockClear();
  pushState.mockClear();
  replace.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      fetchUrls.push(u);
      const body = u.includes('scope=sprint') ? sprintRoot : projectRoot;
      return { ok: true, json: async () => body };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function baseProps(over: Partial<Parameters<typeof RoadmapView>[0]> = {}) {
  return {
    projectKey: 'MOTIR',
    projectName: 'Acme',
    ariaLabel: 'Acme roadmap',
    hasActiveSprint: true,
    sprintName: 'Sprint 32',
    sprintGoal: 'Three Epic-7 stories',
    showPlanningOrigin: false,
    ...over,
  };
}

describe('RoadmapView — scope toggle', () => {
  it('defaults to Whole project: the toggle shows it pressed and the root loads UNscoped', async () => {
    render(<RoadmapView {...baseProps()} />);

    // The Segmented control (labelled group) with the i18n labels.
    expect(screen.getByRole('group', { name: 'Roadmap scope' })).toBeTruthy();
    const whole = screen.getByRole('button', { name: 'Whole project' });
    expect(whole.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'false',
    );

    // Default subtitle + the whole-project root rendered; the fetch carried no scope.
    expect(screen.getByText("Acme's roadmap")).toBeTruthy();
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
    expect(fetchUrls.some((u) => u.includes('/roadmap'))).toBe(true);
    expect(fetchUrls.every((u) => !u.includes('scope=sprint'))).toBe(true);
  });

  it('toggling to Active sprint PUSHES ?scope=sprint (a history entry) and re-renders the scoped root on navigation', async () => {
    const { rerender } = render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));

    // The toggle writes a DISTINCT history entry via push (not replace) — MOTIR-1549.
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap?scope=sprint');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    // Simulate the resulting client navigation: the URL now carries scope=sprint, so
    // useSearchParams() reports it and the derived scope follows.
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...baseProps()} />);

    // The canvas remounts in sprint scope → a scoped fetch + the sprint root.
    expect(await screen.findByText('In-sprint epic')).toBeTruthy();
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // The subtitle shows the sprint name + goal and the Sprint scope chip.
    expect(screen.getByText('Sprint 32 · Three Epic-7 stories')).toBeTruthy();
    expect(screen.getByText('Sprint scope')).toBeTruthy();
  });

  it('with NO active sprint, Active sprint shows the empty state and never fetches sprint scope', async () => {
    const props = baseProps({ hasActiveSprint: false, sprintName: null, sprintGoal: null });
    const { rerender } = render(<RoadmapView {...props} />);
    await screen.findByText('Whole-project epic'); // default scope still works

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap?scope=sprint');
    expect(push).not.toHaveBeenCalled();

    // Simulate the navigation to sprint scope.
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...props} />);

    // The design's no-active-sprint EmptyState renders instead of the canvas…
    expect(await screen.findByText('No active sprint')).toBeTruthy();
    expect(
      screen.getByText(/Start a sprint from the board to see its slice of the roadmap/),
    ).toBeTruthy();
    // …and no sprint-scoped fetch is ever issued (the canvas isn't mounted).
    expect(fetchUrls.every((u) => !u.includes('scope=sprint'))).toBe(true);

    // The toggle stays available; navigating back to whole-project restores the tree.
    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap');
    expect(push).not.toHaveBeenCalled();
    sp.current = '';
    rerender(<RoadmapView {...props} />);
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
  });
});

describe('RoadmapView — URL-addressable scope + Back/forward (MOTIR-1541, MOTIR-1549)', () => {
  it('seeds the scope from the ?scope= URL param: scope=sprint opens in Active-sprint scope', async () => {
    sp.current = 'scope=sprint';
    render(<RoadmapView {...baseProps()} />);

    // The toggle reflects the URL-derived scope and the canvas loads the sprint root…
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(await screen.findByText('In-sprint epic')).toBeTruthy();
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));
    // …and deriving from the URL does NOT itself navigate (no toggle click yet).
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('defaults to project scope when ?scope= is absent', async () => {
    sp.current = '';
    render(<RoadmapView {...baseProps()} />);
    expect(screen.getByRole('button', { name: 'Whole project' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
  });

  it('toggling back to Whole project pushes a clean /roadmap (clears the param)', async () => {
    sp.current = 'scope=sprint';
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('In-sprint epic');

    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));

    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap');
    expect(push).not.toHaveBeenCalled();
  });

  // The MOTIR-1549 regression: browser Back/forward is a query-only client navigation
  // that changes `?scope=` WITHOUT remounting the island. Because scope is derived from
  // useSearchParams() (not a one-shot useState), the view must follow the URL both ways.
  // Against the pre-fix code (scope in useState, never synced from the URL) this failed.
  it('browser Back/forward that changes ?scope re-renders the correct scope', async () => {
    // Arrive in sprint scope (as if via a toggle → ?scope=sprint, then a fresh render).
    sp.current = 'scope=sprint';
    const { rerender } = render(<RoadmapView {...baseProps()} />);
    expect(await screen.findByText('In-sprint epic')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // Browser BACK → the URL returns to /roadmap (no scope); the view follows to
    // whole-project scope (the bug: it used to stay stuck in sprint scope).
    sp.current = '';
    rerender(<RoadmapView {...baseProps()} />);
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Whole project' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(fetchUrls.some((u) => u.includes('/roadmap') && !u.includes('scope=sprint'))).toBe(
        true,
      ),
    );

    // Browser FORWARD → back to ?scope=sprint; the view follows again.
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...baseProps()} />);
    expect(await screen.findByText('In-sprint epic')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // Navigation was driven by the URL alone — the component issued no push/replace.
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('RoadmapView — manual refresh (MOTIR-1542)', () => {
  it('re-fetches the current level on refresh (a fresh API hit)', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    const before = fetchUrls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap' }));

    // The level cache is dropped → the canvas re-runs its load for the current level,
    // issuing a fresh root fetch (still whole-project scope, no scope=sprint).
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(before));
    expect(fetchUrls.at(-1)).toContain('/roadmap');
    expect(fetchUrls.at(-1)).not.toContain('scope=sprint');
  });

  it('shows the loading state while refreshing and returns to idle on the real fetch signal', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    // Gate the NEXT fetch (the refresh) so the in-flight loading state is observable —
    // asserting on the real completion signal, never a timer.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await gate;
        fetchUrls.push(String(url));
        return { ok: true, json: async () => projectRoot };
      }),
    );

    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement;
    expect(refresh.getAttribute('aria-busy')).not.toBe('true');

    fireEvent.click(refresh);

    // In flight: the control is busy + disabled (the Button `loading` affordance).
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('true'));
    expect(refresh.disabled).toBe(true);

    release();

    // Settles back to idle once the refetch resolves.
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).not.toBe('true'));
    expect(refresh.disabled).toBe(false);
  });

  it('disables refresh when there is no active sprint to show (no canvas to refetch)', async () => {
    const props = baseProps({ hasActiveSprint: false, sprintName: null, sprintGoal: null });
    const { rerender } = render(<RoadmapView {...props} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...props} />);
    await screen.findByText('No active sprint');

    expect(
      (screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// ── THE LEVEL IS THE URL (MOTIR-3836) ───────────────────────────────────────
//
// `?item=<KEY>` names the item whose CHILDREN are the level in view. These specs
// drive the wiring RoadmapView owns: the seeded arrival, the shallow write on a
// level change, browser Back served from the session trail cache, an unknown key
// falling back to the root without a fetch, and `?scope=` composing with it.
describe('RoadmapView — the level is the URL (?item=)', () => {
  // The whole-project root's drillable epic (the fixture above): id `E1`,
  // identifier `MOTIR-1`. The sprint root's is `E7` / `MOTIR-464`.
  const trail = [{ id: 'E1', crumbKey: 'MOTIR-1', label: 'MOTIR-1 · Whole-project epic' }];

  it('opens on the SEEDED level, and the canvas reads that level and not the root', async () => {
    sp.current = 'item=MOTIR-1';
    render(<RoadmapView {...baseProps({ initialTrail: trail })} />);
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(0));
    // The canvas loads the SEEDED level (parentId=E1), never the project root first.
    expect(fetchUrls.every((u) => u.includes('parentId=E1'))).toBe(true);
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('MOTIR-1 · Whole-project epic')).toBeTruthy();
  });

  it('WRITES the level shallowly on a drill — a history entry, and no server navigation', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    fireEvent.keyDown(document.querySelector('[data-node-id="E1"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));

    await waitFor(() => expect(pushState).toHaveBeenCalled());
    const href = String(pushState.mock.calls.at(-1)![2]);
    expect(href).toBe('/roadmap?item=MOTIR-1');
    // Shallow: the router is never asked to navigate or refresh.
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('drops `item` from the URL when the canvas returns to its ROOT level', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    fireEvent.keyDown(document.querySelector('[data-node-id="E1"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    pushState.mockClear();

    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    expect(String(pushState.mock.calls.at(-1)![2])).toBe('/roadmap');
  });

  it('PRESERVES ?scope=sprint across the level write', async () => {
    sp.current = 'scope=sprint';
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('In-sprint epic');
    // The SPRINT fixture's drillable epic — id `E7`, identifier `MOTIR-464`.
    fireEvent.keyDown(document.querySelector('[data-node-id="E7"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    const href = String(pushState.mock.calls.at(-1)![2]);
    expect(href).toContain('scope=sprint');
    expect(href).toContain('item=MOTIR-464');
  });

  it('a SCOPE switch drops ?item= — the canvas remounts to the new scope’s own root', async () => {
    sp.current = 'item=MOTIR-1';
    render(<RoadmapView {...baseProps({ initialTrail: trail })} />);
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(0));
    pushState.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    expect(String(pushState.mock.calls.at(-1)![2])).toBe('/roadmap?scope=sprint');
  });

  it('browser BACK moves the canvas IN PLACE — the popstate handler, not a remount', async () => {
    // Drill, so the view caches the trail under its key and writes the URL.
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    fireEvent.keyDown(document.querySelector('[data-node-id="E1"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    expect(String(pushState.mock.calls.at(-1)![2])).toBe('/roadmap?item=MOTIR-1');
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const afterDrill = fetchUrls.length;

    // BACK. happy-dom keeps no real session history, so the test drives the two
    // things a Back actually does: the address bar goes back to the previous URL,
    // and `popstate` fires. The view reads `window.location` in that handler
    // precisely because the event — not `useSearchParams` — is the authority.
    window.history.replaceState(null, '', '/roadmap');
    fireEvent.popState(window);

    // The canvas adopts the ROOT level in place: the breadcrumb goes away without
    // the component unmounting, and the root level is re-read.
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull(),
    );
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
    // And it cost NOTHING: the root level is served from `WorkItemRoadmap`'s level
    // cache and the trail from this view's session cache, so Back issues no request
    // at all — no per-level read, and nothing resolving an ancestor chain.
    expect(fetchUrls.length).toBe(afterDrill);
    expect(fetchUrls.every((u) => !u.includes('ancestors'))).toBe(true);
  });

  it('an UNKNOWN ?item= falls back to the ROOT level and fetches no ancestor chain', async () => {
    sp.current = 'item=MOTIR-999999';
    // No seeded trail: the server could not resolve it, and the session cache has
    // never seen it. The canvas opens at the root.
    render(<RoadmapView {...baseProps()} />);
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
    // Only per-level roadmap reads — nothing resolving an ancestor chain.
    expect(fetchUrls.every((u) => u.includes('/roadmap'))).toBe(true);
    expect(fetchUrls.every((u) => !u.includes('ancestors'))).toBe(true);
  });
});

// ── THE CANVAS FILLS THE FOLD (MOTIR-3839) ──────────────────────────────────
//
// The BEHAVIOUR is geometry and is measured in a real Chromium (the table is in
// the pull request; happy-dom does no layout, so a height cannot be asserted
// here). What IS assertable — and what a later edit would silently break — is the
// STRUCTURE the geometry rests on: the budget, the way the band is spent, and the
// inset that keeps the canvas's bottom-right control off the floating orb.
describe('RoadmapView — the canvas box’s vertical budget', () => {
  function box(): HTMLElement {
    // The canvas frame: the element that carries the fold height.
    return document.querySelector('[style*="--canvas-fold-inset"]') as HTMLElement;
  }

  it('subtracts the MEASURED chrome (10rem) and no longer double-spends the shell’s band', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    const cls = box().className;
    expect(cls).toContain('h-[calc(100dvh_-_10rem)]');
    // The old value subtracted 11.5rem — 24px more than the chrome costs — AND
    // `--shell-bottom-clearance`, which the shell has already spent as padding.
    expect(cls).not.toContain('11.5rem');
    expect(cls).not.toContain('h-[calc(100dvh_-_10rem_-_var(--shell-bottom-clearance');
  });

  it('SPENDS the shell’s clearance band with a negative bottom margin, not by changing the shell', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    expect(box().className).toContain('mb-[calc(-1*var(--shell-bottom-clearance,1.5rem))]');
  });

  it('keeps min-h-[28rem] — the floor that stops the frame collapsing on a short window', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    expect(box().className).toContain('min-h-[28rem]');
  });

  it('declares `--canvas-fold-inset` so the canvas’s bottom-RIGHT control clears the orb', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    // Declared on the box that TAKES the band — so every other mount of the same
    // canvas inherits nothing and is untouched.
    expect(box().getAttribute('style')).toContain('--shell-bottom-clearance');
  });
});
