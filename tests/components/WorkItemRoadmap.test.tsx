// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';

// WorkItemRoadmap mounts the work-item quick-view peek (MOTIR-1352), whose body
// reuses the shipped IssueQuickViewPanel (useTranslations) — so the tree needs a
// NextIntl provider (renderWithIntl). The peek is LOCAL-state-driven (no `?peek`),
// so no next/navigation mock is required.

// A condensed peek payload the /api/work-items/peek read returns for MOTIR-1.
const PEEK = {
  identifier: 'MOTIR-1',
  title: 'Epic one',
  kind: 'epic',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'The first epic.',
  type: null,
  executor: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: null,
  readiness: null,
  pullRequests: [],
  hasChildren: false,
  canPlan: true,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The per-level roadmap endpoint, served from a tiny in-memory tree:
//   roots → [Epic one (drillable), Epic two (leaf)];  E1's children → [Story one (leaf)].
// TWO roots on purpose: this adapter opts into AUTO-DRILL (MOTIR-1807), so a root
// level of exactly ONE drillable node would descend past it and these tests — which
// are all about acting on the ROOT level by hand — would have nothing to act on. A
// level with a real choice is also the shape the auto-descend must leave untouched.
const root = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E2',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-3',
      title: 'Epic two',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};
const e1Children = {
  nodes: [
    {
      id: 'S1',
      parentId: 'E1',
      kind: 'story',
      identifier: 'MOTIR-2',
      title: 'Story one',
      status: 'done',
      isDone: true,
      hasChildren: false,
    },
  ],
  edges: [],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
      if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
      return { ok: true, json: async () => root };
    }),
  );
});

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('WorkItemRoadmap', () => {
  it('selects a node, then drills via its Open affordance, fetching its children', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // select (no drill yet)
    expect(el('S1')).toBeNull();
    fireEvent.click(await screen.findByTestId('drill-button')); // Open → drill
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // S1 status pill
  });

  it('selecting a leaf calls onSelect and offers no drill affordance', async () => {
    const onSelect = vi.fn();
    render(<WorkItemRoadmap projectKey="MOTIR" onSelect={onSelect} />);
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button')); // drill into E1
    await screen.findByText('Story one');
    fireEvent.keyDown(el('S1')!, { key: 'Enter' }); // S1 is a leaf → just selects
    expect(onSelect).toHaveBeenCalledWith('S1');
    expect(screen.queryByTestId('drill-button')).toBeNull(); // a leaf can't drill
  });

  it('opens the work-item quick-view peek from the selected card View button (MOTIR-1352)', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    // No peek until a card is selected and View is clicked.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // select
    fireEvent.click(await screen.findByTestId('view-button')); // View → opens the peek
    // The peek modal opens and streams the item in from /api/work-items/peek.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe(
        '/items/MOTIR-1',
      ),
    );
    // Closing via the header × dismisses the peek (local state, no URL).
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the search overlay', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
  });

  // The onboarding-ran gate (Subtask 7.4 / MOTIR-1264): the planning-origin
  // cluster (MOTIR-1013) is pinned at the ROOT level ONLY for a project that
  // actually onboarded — the caller passes `showPlanningOrigin` from the
  // project's immutable onboarding-ran marker.
  it('pins the planning-origin cluster at the root when showPlanningOrigin is set', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByText('Epic one');
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
    expect(el('__planning_origin__')).not.toBeNull();
  });

  it('omits the planning-origin cluster for a never-onboarded project (default off)', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('planning-origin')).toBeNull();
    expect(el('__planning_origin__')).toBeNull();
  });

  // The cluster is the WHOLE-PROJECT road's origin: it says where the project's
  // tree came from. The sprint slice (MOTIR-1382) is a window onto the sprint's
  // committed work, so the project's planning journey does not belong on it —
  // even for an onboarded project whose caller passes `showPlanningOrigin`.
  it('omits the planning-origin cluster in SPRINT scope even when showPlanningOrigin is set', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" scope="sprint" showPlanningOrigin />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('planning-origin')).toBeNull();
    expect(el('__planning_origin__')).toBeNull();
  });

  it('renders the cross-story signal: a ghost anchor + a flagged node for an off-level blocker', async () => {
    // A level where T1 is blocked_by X, and X is NOT in the level → off-level.
    const crossLevel = {
      nodes: [
        {
          id: 'T1',
          parentId: null,
          kind: 'subtask',
          identifier: 'MOTIR-5',
          title: 'Wire it',
          status: 'todo',
          isDone: false,
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'T1', blockerId: 'X9' }],
      offLevelBlockers: [
        {
          id: 'X9',
          identifier: 'MOTIR-42',
          title: 'Migrate tokens',
          parentTitle: 'Auth hardening',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => crossLevel })),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    // the blocked node carries the cross-story flag…
    expect(await screen.findByTestId('cross-blocked-flag')).toBeTruthy();
    // …and the off-level blocker is anchored by a named ghost node.
    expect(screen.getByText('MOTIR-42')).toBeTruthy();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
    expect(document.querySelector('[data-node-id="X9"]')).not.toBeNull();
  });

  it('peeks the off-level blocker from its ghost anchor View button (MOTIR-1586)', async () => {
    // T1 is blocked_by X9 (off-level). X9's ghost anchor is now a viewable,
    // peekable card: selecting it shows the View button (a bare click only selects,
    // like every card), and View opens the WorkItemQuickView for the BLOCKER,
    // resolved by its identifier (MOTIR-42).
    const crossLevel = {
      nodes: [
        {
          id: 'T1',
          parentId: null,
          kind: 'subtask',
          identifier: 'MOTIR-5',
          title: 'Wire it',
          status: 'todo',
          isDone: false,
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'T1', blockerId: 'X9' }],
      offLevelBlockers: [
        {
          id: 'X9',
          identifier: 'MOTIR-42',
          title: 'Migrate tokens',
          parentTitle: 'Auth hardening',
        },
      ],
    };
    // The peek read resolves the BLOCKER by its identifier (MOTIR-42), not T1.
    const PEEK42 = { ...PEEK, identifier: 'MOTIR-42', title: 'Migrate tokens' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK42 };
        return { ok: true, json: async () => crossLevel };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('MOTIR-42')).toBeTruthy(); // the ghost anchor
    expect(screen.queryByRole('dialog')).toBeNull(); // nothing peeked yet
    // Selecting the anchor surfaces the View affordance but does NOT open the peek
    // (a bare click only selects, exactly like every other card — AC #1).
    fireEvent.keyDown(el('X9')!, { key: 'Enter' });
    expect(await screen.findByTestId('view-button')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Clicking View opens the peek and streams the BLOCKER in by its identifier.
    fireEvent.click(screen.getByTestId('view-button'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe(
        '/items/MOTIR-42',
      ),
    );
  });
  // ── SUBTREE ROOT (MOTIR-2287) ─────────────────────────────────────────────
  // The adapter's ROOT level can be one work item's children instead of the
  // project's roots. Opt-in: absent, every assertion above still holds.

  describe('subtreeRootId', () => {
    it('roots the first level at the item: level 0 reads that item, a drill reads the child', async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          calls.push(u);
          if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      await screen.findByText('Epic one');
      // The canvas asked for its ROOT level; the adapter asked the API for P9's
      // children — never the project roots (`parentId=` with no value).
      const levelCalls = calls.filter((u) => u.includes('/roadmap'));
      expect(levelCalls.length).toBe(1);
      expect(levelCalls[0]).toContain('parentId=P9');
      // A drill from that level is unchanged — it carries the drilled node's id.
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(calls.some((u) => u.includes('parentId=E1'))).toBe(true);
    });

    it('never pins the planning-origin cluster, even when showPlanningOrigin is set', async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(String(url));
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" showPlanningOrigin />);
      await screen.findByText('Epic one');
      expect(screen.queryByTestId('planning-origin')).toBeNull();
      expect(el('__planning_origin__')).toBeNull();
      // …and the pre-plan read that feeds its badge is never fired.
      expect(calls.some((u) => u.includes('preplan'))).toBe(false);
    });

    it('does NOT auto-descend a single drillable child (MOTIR-1807 opted out)', async () => {
      // ONE drillable node at the level. Unrooted, the adapter descends past it
      // (that is MOTIR-1807). Rooted, it must show the item's only child AS the
      // level — descending would be showing a different item's children.
      const onlyChild = { nodes: [root.nodes[0]], edges: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => onlyChild };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      expect(await screen.findByText('Epic one')).toBeTruthy();
      expect(el('E1')).not.toBeNull();
      expect(screen.queryByText('Story one')).toBeNull(); // no silent descent
    });

    it('unrooted, the same single-drillable level DOES auto-descend (the opt-out is the root)', async () => {
      const onlyChild = { nodes: [root.nodes[0]], edges: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => onlyChild };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" />);
      expect(await screen.findByText('Story one')).toBeTruthy();
    });

    it("labels the breadcrumb root with the caller's label once drilled", async () => {
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" rootLabel="MOTIR-2284" />);
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      const crumbs = screen.getByLabelText('Breadcrumb');
      expect(crumbs.textContent).toContain('MOTIR-2284');
      expect(crumbs.textContent).not.toContain('Roadmap'); // not the project default
    });

    it('keys the level cache by root, so a rooted and an unrooted mount cannot share a root level', async () => {
      const rootedLevel = {
        nodes: [
          {
            id: 'C1',
            parentId: 'P9',
            kind: 'subtask',
            identifier: 'MOTIR-77',
            title: 'Rooted child',
            status: 'todo',
            isDone: false,
            hasChildren: false,
          },
        ],
        edges: [],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=P9')) return { ok: true, json: async () => rootedLevel };
          return { ok: true, json: async () => root };
        }),
      );
      const rooted = render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      expect(await screen.findByText('Rooted child')).toBeTruthy();
      rooted.unmount();
      render(<WorkItemRoadmap projectKey="MOTIR" />);
      // The unrooted mount reads the PROJECT roots — it must not be served the
      // rooted mount's cached level (a per-mount ref, plus a root-keyed entry).
      expect(await screen.findByText('Epic one')).toBeTruthy();
      expect(screen.queryByText('Rooted child')).toBeNull();
    });
  });

  // ── the paths the story gate (MOTIR-2289) found uncovered ────────────────
  // These are pre-existing behaviours of the adapter that no suite exercised;
  // the story puts this file under the per-file coverage gate, so they are
  // asserted rather than left as an untested branch.

  describe('the planning-origin DOOR + the manual refresh', () => {
    const PREPLAN = {
      docs: [{ kind: 'discovery' }, { kind: 'vision' }],
    };

    function stubWithPreplan() {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('/api/ai/pre-plan')) return { ok: true, json: async () => PREPLAN };
          if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
    }

    it('drills the phase card into a SYNTHETIC pre-plan station level (no roadmap read)', async () => {
      stubWithPreplan();
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      // The badge's read has landed, so the card reports what the journey produced.
      await screen.findByText('2 of 4 docs');
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      // The stations are built from the pre-plan read, not from a roadmap level —
      // no work item backs them, so asking the API for ORIGIN_ID's children would
      // be a request for an id it has never heard of.
      expect(await screen.findByText('Understanding your project')).toBeTruthy();
      const calls = (
        globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('__planning_origin__'))).toBe(false);
    });

    it('opens the tier doc from a produced station’s View, and closes it', async () => {
      stubWithPreplan();
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      await screen.findByText('2 of 4 docs');
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Understanding your project');
      // A produced station is `viewable`, so the canvas's own View button surfaces
      // on it — and the adapter routes a TIER id to the doc modal rather than to
      // the work-item peek (work-item ids are cuids and never a tier kind).
      fireEvent.keyDown(el('discovery')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('view-button'));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a FAILED pre-plan read leaves the card chip-less and the level upcoming', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('/api/ai/pre-plan')) throw new Error('offline');
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      // `null` is the honest "we do not know": no chip, never an error on the
      // roadmap, and the card still paints (the read never blocks first paint).
      expect(screen.getByTestId('planning-origin')).toBeTruthy();
      expect(screen.queryByTestId('planning-origin-chip')).toBeNull();
      // The drilled level still renders — its four stations, all `upcoming`.
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Understanding your project')).toBeTruthy();
    });

    it('a refreshSignal bump refetches the CURRENT level in place and settles', async () => {
      const onRefreshSettled = vi.fn();
      const fetchSpy = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
        return { ok: true, json: async () => root };
      });
      vi.stubGlobal('fetch', fetchSpy);
      const view = render(
        <WorkItemRoadmap
          projectKey="MOTIR"
          refreshSignal={0}
          onRefreshSettled={onRefreshSettled}
        />,
      );
      await screen.findByText('Epic one');
      const before = fetchSpy.mock.calls.length;
      expect(onRefreshSettled).not.toHaveBeenCalled(); // an initial load never settles
      view.rerender(
        <WorkItemRoadmap
          projectKey="MOTIR"
          refreshSignal={1}
          onRefreshSettled={onRefreshSettled}
        />,
      );
      await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(before));
      // The refresh drops the cache and re-reads — and reports settled on the real
      // fetch-completion signal, which is what lets a caller clear its spinner
      // without a timer.
      await waitFor(() => expect(onRefreshSettled).toHaveBeenCalled());
      expect(await screen.findByText('Epic one')).toBeTruthy(); // same level, in place
    });
  });
});
