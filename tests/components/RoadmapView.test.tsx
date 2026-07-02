// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RoadmapView } from '@/components/planning/RoadmapView';

// RoadmapView writes the chosen scope into the URL (MOTIR-1541) via next/navigation's
// useRouter().replace + usePathname. Mock both: `replace` is a spy we assert on, and
// the pathname is the roadmap route. (Hoisted so the spy exists when the factory runs.)
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/roadmap',
}));

// RoadmapView (MOTIR-1382) owns the roadmap SCOPE toggle and feeds the chosen scope
// to WorkItemRoadmap, which threads it into every per-level fetch (`&scope=sprint`).
// These unit tests drive the wrapper: default scope, the toggle re-keying the fetch,
// the no-active-sprint state, and the Segmented + i18n composition. The canvas's own
// drill/edge behaviour is covered by WorkItemRoadmap.test.tsx; here we assert the
// SCOPE wiring only. happy-dom + the real `en` catalog (renderWithIntl).

// Per-scope roots so a scope switch is observable in the rendered tree.
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

beforeEach(() => {
  fetchUrls = [];
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

  it('toggling to Active sprint re-keys the fetch with scope=sprint and re-renders the scoped root', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));

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
    render(
      <RoadmapView
        {...baseProps({ hasActiveSprint: false, sprintName: null, sprintGoal: null })}
      />,
    );
    await screen.findByText('Whole-project epic'); // default scope still works

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));

    // The design's no-active-sprint EmptyState renders instead of the canvas…
    expect(await screen.findByText('No active sprint')).toBeTruthy();
    expect(
      screen.getByText(/Start a sprint from the board to see its slice of the roadmap/),
    ).toBeTruthy();
    // …and no sprint-scoped fetch is ever issued (the canvas isn't mounted).
    expect(fetchUrls.every((u) => !u.includes('scope=sprint'))).toBe(true);
    // The toggle stays available; switching back restores the whole-project tree.
    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
  });
});

describe('RoadmapView — URL-addressable scope (MOTIR-1541)', () => {
  it('seeds the scope from initialScope: initialScope="sprint" opens in Active-sprint scope', async () => {
    render(<RoadmapView {...baseProps({ initialScope: 'sprint' })} />);

    // The toggle reflects the URL-seeded scope and the canvas loads the sprint root…
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(await screen.findByText('In-sprint epic')).toBeTruthy();
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));
    // …and seeding from the URL does NOT itself re-write the URL (no toggle click yet).
    expect(replace).not.toHaveBeenCalled();
  });

  it('defaults to project scope when initialScope is omitted', async () => {
    render(<RoadmapView {...baseProps()} />);
    expect(screen.getByRole('button', { name: 'Whole project' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
  });

  it('toggling to Active sprint writes ?scope=sprint via router.replace (scroll:false)', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));

    expect(replace).toHaveBeenCalledWith('/roadmap?scope=sprint', { scroll: false });
  });

  it('toggling back to Whole project clears the param (a clean /roadmap)', async () => {
    render(<RoadmapView {...baseProps({ initialScope: 'sprint' })} />);
    await screen.findByText('In-sprint epic');

    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));

    expect(replace).toHaveBeenCalledWith('/roadmap', { scroll: false });
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
    render(
      <RoadmapView
        {...baseProps({ hasActiveSprint: false, sprintName: null, sprintGoal: null })}
      />,
    );
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    await screen.findByText('No active sprint');

    expect(
      (screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
