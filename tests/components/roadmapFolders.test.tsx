// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { FolderNode } from '@/components/planning/WorkItemNode';
import {
  buildWorkItemLevel,
  folderIdFromNodeId,
  folderNodeId,
  LEVEL_MORE_ID,
  NOT_IN_EPIC_ID,
} from '@/components/planning/workItemLevel';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import {
  breadcrumbSegments,
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type {
  RoadmapLevelData,
  RoadmapLevelFolder,
  RoadmapLevelItem,
} from '@/lib/planning/roadmapClient';

// FOLDERS ON THE ROADMAP CANVAS (Bug MOTIR-5710 · MOTIR-5741; design
// `design/roadmap/roadmap--folder-node.mock.html` sheets 2, 3, 4 and 6). Three
// layers, each asserted where it lives: the FolderNode's own slots, the level
// builder's placement and flags, and the adapter → canvas seam driven from the
// real wire shape (only `fetch` is stubbed). Happy-dom, no jest-dom matchers.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(over: Partial<RoadmapLevelItem> & { id: string }): RoadmapLevelItem {
  return {
    parentId: null,
    identifier: over.id,
    title: `Title ${over.id}`,
    kind: 'epic',
    status: 'todo',
    hasChildren: false,
    progress: null,
    ...over,
  };
}

function folder(over: Partial<RoadmapLevelFolder> & { id: string }): RoadmapLevelFolder {
  return {
    parentFolderId: null,
    name: `Folder ${over.id}`,
    position: 'a0',
    childFolderCount: 0,
    itemCount: 0,
    ...over,
  };
}

function level(
  items: RoadmapLevelItem[],
  folders: RoadmapLevelFolder[] = [],
  extra: Partial<RoadmapLevelData> = {},
): RoadmapLevelData {
  return { items, edges: [], offLevelBlockers: [], folders, ...extra };
}

describe('FolderNode — the shipped node box, slot by slot (sheet 2)', () => {
  it.each([
    [0, 794, '794 items'],
    [0, 1, '1 item'],
    [2, 5, '2 folders · 5 items'],
    [3, 0, '3 folders'],
    [1, 0, '1 folder'],
    [0, 0, 'Empty'],
  ])('%i folders + %i items reads “%s”', (childFolderCount, itemCount, expected) => {
    render(<FolderNode name="Parked" childFolderCount={childFolderCount} itemCount={itemCount} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('names the folder, speaks the contents, and draws no status pill or meter', () => {
    render(<FolderNode name="Fixed bugs 2026-09-18" childFolderCount={0} itemCount={794} />);
    const node = screen.getByTestId('folder-node');
    expect(node.getAttribute('aria-label')).toBe(
      'Folder Fixed bugs 2026-09-18, 794 items. Open to see what is filed in it.',
    );
    expect(screen.getByText('Fixed bugs 2026-09-18')).toBeTruthy();
    expect(node.querySelector('[data-testid="drill-affordance"]')).toBeTruthy();
    // No status pill — the shipped pill always names a status (e.g. "To Do").
    expect(within(node).queryByText('To Do')).toBeNull();
    expect(node.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe('buildWorkItemLevel — folders on a level (decisions 2–5)', () => {
  it('mints a folder node id the consumer can read back', () => {
    expect(folderNodeId('f1')).toBe('folder:f1');
    expect(folderIdFromNodeId('folder:f1')).toBe('f1');
    expect(folderIdFromNodeId('cmu891x0n0023hwoineie8yon')).toBeNull();
    expect(folderIdFromNodeId(null)).toBeNull();
  });

  it('at the ROOT: epics, then the folders in read order, then Not in an epic (the /items root order)', () => {
    const { nodes } = buildWorkItemLevel(
      level(
        [item({ id: 'E1' }), item({ id: 'B1', kind: 'bug' })],
        [folder({ id: 'fA' }), folder({ id: 'fZ' })],
      ),
      { groupNonEpicRoots: true },
    );
    const ids = nodes.map((n) => n.id);
    expect(ids.indexOf('E1')).toBeLessThan(ids.indexOf('folder:fA'));
    expect(ids.indexOf('folder:fA')).toBeLessThan(ids.indexOf('folder:fZ'));
    expect(ids.indexOf('folder:fZ')).toBeLessThan(ids.indexOf(NOT_IN_EPIC_ID));
  });

  it('INSIDE a folder: its child folders lead, then its filed items — an epic included', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'E9' }), item({ id: 'B9', kind: 'bug' })], [folder({ id: 'f2' })]),
    );
    const ids = nodes.map((n) => n.id);
    expect(ids.indexOf('folder:f2')).toBeLessThan(ids.indexOf('E9'));
    expect(ids.indexOf('folder:f2')).toBeLessThan(ids.indexOf('B9'));
    expect(ids).not.toContain(NOT_IN_EPIC_ID);
  });

  it('a folder is a DOOR: drillable, not viewable, not decorative, crumb = its name', () => {
    const { nodes } = buildWorkItemLevel(level([], [folder({ id: 'f1', name: 'Parked' })]));
    const f = nodes.find((n) => n.id === 'folder:f1')!;
    expect(f.drillable).toBe(true);
    expect(f.viewable).toBe(false);
    expect(f.decorative).toBeFalsy();
    expect(f.crumbLabel).toBe('Parked');
    expect(f.searchText).toBe('Parked');
  });

  it('an EMPTY folder is still drawn, and is still a door', () => {
    const { nodes } = buildWorkItemLevel(level([], [folder({ id: 'f0' })]));
    expect(nodes.find((n) => n.id === 'folder:f0')?.drillable).toBe(true);
  });

  it('a folder is never an edge end', () => {
    const { deps } = buildWorkItemLevel(
      level([item({ id: 'E1' }), item({ id: 'E2' })], [folder({ id: 'f1' })], {
        edges: [{ blockedId: 'E2', blockerId: 'E1' }],
      }),
    );
    expect(deps.every((d) => !d.from.startsWith('folder:') && !d.to.startsWith('folder:'))).toBe(
      true,
    );
  });

  it('the truncation tile counts WORK ITEMS only, and the folders are drawn anyway (decision 4)', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'E1' }), item({ id: 'E2' })], [folder({ id: 'f1' }), folder({ id: 'f2' })]),
      { levelTotal: 3 },
    );
    expect(nodes.filter((n) => n.id.startsWith('folder:'))).toHaveLength(2);
    const tile = nodes.find((n) => n.id === LEVEL_MORE_ID)!;
    render(<>{tile.content}</>);
    expect(screen.getByText('Showing 2 of 3')).toBeTruthy();
  });
});

