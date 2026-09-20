// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanChangeCanvas } from '@/components/planning/PlanChangeCanvas';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { indexPlanReview, proposedAddsForLevel } from '@/lib/planning/planChangeDiff';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { planReview, planReviewItem } from '../helpers/planReview';

// Bug MOTIR-5782 · MOTIR-5794 — the plan-change OVERLAY's canvas draws folders.
//
// `design/ai-planning/design-notes.md` Part XVIII: the committed tree is
// `/roadmap`'s (decision 1), a proposal is drawn on the level where it will SIT —
// its folder when it is folder-placed (decision 2), a closed folder holding
// proposals carries a `changes` badge (decision 3), a folder move is drawn once,
// at its destination (decision 4), the folder crumb navigates (decision 5), and a
// proposal whose folder was deleted stays at the root (decision 6).

const PARKED = { id: 'f1', name: 'Parked' };
const Y2025 = { id: 'f2', name: '2025' };

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

function moveIntoParked(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
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
    ...over,
  });
}

function wireNode(
  id: string,
  title: string,
  kind: RoadmapLevelData['items'][number]['kind'] = 'story',
  hasChildren = false,
) {
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
    hasChildren,
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

function levelData(items: RoadmapLevelData['items'], folders: RoadmapLevelData['folders'] = []) {
  return { items, edges: [], offLevelBlockers: [], folders } as RoadmapLevelData;
}

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

async function drill(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
  fireEvent.click(within(el(id) as HTMLElement).getByTestId('drill-button'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('indexPlanReview — where a proposal SITS (decisions 2, 4, 6)', () => {
  it('keys a filed add on its folder LEVEL, and leaves an unfiled root add at the root', () => {
    const plain = planReviewItem({ planItemId: 'pi_plain', nodeId: 'pi_plain', title: 'Plain' });
    const index = indexPlanReview(planReview([filedAdd(), plain]));

    expect(proposedAddsForLevel(index, 'folder:f2').map((a) => a.item.planItemId)).toEqual([
      'pi_filed',
    ]);
    expect(proposedAddsForLevel(index, null).map((a) => a.item.planItemId)).toEqual(['pi_plain']);
  });

  it('keeps a proposal whose folder was DELETED at the root — there is no level to put it on', () => {
    const stale = filedAdd({ folderPath: null, folderMissing: true, folderTrail: [] });
    const index = indexPlanReview(planReview([stale]));

    expect(proposedAddsForLevel(index, null)).toHaveLength(1);
    expect(proposedAddsForLevel(index, 'folder:f2')).toHaveLength(0);
    expect(index.folderChanges.size).toBe(0);
  });

  it('counts DEEP: every folder on each proposal’s trail, once per proposal', () => {
    const index = indexPlanReview(planReview([filedAdd(), moveIntoParked()]));

    expect(index.folderChanges.get(PARKED.id)).toBe(2);
    expect(index.folderChanges.get(Y2025.id)).toBe(1);
  });

  it('records a move INTO a folder as a relocation, root → folder level', () => {
    const index = indexPlanReview(planReview([moveIntoParked()]));

    expect(index.relocations).toHaveLength(1);
    expect(index.relocations[0]).toMatchObject({ fromLevel: null, toLevel: 'folder:f1' });
  });

  it('does not record a move between two WORK ITEMS — the overlay draws those as it always has', () => {
    const reparent = moveIntoParked({
      folderId: null,
      folderPath: null,
      folderTrail: [],
      changes: [
        {
          field: 'parent',
          from: 'MOTIR-1',
          to: 'MOTIR-2',
          placement: {
            from: { kind: 'workItem', id: 'wi_1', identifier: 'MOTIR-1' },
            to: { kind: 'workItem', id: 'wi_2', identifier: 'MOTIR-2' },
          },
        },
      ],
    });
    expect(indexPlanReview(planReview([reparent])).relocations).toHaveLength(0);
  });

  it('tolerates a payload with no trail (an older server) — no folder, no throw', () => {
    const legacy = { ...filedAdd() } as Partial<PlanReviewItemDto>;
    delete legacy.folderTrail;
    expect(() => indexPlanReview(planReview([legacy as PlanReviewItemDto]))).not.toThrow();
  });
});

describe('decoratePlanChangeLevel — a folder move is drawn once, at its DESTINATION (decision 4)', () => {
  const rootRead = levelData([wireNode('wi_moving', 'Bulk re-import from a saved mapping')], []);

  it('takes the moving card OFF its source level', () => {
    const index = indexPlanReview(planReview([moveIntoParked()]));
    const level = decoratePlanChangeLevel(buildWorkItemLevel(rootRead), rootRead, index, null);
    expect(level.nodes.map((n) => n.id)).not.toContain('wi_moving');
  });

  it('draws it on the destination folder’s level, framed as a change with its Placement line', () => {
    const index = indexPlanReview(planReview([moveIntoParked()]));
    const folderRead = levelData([], []);
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(folderRead),
      folderRead,
      index,
      'folder:f1',
    );
    expect(level.nodes.map((n) => n.id)).toEqual(['wi_moving']);
    render(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('diff-line').textContent).toContain('Placement');
  });

  it('once APPROVED the read already carries it there, and it is not drawn a second time', () => {
    const index = indexPlanReview(planReview([moveIntoParked()]));
    const folderRead = levelData([wireNode('wi_moving', 'Bulk re-import from a saved mapping')]);
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(folderRead),
      folderRead,
      index,
      'folder:f1',
    );
    expect(level.nodes.filter((n) => n.id === 'wi_moving')).toHaveLength(1);
  });
});

describe('PlanChangeCanvas — folders over the wire (decisions 1, 2, 3, 5)', () => {
  const tree = {
    __root__: {
      nodes: [wireNode('E1', 'Road epic', 'epic', true)],
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

  it('reads the folder-aware root, draws the folder cards, and badges the one holding proposals', async () => {
    const spy = serve(tree);
    const index = indexPlanReview(planReview([filedAdd()]));
    render(<PlanChangeCanvas projectKey="MOTIR" index={index} diffKey="k1" />);

    expect(await screen.findByText('Parked')).toBeTruthy();
    await act(async () => {});
    expect(String(spy.mock.calls[0]![0])).toBe('/api/projects/MOTIR/roadmap?folders=1');
    expect(el('folder:f1')).toBeTruthy();
    expect(el('folder:f0')).toBeTruthy();
    // The filed proposal is NOT at the root (decision 2)…
    expect(el('proposed:pi_filed')).toBeNull();
    // …and the folder it sits under says so, deep (decision 3); the empty one does not.
    expect(within(el('folder:f1') as HTMLElement).getByTestId('folder-changes').textContent).toBe(
      '1 change',
    );
    expect(within(el('folder:f0') as HTMLElement).queryByTestId('folder-changes')).toBeNull();
    expect(
      within(el('folder:f1') as HTMLElement)
        .getByTestId('folder-node')
        .getAttribute('aria-label'),
    ).toContain('1 proposed change inside');
  });

  it('drills folder by folder to where the proposal sits, reading each level by folderId, and a folder crumb navigates back', async () => {
    const spy = serve(tree);
    const index = indexPlanReview(planReview([filedAdd()]));
    render(<PlanChangeCanvas projectKey="MOTIR" index={index} diffKey="k1" />);
    await screen.findByText('Parked');

    await drill('folder:f1');
    expect(await screen.findByText('Filed bug')).toBeTruthy();
    expect(el('folder:f2')).toBeTruthy();
    await waitFor(() =>
      expect(spy.mock.calls.map(([u]) => String(u))).toContain(
        '/api/projects/MOTIR/roadmap?folders=1&folderId=f1',
      ),
    );

    await drill('folder:f2');
    await waitFor(() => expect(el('proposed:pi_filed')).toBeTruthy());
    expect(screen.getByText('Importer retries with backoff')).toBeTruthy();
    // The node spends no slot on its folder — the crumb says where it is (decision 2).
    expect(screen.queryByTestId('placement-line')).toBeNull();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const parkedCrumb = within(nav).getByRole('button', { name: /Parked/ });
    fireEvent.click(parkedCrumb);
    await waitFor(() => expect(el('B9')).toBeTruthy());
    expect(el('proposed:pi_filed')).toBeNull();
    // Back on Parked's level, 2025 still carries the proposal's badge.
    expect(within(el('folder:f2') as HTMLElement).getByTestId('folder-changes').textContent).toBe(
      '1 change',
    );
  });

  it('an EMPTY folder’s level says so in folder words', async () => {
    serve(tree);
    render(
      <PlanChangeCanvas
        projectKey="MOTIR"
        index={indexPlanReview(planReview([filedAdd()]))}
        diffKey="k1"
      />,
    );
    await screen.findByText('Later');
    await drill('folder:f0');
    expect(await screen.findByText('This folder is empty')).toBeTruthy();
  });
});
