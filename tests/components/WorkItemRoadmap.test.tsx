// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
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
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The per-level roadmap endpoint, served from a tiny in-memory tree:
//   roots → [Epic one (drillable)];  E1's children → [Story one (leaf)].
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
});
