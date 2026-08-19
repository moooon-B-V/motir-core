// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The plan-detail canvas at the `loadLevel` SEAM (bug MOTIR-3152).
//
// `tests/components/plan-item-node.test.tsx` covers `mergePlanLevel` against a
// hand-built, ALREADY-ADAPTED committed fixture and asserts `nodes.map(n => n.id)`.
// That is an identity assertion over a shape the production path never produced:
// `loadLevel` fetched the roadmap route and CAST its wire DTO to the canvas view
// model, so every committed node arrived with no `content`, no `drillable` and no
// `searchText` — invisible, undrillable, and fatal to search — while the id array
// it was checked by was perfectly correct.
//
// So every assertion here reads on RENDERED OUTPUT, driven from the REAL
// `ProjectRoadmapDto` wire payload through the real `loadLevel`. A canvas node is
// a rendering contract, and the only assertion that holds one asserts on what
// renders.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── The tree the stubbed roadmap route serves, four levels deep ──────────────
//   root  →  MOTIR-2200 (epic)
//            └─ MOTIR-3070 (bug)          ← the level the plan proposes into
//               ├─ MOTIR-7  (story, in review, has children)
//               └─ MOTIR-9  (subtask, todo)   ── MOTIR-9 blocks MOTIR-7
//                  MOTIR-7 └─ MOTIR-3083 (subtask, done)
// The shape mirrors `design/ai-planning/plans-surface.mock.html` panel E, whose
// breadcrumb reads `MOTIR-2200 · … › MOTIR-3070 · …`.
const EPIC_ID = 'wi_epic';
const BUG_ID = 'wi_bug';
const STORY_ID = 'wi_story';
const SUB_ID = 'wi_sub';
const LEAF_ID = 'wi_leaf';

/** A row in the REAL wire shape of `GET /api/projects/[key]/roadmap` (`RoadmapNodeDto`). */
function wireNode(over: Record<string, unknown>) {
  return {
    parentId: null,
    kind: 'subtask',
    type: null,
    executor: null,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren: false,
    progress: null,
    ready: false,
    ...over,
  };
}