// ─────────────── THE ADAPTER → CANVAS SEAM, from the wire shape ───────────────

const wireNode = (id: string, title: string, kind = 'epic', hasChildren = false) => ({
  id,
  parentId: null,
  kind,
  identifier: `MOTIR-${id}`,
  title,
  status: 'todo',
  isDone: false,
  hasChildren,
});

/** Serve levels keyed by the request's address: `folderId`, else `parentId`, else root. */
function serve(tree: Record<string, unknown>) {
  const spy = vi.fn(async (url: string) => {
    const u = new URL(String(url), 'http://localhost');
    const key = u.searchParams.get('folderId') ?? u.searchParams.get('parentId') ?? '__root__';
    return {
      ok: true,
      json: async () => tree[key] ?? { nodes: [], edges: [], offLevelBlockers: [] },
    };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);
const wireFolder = (id: string, name: string, childFolderCount: number, itemCount: number) => ({
  id,
  parentFolderId: null,
  name,
  position: 'a0',
  childFolderCount,
  itemCount,
});

describe('WorkItemRoadmap — folders end to end over the wire', () => {
  it('asks for the folder-aware root, draws the folder, and a lone epic + folder does NOT auto-descend', async () => {
    const spy = serve({
      __root__: {
        nodes: [wireNode('E1', 'Road epic', 'epic', true)],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f1', 'Parked', 0, 2)],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);

    expect(await screen.findByText('Parked')).toBeTruthy();
    await act(async () => {});
    expect(el('E1')).toBeTruthy();
    expect(el('folder:f1')).toBeTruthy();
    expect(String(spy.mock.calls[0]![0])).toBe('/api/projects/MOTIR/roadmap?folders=1');
  });

  it('drilling a folder reads its level by folderId and shows its folders, then its items', async () => {
    const spy = serve({
      __root__: {
        nodes: [wireNode('E1', 'Road epic')],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f1', 'Parked', 1, 1)],
      },
      f1: {
        nodes: [wireNode('B9', 'Filed bug', 'bug')],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f2', 'Inner', 0, 0)],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Parked');
    fireEvent.keyDown(el('folder:f1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));

    expect(await screen.findByText('Filed bug')).toBeTruthy();
    expect(el('folder:f2')).toBeTruthy();
    // No grouped node inside a folder (decision 2).
    expect(el(NOT_IN_EPIC_ID)).toBeNull();
    await waitFor(() =>
      expect(spy.mock.calls.map(([u]) => String(u))).toContain(
        '/api/projects/MOTIR/roadmap?folders=1&folderId=f1',
      ),
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Parked')).toBeTruthy();
  });

  it('an EMPTY folder’s level says so in folder words, not the generic drilled-empty copy', async () => {
    serve({
      __root__: {
        nodes: [wireNode('E1', 'Road epic')],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f0', 'Later', 0, 0)],
      },
      f0: { nodes: [], edges: [], offLevelBlockers: [], folders: [] },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Later');
    fireEvent.keyDown(el('folder:f0')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));

    expect(await screen.findByText('This folder is empty')).toBeTruthy();
    expect(
      screen.getByText('Work items filed into Later from Work items will show here.'),
    ).toBeTruthy();
    expect(screen.queryByText('This node has no children to show.')).toBeNull();
  });

  it('sprint scope asks for no folders and draws none (decision 6)', async () => {
    const spy = serve({
      __root__: {
        nodes: [wireNode('S1', 'Sprint story', 'story')],
        edges: [],
        offLevelBlockers: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" scope="sprint" />);
    await screen.findByText('Sprint story');

    expect(String(spy.mock.calls[0]![0])).toBe('/api/projects/MOTIR/roadmap?scope=sprint');
    expect(document.querySelector('[data-node-id^="folder:"]')).toBeNull();
  });

  it('a subtree-rooted mount asks for no folders', async () => {
    const spy = serve({});

    render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="E1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());

    expect(String(spy.mock.calls[0]![0])).toBe('/api/projects/MOTIR/roadmap?parentId=E1');
  });
});

// ─────────────── MOTIR-5742 · the folder CRUMB navigates ───────────────

describe('breadcrumbSegments — a folder run longer than three collapses from the middle', () => {
  const crumb = (id: string, label = id) => ({ id, label });
  const isFolder = (c: { id: string }) => c.id.startsWith('folder:');

  it('keeps a run of up to three folders whole', () => {
    const crumbs = [crumb('folder:a'), crumb('folder:b'), crumb('folder:c'), crumb('E1')];
    expect(breadcrumbSegments(crumbs, isFolder)).toEqual([
      { kind: 'crumb', index: 0, folder: true },
      { kind: 'crumb', index: 1, folder: true },
      { kind: 'crumb', index: 2, folder: true },
      { kind: 'crumb', index: 3, folder: false },
    ]);
  });

  it('collapses five folders to first ▸ … ▸ last, the … naming the folder above the last', () => {
    const crumbs = ['a', 'b', 'c', 'd', 'e'].map((x) => crumb(`folder:${x}`, x.toUpperCase()));
    expect(breadcrumbSegments([...crumbs, crumb('E1')], isFolder)).toEqual([
      { kind: 'crumb', index: 0, folder: true },
      { kind: 'ellipsis', targetIndex: 3, path: ['A', 'B', 'C', 'D', 'E'] },
      { kind: 'crumb', index: 4, folder: true },
      { kind: 'crumb', index: 5, folder: false },
    ]);
  });

  it('never collapses work-item crumbs', () => {
    const crumbs = ['1', '2', '3', '4', '5'].map((x) => crumb(`E${x}`));
    expect(breadcrumbSegments(crumbs, isFolder).every((s) => s.kind === 'crumb')).toBe(true);
  });
});

describe('ProjectRoadmapCanvas — folder crumbs', () => {
  const trail = ['A', 'B', 'C', 'D', 'E'].map((x) => ({ id: `folder:${x}`, label: `Folder ${x}` }));

  function renderAt() {
    const loadLevel = vi.fn(
      async (): Promise<RoadmapLevel> => ({
        nodes: [
          { id: 'n1', parentId: null, content: <div>Card</div>, searchText: 'Card' },
          { id: 'n2', parentId: null, content: <div>Card two</div>, searchText: 'Card two' },
        ],
        deps: [],
      }),
    );
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        initialTrail={trail}
        isFolderCrumb={(c) => c.id.startsWith('folder:')}
      />,
    );
    return loadLevel;
  }

  it('draws each shown folder as a Crumb button named “Folder: <name>”, and a … with the full path', async () => {
    renderAt();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('button', { name: 'Folder: Folder A' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Folder: Folder E' })).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: 'Folder: Folder C' })).toBeNull();
    const more = within(nav).getByRole('button', {
      name: 'Folder A ▸ Folder B ▸ Folder C ▸ Folder D ▸ Folder E',
    });
    expect(more.getAttribute('title')).toBe('Folder A ▸ Folder B ▸ Folder C ▸ Folder D ▸ Folder E');
    expect(
      within(nav).getByRole('button', { name: 'Folder: Folder E' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('the … navigates to the folder just above the last one shown', async () => {
    const loadLevel = renderAt();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(
      within(nav).getByRole('button', {
        name: 'Folder A ▸ Folder B ▸ Folder C ▸ Folder D ▸ Folder E',
      }),
    );
    await waitFor(() => expect(loadLevel).toHaveBeenLastCalledWith('folder:D'));
  });

  it('a folder crumb navigates to that folder’s level', async () => {
    const loadLevel = renderAt();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Folder: Folder A' }));
    await waitFor(() => expect(loadLevel).toHaveBeenLastCalledWith('folder:A'));
  });
});

describe('WorkItemRoadmap — drilling two folders deep and crumbing back', () => {
  it('the first folder’s crumb returns to its level', async () => {
    serve({
      __root__: {
        nodes: [wireNode('E1', 'Road epic')],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f1', 'Parked', 1, 0)],
      },
      f1: {
        nodes: [wireNode('B1', 'Parked bug', 'bug')],
        edges: [],
        offLevelBlockers: [],
        folders: [wireFolder('f2', 'Inner', 0, 1)],
      },
      f2: {
        nodes: [wireNode('B2', 'Inner bug', 'bug'), wireNode('B3', 'Inner bug two', 'bug')],
        edges: [],
        offLevelBlockers: [],
        folders: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Parked');
    fireEvent.keyDown(el('folder:f1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Parked bug');
    fireEvent.keyDown(el('folder:f2')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Inner bug');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Folder: Parked' }));
    expect(await screen.findByText('Parked bug')).toBeTruthy();
    await act(async () => {});
    expect(el('B2')).toBeNull();
  });
});
