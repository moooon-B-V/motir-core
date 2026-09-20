// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { arrivalLevel, PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { mergePlanLevel, proposalsAtLevel } from '@/components/planning/planLevel';
import { fullestContainer, planContainerCount } from '@/lib/planning/planShape';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { planReviewItem } from '../helpers/planReview';

// Bug MOTIR-5782 · MOTIR-5795 — the PLAN-REVIEW canvas (`/plans/[id]`) draws folders.
//
// `design/ai-planning/design-notes.md` Part XVIII: the committed tree is
// `/roadmap`'s (decision 1); a proposal sits on the level it will SIT on — its
// folder when it is folder-placed (decision 2), and the arrival rule counts it
// there, folder crumbs counted in the depth tie-break (§18.2); a closed folder
// holding proposals is badged and ringed under Show changes (decision 3); a move
// into a folder is drawn once, at its destination (decision 4); the folder crumb
// navigates, retiring MOTIR-5418's text segment (decision 5); a proposal whose
// folder was deleted stays at the root (decision 6).

const PARKED = { id: 'f1', name: 'Parked' };
const Y2025 = { id: 'f2', name: '2025' };
const LATER = { id: 'f0', name: 'Later' };

function filedAdd(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_filed',
    nodeId: 'pi_filed',
    title: 'Importer retries with backoff',
    kind: 'story',
    folderId: Y2025.id,
    folderPath: ['Parked', '2025'],
    folderTrail: [PARKED, Y2025],
    ...over,
  });
}

const rootAdd = (n: number, over: Partial<PlanReviewItemDto> = {}) =>
  planReviewItem({
    planItemId: `pi_root${n}`,
    nodeId: `pi_root${n}`,
    title: `Root proposal ${n}`,
    kind: 'story',
    ...over,
  });

function moveIntoParked(): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_move',
    nodeId: 'wi_moving',
    op: 'modify',
    identifier: 'MOTIR-4210',
    title: 'Bulk re-import from a saved mapping',
    kind: 'story',
    folderId: PARKED.id,
    folderPath: ['Parked'],
    folderTrail: [PARKED],
    changes: [
      {
        field: 'parent',
        from: null,
        to: 'Parked',
        placement: {
          from: { kind: 'root' },
          to: { kind: 'folder', folderId: PARKED.id, folderPath: ['Parked'], folderMissing: false },
        },
      },
    ],
  });
}

const stale = () =>
  filedAdd({
    planItemId: 'pi_stale',
    nodeId: 'pi_stale',
    folderPath: null,
    folderMissing: true,
    folderTrail: [],
  });

const ids = (level: { nodes: { id: string }[] }) => level.nodes.map((n) => n.id);
const EMPTY = { nodes: [], deps: [] };

describe('planLevel — where a proposal SITS on the review canvas (decisions 2, 4, 6)', () => {
  it('a filed add sits on its folder level, not the root', () => {
    const items = [filedAdd()];
    expect(proposalsAtLevel(items, null)).toEqual([]);
    expect(proposalsAtLevel(items, 'folder:f2').map((i) => i.nodeId)).toEqual(['pi_filed']);
    expect(ids(mergePlanLevel(EMPTY, items, 'folder:f2'))).toEqual(['pi_filed']);
    expect(ids(mergePlanLevel(EMPTY, items, null))).toEqual([]);
  });

  it('an unfiled root add stays at the root', () => {
    const items = [rootAdd(1)];
    expect(ids(mergePlanLevel(EMPTY, items, null))).toEqual(['pi_root1']);
    expect(arrivalLevel(items, 'New')).toBeNull();
  });

  it('a modify moving a card INTO a folder is drawn on the folder, never at its source', () => {
    const items = [moveIntoParked()];
    expect(proposalsAtLevel(items, null)).toEqual([]);
    const level = mergePlanLevel(EMPTY, items, 'folder:f1');
    expect(ids(level)).toEqual(['wi_moving']);
    expect(level.nodes[0]!.parentId).toBe('folder:f1');
  });

  it('a proposal whose folder was DELETED stays at the root, with no folder level to arrive on', () => {
    const items = [stale()];
    expect(ids(mergePlanLevel(EMPTY, items, null))).toEqual(['pi_stale']);
    expect(arrivalLevel(items, 'New')).toBeNull();
  });
});

