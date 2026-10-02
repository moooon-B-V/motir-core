// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ToastProvider } from '@/components/ui/Toast';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// DRAG-AND-DROP IN THE PAGE TREE (Story MOTIR-5753 · MOTIR-7376) — `PageTreeDnd`
// against `design/pages/pages--tree.mock.html` panel 11 and `design-notes.md`
// § The page tree, "Drag": the bands (top quarter BEFORE, bottom quarter AFTER,
// middle half INSIDE; a folder INSIDE only), the placement each drop asks for,
// the pre-check that refuses a page over its own subtree, the server refusal
// that snaps back with the move's own sentence, and who gets a drag at all.
//
// The gestures are REAL dnd-kit pointer drags on the real `PageTree`: happy-dom
// does no layout, so each treeitem's rect is stubbed from its order in the tree
// (40px rows, the `/pages` density), and the pointer events carry coordinates.
// The stubs are `fetch` (the level read and the placement PATCH —
// `tests/api/pages-routes-tree` proves the routes) and the router.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  unstable_isUnrecognizedActionError: () => false,
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';
import {
  ROOT_DROP_ID,
  dropZoneAt,
  inSubtree,
  planPageDrop,
  type DndRowInfo,
} from '@/components/pages/tree/PageTreeDnd';

const folder = (id: string, name: string): PageTreeRowDto => ({
  kind: 'folder',
  id,
  name,
  hasChildren: true,
});
const page = (id: string, title: string, hasChildren = false): PageTreeRowDto => ({
  kind: 'page',
  id,
  title,
  hasChildren,
});
const level = (rows: PageTreeRowDto[]): PageTreeLevelDto => ({ rows, nextCursor: null });

// ── The pure half ───────────────────────────────────────────────────────────

describe('dropZoneAt — the bands', () => {
  const rect = { top: 100, height: 40 };
  it('a page row: top quarter BEFORE, middle half INSIDE, bottom quarter AFTER', () => {
    expect(dropZoneAt('page', rect, 100)).toBe('before');
    expect(dropZoneAt('page', rect, 109)).toBe('before');
    expect(dropZoneAt('page', rect, 110)).toBe('inside');
    expect(dropZoneAt('page', rect, 120)).toBe('inside');
    expect(dropZoneAt('page', rect, 130)).toBe('inside');
    expect(dropZoneAt('page', rect, 131)).toBe('after');
    expect(dropZoneAt('page', rect, 139)).toBe('after');
  });
  it('a folder row is INSIDE only, whichever band', () => {
    expect(dropZoneAt('folder', rect, 101)).toBe('inside');
    expect(dropZoneAt('folder', rect, 138)).toBe('inside');
  });
  it('an unmeasured row reads as INSIDE rather than dividing by zero', () => {
    expect(dropZoneAt('page', { top: 0, height: 0 }, 5)).toBe('inside');
  });
});