const WIRE_LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'MOTIR-2200',
        title: 'The Motir agent loop',
        status: 'in_progress',
        statusLabel: null,
        statusCategory: null,
        hasChildren: true,
        progress: { done: 2, total: 9 },
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [EPIC_ID]: {
    nodes: [
      wireNode({
        id: BUG_ID,
        parentId: EPIC_ID,
        kind: 'bug',
        identifier: 'MOTIR-3070',
        title: 'The plan review surface is narrower',
        status: 'done',
        statusLabel: null,
        statusCategory: null,
        isDone: true,
        hasChildren: true,
        progress: { done: 3, total: 3 },
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [BUG_ID]: {
    nodes: [
      wireNode({
        id: STORY_ID,
        parentId: BUG_ID,
        kind: 'story',
        identifier: 'MOTIR-7',
        title: 'AI planning layer',
        status: 'in_review',
        statusLabel: null,
        statusCategory: null,
        hasChildren: true,
        progress: { done: 1, total: 3 },
      }),
      wireNode({
        id: SUB_ID,
        parentId: BUG_ID,
        identifier: 'MOTIR-9',
        title: 'The starter template',
        type: 'code',
        executor: 'coding_agent',
        ready: true,
      }),
    ],
    // A committed `blocked_by` edge BETWEEN two nodes on this level.
    edges: [{ blockedId: STORY_ID, blockerId: SUB_ID }],
    offLevelBlockers: [],
  },
  [STORY_ID]: {
    nodes: [
      wireNode({
        id: LEAF_ID,
        parentId: STORY_ID,
        identifier: 'MOTIR-3083',
        title: 'The plan canvas renders the roadmap level',
        status: 'done',
        statusLabel: null,
        statusCategory: null,
        isDone: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
};

function stubRoadmap() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    // The quick-view peek shares this stub so the View door can be driven end to
    // end; it 404s, which the panel renders as its own not-found state.
    if (url.pathname === '/api/work-items/peek') {
      return Promise.resolve({ ok: false, status: 404 } as Response);
    }
    const parentId = url.searchParams.get('parentId') ?? '__root__';
    const body = WIRE_LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function proposal(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: BUG_ID,
    parentIdentifier: 'MOTIR-3070',
    parentTitle: 'The plan review surface is narrower',
    parentKind: 'bug',
    parentTrail: [
      { id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' },
      { id: BUG_ID, identifier: 'MOTIR-3070', title: 'The plan review surface is narrower' },
    ],
    blockedByNodeIds: [],
    identifier: null,
    title: 'A proposed subtask',
    kind: 'subtask',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    targetMissing: false,
    ...over,
  };
}

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

/** Select a node the way a user does, so the canvas surfaces its action slot. */
function selectNode(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
}

function mount(items: PlanReviewItemDto[] = [proposal()]) {
  return render(<PlanReviewCanvas items={items} projectKey="MOTIR" version={0} />);
}

describe('PlanReviewCanvas — the committed level it draws', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  it('RENDERS a committed sibling — its identifier and its title — from the real wire payload', async () => {
    mount();

    // The proposal is drawn (it always was — `mergePlanLevel` adapts it).
    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    // The committed siblings it lands beside are the whole point of the surface.
    expect(screen.getByText('MOTIR-7')).toBeTruthy();
    expect(screen.getByText('AI planning layer')).toBeTruthy();
    expect(screen.getByText('MOTIR-9')).toBeTruthy();
    expect(screen.getByText('The starter template')).toBeTruthy();
  });

  it('draws a committed sibling as its REAL card — status pill included', async () => {
    mount();
    await screen.findByText('MOTIR-7');
    // `labels.defaultStatus.in_review` — the shipped `WorkItemStatusPill`, not a
    // stand-in: the card is the roadmap's card because it is BUILT by the
    // roadmap's own adapter.
    expect(within(el(STORY_ID) as HTMLElement).getByText('In Review')).toBeTruthy();
    // The sibling the wire payload marks READY takes the shipped ready pill in the
    // same slot — the adapter carried `ready` too, not just the name fields.
    expect(within(el(SUB_ID) as HTMLElement).getByTestId('ready-pill')).toBeTruthy();
  });

  it('offers Open on a committed sibling with children, and DRILLS into its level', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // A childless sibling is a leaf — no drill affordance.
    selectNode(SUB_ID);
    expect(within(el(SUB_ID) as HTMLElement).queryByTestId('drill-button')).toBeNull();

    selectNode(STORY_ID);
    const open = within(el(STORY_ID) as HTMLElement).getByTestId('drill-button');
    fireEvent.click(open);

    expect(await screen.findByText('MOTIR-3083')).toBeTruthy();
    expect(screen.getByText('The plan canvas renders the roadmap level')).toBeTruthy();
    expect(el(STORY_ID)).toBeNull(); // we left the level we drilled from
  });

  it('DRAWS a committed blocked_by edge between two nodes on the level', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // One `<path>` per drawn edge (`PlanningCanvas` keeps its markers in a
    // separate <svg> precisely so this count is the edge count).
    const edges = screen.getByTestId('canvas-edges');
    expect(edges.querySelectorAll('path')).toHaveLength(1);
    // …and the legend, which only appears when the level HAS dependency edges.
    expect(screen.getByTestId('edge-legend')).toBeTruthy();
  });

  it('SEARCHES a level holding committed nodes without throwing, and locates one by identifier', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // Before the fix `searchText` was undefined on every committed node and
    // `searchMatches` threw on the first keystroke.
    fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
      target: { value: 'MOTIR-9' },
    });

    expect(el(SUB_ID)!.querySelector('[data-highlighted]')).toBeTruthy();
    expect(el(STORY_ID)!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('opens on the committed ANCESTOR CHAIN, not one synthesised crumb', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('MOTIR-2200 · The Motir agent loop')).toBeTruthy();
    expect(within(nav).getByText('MOTIR-3070 · The plan review surface is narrower')).toBeTruthy();
    // The root crumb goes to the project roadmap root, so it is NOT labelled
    // "Plan" — that named a destination it does not have.
    expect(within(nav).queryByText('Plan')).toBeNull();
    expect(within(nav).getByText('Roadmap')).toBeTruthy();
  });

  it('leaves a working control on screen at EVERY crumb up to and including the root', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

    // One step up: the ancestor's own level, with the level we came from on it.
    fireEvent.click(within(nav()).getByText('MOTIR-2200 · The Motir agent loop'));
    expect(await screen.findByText('MOTIR-3070')).toBeTruthy();
    selectNode(BUG_ID);
    expect(within(el(BUG_ID) as HTMLElement).getByTestId('drill-button')).toBeTruthy();

    // The ROOT crumb. The breadcrumb legitimately unmounts here (there is
    // nothing left to walk) — what must NOT happen is the level below it going
    // blank, which is exactly what stranded the reporter.
    fireEvent.click(within(nav()).getByText('Roadmap'));
    expect(await screen.findByText('MOTIR-2200')).toBeTruthy();
    selectNode(EPIC_ID);
    expect(within(el(EPIC_ID) as HTMLElement).getByTestId('drill-button')).toBeTruthy();
  });

  it('peeks a committed sibling by its IDENTIFIER, not by its canvas node id', async () => {
    // A committed node is `viewable` now, so its View button is reachable for the
    // first time — and the peek reads `?key=MOTIR-<n>` while the canvas hands the
    // handler a cuid. Without the id → identifier mapping this asks for a key no
    // work item has.
    const fetchMock = stubRoadmap();
    mount();
    await screen.findByText('MOTIR-7');

    selectNode(STORY_ID);
    fireEvent.click(within(el(STORY_ID) as HTMLElement).getByTestId('view-button'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek?key=MOTIR-7')),
      ).toBe(true),
    );
  });

  // ── The PROPOSED half of the same contract ────────────────────────────────
  // `viewable` is what surfaces the View pill, and `mergePlanLevel` pushed every
  // proposal without it. So MOTIR-3084's proposal peek — the whole read view for
  // a proposed card — was unreachable from the canvas it was built for: the
  // handler existed, the modal existed, and no affordance opened either. Same
  // missing flag as the committed nodes above, other half of the merge.
  it('offers View on a selected PROPOSAL and opens its peek — no work item needed', async () => {
    const fetchMock = stubRoadmap();
    mount();
    await screen.findByText('A proposed subtask');

    selectNode('pi_1');
    fireEvent.click(within(el('pi_1') as HTMLElement).getByTestId('view-button'));

    // The PROPOSAL peek, not the work-item one: an `add` has no work item, so
    // nothing may be asked of `/api/work-items/peek` on its behalf.
    const peek = await screen.findByTestId('proposal-quick-view');
    expect(within(peek).getByText('A proposed subtask')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek'))).toBe(
      false,
    );
  });

  it('peeks a DRIFTED modify by the live target it names, not as a proposal', async () => {
    // A `modify` whose target is not at this level is pushed as its own node by
    // the same branch as an `add` — it is viewable too, and it names a real work
    // item, so View opens the SHIPPED work-item peek keyed by that identifier.
    const fetchMock = stubRoadmap();
    mount([
      proposal({
        planItemId: 'pi_mod',
        nodeId: 'pi_mod',
        op: 'modify',
        identifier: 'MOTIR-3083',
        title: 'A drifted modify',
        changes: [],
      }),
    ]);
    await screen.findByText('A drifted modify');

    selectNode('pi_mod');
    fireEvent.click(within(el('pi_mod') as HTMLElement).getByTestId('view-button'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes('/api/work-items/peek?key=MOTIR-3083'),
        ),
      ).toBe(true),
    );
    expect(screen.queryByTestId('proposal-quick-view')).toBeNull();
  });

  it('degrades to the proposals alone when there is no project to read a level from', async () => {
    const fetchMock = stubRoadmap();
    render(<PlanReviewCanvas items={[proposal()]} projectKey="" version={0} />);

    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to the proposals alone when the level read FAILS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    // A root proposal, so the canvas opens at the top level.
    mount([proposal({ parentNodeId: null, parentIdentifier: null, parentTrail: [] })]);

    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('MOTIR-7')).toBeNull());
  });
});