describe('the arrival level counts FOLDER levels (Part XVIII §18.2)', () => {
  it('a plan that files everything into ONE folder arrives on that folder, behind its folder crumbs', () => {
    const items = [
      filedAdd(),
      filedAdd({ planItemId: 'pi_filed2', nodeId: 'pi_filed2', title: 'Second' }),
    ];
    expect(arrivalLevel(items, 'New')).toEqual({
      id: 'folder:f2',
      trail: [
        { id: 'folder:f1', label: 'Parked' },
        { id: 'folder:f2', label: '2025' },
      ],
    });
  });

  it('a filing into two folders arrives on the one holding more', () => {
    const later = (n: number) =>
      rootAdd(n, { folderId: LATER.id, folderPath: ['Later'], folderTrail: [LATER] });
    const items = [filedAdd(), later(1), later(2)];
    expect(arrivalLevel(items, 'New')?.id).toBe('folder:f0');
  });

  it('on a tie, the deeper folder wins; on an exact tie, the level of the plan’s first proposal', () => {
    const inLater = rootAdd(1, { folderId: LATER.id, folderPath: ['Later'], folderTrail: [LATER] });
    // Deeper: 2025 sits two crumbs down, Later one.
    expect(arrivalLevel([inLater, filedAdd()], 'New')?.id).toBe('folder:f2');
    // Exact tie: first in list order.
    const inParked = rootAdd(2, {
      folderId: PARKED.id,
      folderPath: ['Parked'],
      folderTrail: [PARKED],
    });
    expect(arrivalLevel([inLater, inParked], 'New')?.id).toBe('folder:f0');
    expect(arrivalLevel([inParked, inLater], 'New')?.id).toBe('folder:f1');
  });

  it('a committed parent filed in a folder leads its trail with that folder', () => {
    const child = (n: number) =>
      planReviewItem({
        planItemId: `pi_c${n}`,
        nodeId: `pi_c${n}`,
        parentNodeId: 'E1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Road epic',
        parentTrail: [{ id: 'E1', identifier: 'MOTIR-1', title: 'Road epic' }],
        folderTrail: [PARKED],
        kind: 'story',
        title: `Child ${n}`,
      });
    const arrival = arrivalLevel([child(1), child(2)], 'New');
    expect(arrival?.id).toBe('E1');
    expect(arrival?.trail.map((c) => c.id)).toEqual(['folder:f1', 'E1']);
  });

  it('leaves the shipped count — the review read’s and the derived view’s — as it was', () => {
    const items = [filedAdd(), rootAdd(1)];
    expect(fullestContainer(items)).toBeNull();
    expect(planContainerCount(items)).toBe(1);
  });
});

// ── Over the wire ─────────────────────────────────────────────────────────────

function wireNode(id: string, title: string, kind: RoadmapLevelData['items'][number]['kind']) {
  return {
    id,
    parentId: null,
    kind,
    type: null,
    executor: null,
    identifier: `MOTIR-${id}`,
    title,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren: false,
    progress: null,
    ready: false,
  };
}

const wireFolder = (id: string, name: string, childFolderCount: number, itemCount: number) => ({
  id,
  parentFolderId: null,
  name,
  position: 'a0',
  childFolderCount,
  itemCount,
});

/** Serve levels keyed by the request's address: `folderId`, else `parentId`, else root. */
function serve(tree: Record<string, unknown>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://localhost');
    if (u.pathname === '/api/work-items/peek') return { ok: false, status: 404 } as Response;
    const key = u.searchParams.get('folderId') ?? u.searchParams.get('parentId') ?? '__root__';
    return {
      ok: true,
      json: async () => tree[key] ?? { nodes: [], edges: [], offLevelBlockers: [] },
    } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);
const urls = (spy: ReturnType<typeof serve>) => spy.mock.calls.map(([u]) => String(u));