describe('planPageDrop — what a release asks for', () => {
  // root: f1 (Specs) · p1 (Auth flow, open: c1 · c2, c1 open: g1) · p2 · p3
  const rows: DndRowInfo[] = [
    {
      key: 'folder:f1',
      row: folder('f1', 'Specs'),
      parent: null,
      expandable: true,
      expanded: false,
    },
    {
      key: 'page:p1',
      row: page('p1', 'Auth', true),
      parent: null,
      expandable: true,
      expanded: true,
    },
    {
      key: 'page:c1',
      row: page('c1', 'Child', true),
      parent: 'page:p1',
      expandable: true,
      expanded: true,
    },
    {
      key: 'page:g1',
      row: page('g1', 'Grand'),
      parent: 'page:c1',
      expandable: false,
      expanded: false,
    },
    {
      key: 'page:c2',
      row: page('c2', 'Child 2'),
      parent: 'page:p1',
      expandable: false,
      expanded: false,
    },
    {
      key: 'page:p2',
      row: page('p2', 'Billing'),
      parent: null,
      expandable: false,
      expanded: false,
    },
    {
      key: 'page:p3',
      row: page('p3', 'Onboarding'),
      parent: null,
      expandable: false,
      expanded: false,
    },
  ];
  const parentByKey = new Map(rows.map((r) => [r.key, r.parent] as const));
  const pagesOf: Record<string, string[]> = {
    root: ['p1', 'p2', 'p3'],
    'page:p1': ['c1', 'c2'],
    'page:c1': ['g1'],
  };
  const levelPages = (key: string) => pagesOf[key] ?? [];
  const at = (key: string) => rows.find((r) => r.key === key)!;
  const plan = (
    pageId: string,
    from: string,
    target: Parameters<typeof planPageDrop>[0]['target'],
  ) => planPageDrop({ pageId, from, target, parentByKey, levelPages });

  it('BEFORE a sibling names it as the page landed BEFORE (afterId)', () => {
    expect(plan('p3', 'root', { kind: 'row', info: at('page:p2'), zone: 'before' })).toEqual({
      kind: 'move',
      parent: { kind: 'root' },
      beforeId: null,
      afterId: 'p2',
    });
  });
  it('AFTER a page in another level names it as the page landed AFTER (beforeId)', () => {
    expect(plan('p3', 'root', { kind: 'row', info: at('page:c1'), zone: 'after' })).toEqual({
      kind: 'move',
      parent: { kind: 'page', id: 'p1' },
      beforeId: 'c1',
      afterId: null,
    });
  });
  it('INSIDE a page or ANY band of a folder re-parents it, last at that level', () => {
    expect(plan('p3', 'root', { kind: 'row', info: at('page:p2'), zone: 'inside' })).toEqual({
      kind: 'move',
      parent: { kind: 'page', id: 'p2' },
      beforeId: null,
      afterId: null,
    });
    expect(plan('p3', 'root', { kind: 'row', info: at('folder:f1'), zone: 'before' })).toEqual({
      kind: 'move',
      parent: { kind: 'folder', id: 'f1' },
      beforeId: null,
      afterId: null,
    });
  });
  it('a drop that leaves the page where it is sends nothing', () => {
    // Already right before p3 / right after p1, and already inside p1.
    expect(plan('p2', 'root', { kind: 'row', info: at('page:p3'), zone: 'before' })).toEqual({
      kind: 'none',
    });
    expect(plan('p2', 'root', { kind: 'row', info: at('page:p1'), zone: 'after' })).toEqual({
      kind: 'none',
    });
    expect(plan('c2', 'page:p1', { kind: 'row', info: at('page:p1'), zone: 'inside' })).toEqual({
      kind: 'none',
    });
  });
  it('the page itself and anything inside it is refused, whatever the band', () => {
    for (const zone of ['before', 'inside', 'after'] as const) {
      expect(plan('p1', 'root', { kind: 'row', info: at('page:p1'), zone })).toEqual({
        kind: 'refused',
      });
      expect(plan('p1', 'root', { kind: 'row', info: at('page:c1'), zone })).toEqual({
        kind: 'refused',
      });
      expect(plan('p1', 'root', { kind: 'row', info: at('page:g1'), zone })).toEqual({
        kind: 'refused',
      });
    }
    expect(inSubtree('p1', 'page:p2', parentByKey)).toBe(false);
    expect(inSubtree('c1', 'page:g1', parentByKey)).toBe(true);
  });
  it('the ROOT zone appends at the root — after the root’s last page when already there', () => {
    expect(plan('c1', 'page:p1', { kind: 'root' })).toEqual({
      kind: 'move',
      parent: { kind: 'root' },
      beforeId: null,
      afterId: null,
    });
    expect(plan('p1', 'root', { kind: 'root' })).toEqual({
      kind: 'move',
      parent: { kind: 'root' },
      beforeId: 'p3',
      afterId: null,
    });
    expect(plan('p3', 'root', { kind: 'root' })).toEqual({ kind: 'none' });
  });
  it('the root zone has its own droppable id', () => {
    expect(ROOT_DROP_ID).toBe('page-tree-drop:root');
  });
});

// ── The tree, dragged ───────────────────────────────────────────────────────

const ROOT = level([
  folder('f1', 'Specs'),
  page('p1', 'Auth flow', true),
  page('p2', 'Billing model'),
  page('p3', 'Onboarding'),
]);
const P1 = level([page('c1', 'Token refresh')]);

type Answer = PageTreeLevelDto | { status: number; body: unknown };
let table: Record<string, Answer> = {};
let patchAnswers: Answer[] = [];
const patches: { url: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  const value =
    init?.method === 'PATCH' ? patchAnswers.shift() : table[url.searchParams.get('parent')!];
  if (init?.method === 'PATCH') {
    patches.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
  }
  if (value === undefined) throw new TypeError('Failed to fetch');
  if ('status' in value) return json(value.body, value.status);
  return json(value);
});

const ROW_PX = 40;

/** Lay the tree out in happy-dom: each treeitem 40px tall in order, the root zone below. */
function stubLayout() {
  const rectOf = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 600,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
    const i = items.indexOf(this);
    if (i >= 0) return rectOf(i * ROW_PX, ROW_PX);
    if (this.dataset.testid === 'page-tree-drop-root') return rectOf(items.length * ROW_PX + 8, 40);
    return rectOf(0, 0);
  });
}

