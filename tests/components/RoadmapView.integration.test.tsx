// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RoadmapView } from '@/components/planning/RoadmapView';

// Story-level ASSEMBLED gate for MOTIR-1539 (roadmap usability): the TWO features
// this story ships — URL-addressable scope (MOTIR-1541) and the manual refresh
// control (MOTIR-1542) — COEXIST on the same RoadmapView header without
// interfering. Where RoadmapView.test.tsx drives each feature in ISOLATION (the
// per-subtask floor), this suite exercises the CROSS-FEATURE seams those unit
// tests can't reach on their own:
//   - a refresh must PRESERVE the URL-seeded scope (a refresh never drops/resets
//     scope, and never rewrites the URL),
//   - a scope switch must not STRAND the refresh control's loading state,
//   - the refresh contract holds against the CURRENT scope (a scoped refetch),
//   - both controls resolve their copy from the REAL `roadmap` next-intl catalog.
// Harness mirrors RoadmapView.test.tsx: next/navigation + global fetch mocked,
// the real `en` catalog via renderWithIntl, the real ProjectRoadmapCanvas +
// WorkItemRoadmap under test (there is no DB seam in this frontend-only story).

// next/navigation: `replace` is the spy we assert the URL contract through;
// the pathname is the roadmap route. (Hoisted so the spy exists at factory time.)
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/roadmap',
}));

// Per-scope roots so a scope switch (and a scoped refetch) is observable in the
// rendered tree, mirroring RoadmapView.test.tsx.
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
  ],
  edges: [],
};

let fetchUrls: string[] = [];

// The default stub: resolve every level immediately, recording the URL so the
// scope carried into each per-level fetch is assertable.
function stubImmediateFetch() {
  fetchUrls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      fetchUrls.push(u);
      const body = u.includes('scope=sprint') ? sprintRoot : projectRoot;
      return { ok: true, json: async () => body };
    }),
  );
}

// A gated stub: the NEXT fetch(es) block on `gate` until `release()` — so an
// in-flight loading state is observable WITHOUT a timer (assert on the real
// completion signal, never a fixed wait).
function stubGatedFetch(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      await gate;
      const u = String(url);
      fetchUrls.push(u);
      return {
        ok: true,
        json: async () => (u.includes('scope=sprint') ? sprintRoot : projectRoot),
      };
    }),
  );
  return { release };
}

beforeEach(() => {
  replace.mockClear();
  stubImmediateFetch();
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

describe('RoadmapView — assembled header: URL-scope + refresh coexist (MOTIR-1543)', () => {
  it('renders BOTH the scope toggle and the refresh control from the real roadmap catalog (no missing-key fallback)', async () => {
    render(<RoadmapView {...baseProps()} />);

    // Every string resolves from the real `roadmap` namespace — a missing key
    // would surface the key path (`roadmap.refresh`) or throw, not this copy.
    expect(screen.getByRole('heading', { name: 'Roadmap' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Roadmap scope' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Whole project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active sprint' })).toBeTruthy();

    // The refresh control's accessible name AND tooltip both come from
    // t('refresh') — assert the resolved string on both attributes.
    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' });
    expect(refresh.getAttribute('aria-label')).toBe('Refresh roadmap');
    expect(refresh.getAttribute('title')).toBe('Refresh roadmap');

    await screen.findByText('Whole-project epic'); // settle the initial load
  });

  it('a refresh in sprint scope PRESERVES the scope: the refetch stays scope=sprint and the URL is never rewritten', async () => {
    render(<RoadmapView {...baseProps({ initialScope: 'sprint' })} />);
    await screen.findByText('In-sprint epic');
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));

    // Seeding scope from the URL does not itself rewrite the URL (no toggle yet).
    expect(replace).not.toHaveBeenCalled();
    const before = fetchUrls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap' }));

    // The in-place refetch fires AND still carries scope=sprint — a refresh does
    // not drop / reset the scope…
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(before));
    expect(fetchUrls.at(-1)).toContain('scope=sprint');
    // …the toggle stays on Active sprint…
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // …and a refresh NEVER touches the URL, so the ?scope=sprint param survives.
    expect(replace).not.toHaveBeenCalled();
  });

  it('switching scope during an in-flight refresh clears the loading state (no stranded spinner)', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    // Gate the refresh's refetch so its loading state is observable in flight.
    const { release } = stubGatedFetch();
    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement;

    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('true'));
    expect(refresh.disabled).toBe(true);

    // Switch scope while the refresh is still in flight — the scope switch
    // supersedes the refresh (the canvas remounts), so the loading state clears.
    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));

    await waitFor(() => expect(refresh.getAttribute('aria-busy')).not.toBe('true'));
    expect(refresh.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    release(); // let the superseded + remounted fetches settle
    await screen.findByText('In-sprint epic');
  });

  it('refresh operates on the ACTIVE scope: after toggling to sprint, a refresh refetches the sprint level and settles to idle', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    await screen.findByText('In-sprint epic');
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));
    // The toggle wrote the URL once (the scope contract) — the baseline before refresh.
    expect(replace).toHaveBeenCalledWith('/roadmap?scope=sprint', { scroll: false });
    expect(replace).toHaveBeenCalledTimes(1);
    const before = fetchUrls.length;

    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement;
    fireEvent.click(refresh);

    // The refetch targets the CURRENT (sprint) level…
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(before));
    expect(fetchUrls.at(-1)).toContain('scope=sprint');
    // …the control's loading→idle transition tracks the mocked fetch resolution…
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).not.toBe('true'));
    // …and the refresh did NOT rewrite the URL (only the earlier toggle did).
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('toggling back to Whole project clears the ?scope= param and reloads the unscoped root — even after a refresh', async () => {
    render(<RoadmapView {...baseProps({ initialScope: 'sprint' })} />);
    await screen.findByText('In-sprint epic');

    // A refresh in sprint scope first (the two features composed)…
    fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap' }));
    await waitFor(() => expect(refreshSettled()).toBe(true));

    // …then return to Whole project: the URL param is cleared and the unscoped
    // root reloads.
    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));
    expect(replace).toHaveBeenCalledWith('/roadmap', { scroll: false });
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();

    function refreshSettled() {
      const btn = screen.getByRole('button', { name: 'Refresh roadmap' });
      return btn.getAttribute('aria-busy') !== 'true';
    }
  });

  it('shows just the sprint name as the subtitle when the active sprint has no goal (coverage top-up)', async () => {
    render(
      <RoadmapView
        {...baseProps({ initialScope: 'sprint', sprintName: 'Sprint 32', sprintGoal: null })}
      />,
    );
    await screen.findByText('In-sprint epic');

    // sprintScopeActive && !sprintGoal → subtitle is the bare sprint name, no
    // " · goal" separator (the branch the goal-present unit test doesn't reach).
    expect(screen.getByText('Sprint 32')).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
    // The Sprint scope chip still renders alongside it.
    expect(screen.getByText('Sprint scope')).toBeTruthy();
  });
});