async function drill(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
  fireEvent.click(within(el(id) as HTMLElement).getByTestId('drill-button'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlanReviewCanvas — folders over the wire (decisions 1, 3, 4, 5)', () => {
  const tree = {
    __root__: {
      nodes: [wireNode('E1', 'Road epic', 'epic'), wireNode('wi_moving', 'Moving', 'story')],
      edges: [],
      offLevelBlockers: [],
      folders: [wireFolder('f1', 'Parked', 1, 1), wireFolder('f0', 'Later', 0, 0)],
    },
    f1: {
      nodes: [wireNode('B9', 'Filed bug', 'bug')],
      edges: [],
      offLevelBlockers: [],
      folders: [wireFolder('f2', '2025', 0, 0)],
    },
    f2: { nodes: [], edges: [], offLevelBlockers: [], folders: [] },
    f0: { nodes: [], edges: [], offLevelBlockers: [], folders: [] },
  };
  // Two root adds hold the root, so the canvas arrives there.
  const atRoot = [rootAdd(1), rootAdd(2), filedAdd()];

  it('reads the folder-aware root, draws the folder cards, and badges + rings the one holding proposals', async () => {
    const spy = serve(tree);
    render(<PlanReviewCanvas items={atRoot} projectKey="MOTIR" version={0} />);

    expect(await screen.findByText('Parked')).toBeTruthy();
    await act(async () => {});
    expect(urls(spy)[0]).toBe('/api/projects/MOTIR/roadmap?folders=1');
    expect(el('folder:f1')).toBeTruthy();
    expect(el('folder:f0')).toBeTruthy();
    // The filed proposal is NOT loose at the root (decision 2)…
    expect(el('pi_filed')).toBeNull();
    expect(el('pi_root1')).toBeTruthy();
    // …and the folder it sits under says so, deep (decision 3); the empty one does not.
    expect(within(el('folder:f1') as HTMLElement).getByTestId('folder-changes').textContent).toBe(
      '1 change',
    );
    expect(within(el('folder:f0') as HTMLElement).queryByTestId('folder-changes')).toBeNull();
    // Show changes is armed on arrival and rings the folder like a card.
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-emphasised] [data-node-id="folder:f1"], [data-node-id="folder:f1"] [data-emphasised], [data-node-id="folder:f1"][data-emphasised]',
        ),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector(
        '[data-emphasised] [data-node-id="folder:f0"], [data-node-id="folder:f0"] [data-emphasised], [data-node-id="folder:f0"][data-emphasised]',
      ),
    ).toBeNull();
  });

  it('drills a folder by folderId to its folders then its items; the folder crumb navigates back', async () => {
    const spy = serve(tree);
    render(<PlanReviewCanvas items={atRoot} projectKey="MOTIR" version={0} />);
    await screen.findByText('Parked');

    await drill('folder:f1');
    expect(await screen.findByText('Filed bug')).toBeTruthy();
    expect(el('folder:f2')).toBeTruthy();
    await waitFor(() =>
      expect(urls(spy)).toContain('/api/projects/MOTIR/roadmap?folders=1&folderId=f1'),
    );

    await drill('folder:f2');
    await waitFor(() => expect(el('pi_filed')).toBeTruthy());
    // The node spends no slot on its folder — the crumb says where it is (decision 2).
    expect(screen.queryByTestId('placement-line')).toBeNull();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(within(nav).getByRole('button', { name: /Parked/ }));
    await waitFor(() => expect(el('B9')).toBeTruthy());
    expect(el('pi_filed')).toBeNull();
  });

  it('arrives on the folder a plan files into, reading it by folderId', async () => {
    const spy = serve(tree);
    render(<PlanReviewCanvas items={[filedAdd()]} projectKey="MOTIR" version={0} />);
    await waitFor(() => expect(el('pi_filed')).toBeTruthy());
    expect(urls(spy)).toContain('/api/projects/MOTIR/roadmap?folders=1&folderId=f2');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('button', { name: /Parked/ })).toBeTruthy();
  });

  it('draws a move into a folder once — off the root, onto the folder', async () => {
    serve(tree);
    render(
      <PlanReviewCanvas
        items={[rootAdd(1), rootAdd(2), moveIntoParked()]}
        projectKey="MOTIR"
        version={0}
      />,
    );
    await screen.findByText('Parked');
    await act(async () => {});
    expect(el('wi_moving')).toBeNull();
    await drill('folder:f1');
    await waitFor(() => expect(el('wi_moving')).toBeTruthy());
    expect(el('B9')).toBeTruthy();
  });

  it('an EMPTY folder’s level says so in folder words', async () => {
    serve(tree);
    render(<PlanReviewCanvas items={atRoot} projectKey="MOTIR" version={0} />);
    await screen.findByText('Later');
    await drill('folder:f0');
    expect(await screen.findByText('This folder is empty')).toBeTruthy();
  });
});