function mount(props: Partial<PageTreeProps> = {}, zh = false) {
  return renderWithIntl(
    <ToastProvider>
      <PageTree initialRoot={ROOT} projectKey="VIEW" canEdit {...props} />
    </ToastProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
}

const item = (name: string) => screen.getByRole('treeitem', { name });
const labels = () =>
  within(screen.getByRole('tree'))
    .getAllByRole('treeitem')
    .map((el) => el.getAttribute('aria-label'));
const centreOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/** Press on `from`, move past the 8px activation and on to `y`. The drag stays live. */
async function dragTo(from: Element, y: number) {
  const startY = centreOf(from);
  await act(async () => {
    fireEvent.pointerDown(from, { clientX: 100, clientY: startY, isPrimary: true, button: 0 });
  });
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: 100, clientY: startY + (y > startY ? 10 : -10) });
  });
  // Two steps onto the target: the first lands after the droppables are first
  // measured (on activation), the second is the one a hand makes while hovering.
  for (const at of [y + 1, y]) {
    await act(async () => {
      fireEvent.pointerMove(document, { clientX: 100, clientY: at });
    });
  }
}
async function release(y: number) {
  await act(async () => {
    fireEvent.pointerUp(document, { clientX: 100, clientY: y });
  });
  // The move's answer, and the level re-reads it asks for.
  await act(async () => {});
}

beforeEach(() => {
  table = { root: ROOT, 'page:p1': P1 };
  patchAnswers = [];
  patches.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  stubLayout();
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  push.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who can drag', () => {
  it('an editor at /pages: a handle on every PAGE row, none on a folder row', () => {
    mount();
    expect(within(item('Billing model')).getByTestId('page-tree-drag-handle')).toBeTruthy();
    expect(within(item('Auth flow')).getByTestId('page-tree-drag-handle')).toBeTruthy();
    expect(within(item('Specs')).queryByTestId('page-tree-drag-handle')).toBeNull();
    // The handle is decorative and out of the tab order.
    const handle = within(item('Billing model')).getByTestId('page-tree-drag-handle');
    expect(handle.getAttribute('aria-hidden')).toBe('true');
    expect(handle.querySelector('[tabindex]')).toBeNull();
  });

  it('a viewer gets no handle, and pressing and moving a row starts nothing', async () => {
    mount({ canEdit: false });
    expect(screen.queryAllByTestId('page-tree-drag-handle')).toHaveLength(0);
    await dragTo(item('Onboarding'), 60);
    expect(screen.queryByTestId('page-tree-drag-overlay')).toBeNull();
    expect(screen.queryByTestId('page-tree-drop-root')).toBeNull();
    await release(60);
    expect(patches).toHaveLength(0);
  });

  it('the compact sidebar never drags, even for an editor', async () => {
    mount({ density: 'compact' });
    expect(screen.queryAllByTestId('page-tree-drag-handle')).toHaveLength(0);
    await dragTo(item('Onboarding'), 60);
    expect(screen.queryByTestId('page-tree-drag-overlay')).toBeNull();
    await release(60);
    expect(patches).toHaveLength(0);
  });
});

describe('dragging a page', () => {
  it('lifts the row onto the overlay, leaves the origin slot and shows the root zone', async () => {
    mount();
    // Rows: Specs 0–40 · Auth flow 40–80 · Billing model 80–120 · Onboarding 120–160.
    await dragTo(item('Onboarding'), 85);
    const overlay = screen.getByTestId('page-tree-drag-overlay');
    expect(overlay.textContent).toContain('Onboarding');
    expect(item('Onboarding').className).toContain('border-dashed');
    expect(screen.getByTestId('page-tree-drop-root').textContent).toBe(
      'Drop here to move it to the project root',
    );
    // The top quarter of Billing model: the BEFORE line on that row.
    expect(within(item('Billing model')).getByTestId('page-tree-drop-before')).toBeTruthy();
    await release(85);
    expect(screen.queryByTestId('page-tree-drop-root')).toBeNull();
  });

  it('REORDER: before a sibling sends the placement and re-reads the level', async () => {
    patchAnswers = [
      {
        status: 200,
        body: {
          id: 'p3',
          parent: { kind: 'root' },
          position: 'a1',
          ancestorPageIds: [],
          moved: true,
        },
      },
    ];
    mount();
    await dragTo(item('Onboarding'), 84);
    table.root = level([
      folder('f1', 'Specs'),
      page('p1', 'Auth flow', true),
      page('p3', 'Onboarding'),
      page('p2', 'Billing model'),
    ]);
    await release(84);
    expect(patches).toEqual([
      {
        url: '/api/pages/p3/placement',
        body: { parent: { kind: 'root' }, beforeId: null, afterId: 'p2' },
      },
    ]);
    expect(labels()).toEqual(['Specs', 'Auth flow', 'Onboarding', 'Billing model']);
  });

  it('RE-PARENT: the middle of a page row is INSIDE — tinted, then moved under it', async () => {
    patchAnswers = [
      {
        status: 200,
        body: {
          id: 'p3',
          parent: { kind: 'page', id: 'p2' },
          position: 'a0',
          ancestorPageIds: ['p2'],
          moved: true,
        },
      },
    ];
    mount();
    await dragTo(item('Onboarding'), 100);
    expect(item('Billing model').className).toContain('bg-(--el-tint-lavender)');
    await release(100);
    expect(patches[0]!.body).toEqual({
      parent: { kind: 'page', id: 'p2' },
      beforeId: null,
      afterId: null,
    });
  });

  it('RE-PARENT: a folder row is INSIDE even at its top edge', async () => {
    patchAnswers = [
      {
        status: 200,
        body: {
          id: 'p2',
          parent: { kind: 'folder', id: 'f1' },
          position: 'a0',
          ancestorPageIds: [],
          moved: true,
        },
      },
    ];
    table['folder:f1'] = level([page('p2', 'Billing model')]);
    mount();
    await dragTo(item('Billing model'), 2);
    expect(item('Specs').className).toContain('ring-(--el-accent)');
    expect(within(item('Specs')).queryByTestId('page-tree-drop-before')).toBeNull();
    await release(2);
    expect(patches[0]!.body).toEqual({
      parent: { kind: 'folder', id: 'f1' },
      beforeId: null,
      afterId: null,
    });
    // The target opens, so the moved page is in view.
    expect(item('Specs').getAttribute('aria-expanded')).toBe('true');
  });

  it('ROOT: dropping on the root zone moves it to the project root', async () => {
    table.root = level([folder('f1', 'Specs'), page('p1', 'Auth flow', true)]);
    patchAnswers = [
      {
        status: 200,
        body: {
          id: 'c1',
          parent: { kind: 'root' },
          position: 'a9',
          ancestorPageIds: [],
          moved: true,
        },
      },
    ];
    mount({
      initialRoot: table.root as PageTreeLevelDto,
      expandedPath: ['page:p1'],
      initialLevels: { 'page:p1': P1 },
    });
    // Rows: Specs · Auth flow · Token refresh; the zone sits at 128–168.
    await dragTo(item('Token refresh'), 150);
    expect(screen.getByTestId('page-tree-drop-root').className).toContain('ring-(--el-accent)');
    await release(150);
    // Not already at the root, so nothing is named: the server appends it last.
    expect(patches[0]!.body).toEqual({ parent: { kind: 'root' }, beforeId: null, afterId: null });
  });

  it('a collapsed row hovered for 600ms opens', async () => {
    mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await dragTo(item('Onboarding'), 60);
    expect(item('Auth flow').getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();
    await act(async () => {});
    expect(item('Auth flow').getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toContain('Token refresh');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
  });
});

describe('refused drops', () => {
  it('over its own sub-page: dashed refusal, a tooltip, and nothing is sent', async () => {
    mount({ expandedPath: ['page:p1'], initialLevels: { 'page:p1': P1 } });
    // Rows: Specs · Auth flow · Token refresh (80–120) · Billing model · Onboarding.
    await dragTo(item('Auth flow'), 100);
    expect(item('Token refresh').className).toContain('outline-dashed');
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Can’t drop a page into its own sub-page.',
    );
    expect(screen.getByTestId('page-tree-drag-overlay').className).toContain('cursor-not-allowed');
    await release(100);
    expect(patches).toHaveLength(0);
    expect(labels()).toEqual([
      'Specs',
      'Auth flow',
      'Token refresh',
      'Billing model',
      'Onboarding',
    ]);
  });

  it('a SERVER refusal (depth) snaps back: the tree is unchanged, the row keeps focus, a toast says why', async () => {
    patchAnswers = [{ status: 422, body: { code: 'PAGE_DEPTH_EXCEEDED', limit: 10 } }];
    mount();
    const before = labels();
    await dragTo(item('Onboarding'), 100);
    await release(100);
    expect(patches).toHaveLength(1);
    expect(labels()).toEqual(before);
    expect(
      await screen.findByText(
        'Pages nest at most 10 levels deep, and this move would go past that. It stayed where it was.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(item('Onboarding'));
    expect(item('Onboarding').className).not.toContain('border-dashed');
  });

  it('says the refusals in Chinese', async () => {
    mount({ expandedPath: ['page:p1'], initialLevels: { 'page:p1': P1 } }, true);
    await dragTo(item('Auth flow'), 100);
    expect(screen.getByRole('tooltip').textContent).toBe('不能将页面拖放到其自身的子页面中。');
    expect(screen.getByTestId('page-tree-drop-root').textContent).toBe(
      '拖放到此处，将其移动到项目根目录',
    );
    await release(100);
  });
});
