// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { contrast } from '../theme/colorMetrics';
import { loadTokenLayer, resolveToken, type ThemeContext } from '../theme/paletteCascade';
import {
  AA,
  MUTED_INK,
  findInkContrastFailures,
  formatRenderedFinding,
  paintedSurfaces,
  ratio,
  surfacesUnderAA,
} from '../helpers/renderedInkContrast';

// MOTIR-4246 — the ink guard for the `/items` ROW, in both chromes, at the tier
// the static one cannot reach.
//
// ── Why this exists beside `tests/theme/inkContrastLint.test.ts` ────────────
// That guard's muted arm walks the source tree and resolves each ink's surface
// from the module it is written in. Its header says so outright: an element
// whose background is painted by a layout in ANOTHER module reads as "no surface
// found here" and the rule ABSTAINS — it does not rule the site safe, it
// declines to rule at all, because resolving that needs the import graph.
//
// The `/items` row is exactly that shape, twice over. `IssueListTable` and
// `components/ui/TreeTable` paint the row's `hover:bg-(--el-surface)` tint;
// `issueColumns`'s cell renderers and `IssueTreeTable`'s synthetic rows paint no
// background of their own and are rendered INSIDE those rows from two other
// modules. So the lane was green with the row's identifier at 4.17:1 on hover.
//
// A RENDER resolves what a static walk cannot: the composed DOM already carries
// the answer the import graph would have to reconstruct.
//
// ⚠️ MOTIR-4263 — THE RESOLVER THAT USED TO LIVE HERE IS NOW SHARED.
//
// This file shipped (#2543) with its own `surfaceUnder` ancestor walk and its
// own `carriesText` exemption test, copied from the shape
// `tests/components/quick-view-rail-ink.test.tsx` (MOTIR-4196) had established.
// That was the right instruction when this card was written: the shared resolver
// did not exist, so reusing the pattern meant copying it. MOTIR-4251 (#2546)
// landed `tests/helpers/renderedInkContrast.ts` in parallel, and for one commit
// `main` carried TWO independently-written render-time resolvers answering the
// same question. Two of them drift the first time an exemption or a walk is
// corrected in one file and not the other — and the divergence is silent in the
// direction that matters, because a resolver that misses a surface returns an
// EMPTY findings list, which is what a clean surface returns.
//
// So the walk and the exemptions below are the shared helper's now. The
// assertions are UNCHANGED in substance; what changed is that the resolver is
// wider than the one it replaces:
//
//  * the surface set is DERIVED from the resolved token values rather than
//    matched a token at a time, so an ALIAS of a failing colour (MOTIR-3693's
//    `--el-sidebar-bg`) cannot hide in it;
//  * where an element paints more than one background the WORST one decides,
//    which is a strict widening of "the first `bg-(--el-*)` on the nearest
//    painting ancestor";
//  * the exemption set is `aria-hidden` · decorative glyph · **disabled** ·
//    no-text, read off the composed DOM.
//
// ── The widening this file contributed, now in the helper ───────────────────
// The rail paints `bg-(--el-surface-soft)` unconditionally, so the prototype's
// walk only had to recognise a bare `bg-(--el-*)`. A table row paints its tint
// under a `hover:` variant. WCAG 1.4.3 is about TEXT, and hover is a state of
// that text rather than a separate element, so the tint the pointer reveals is a
// surface the text has to be legal on. `renderedInkContrast`'s
// `PAINTS_BACKGROUND` is unanchored for exactly that reason and matches a
// variant-prefixed utility, so the `hover:` case this card exists for is ruled
// on by the shared resolver, not by a second one.
//
// One thing IS lost and is named rather than left to be noticed: the local walk
// captured the variant and printed it, so a failure said which state it was
// measured in. The shared finding prints the element's whole `class` attribute
// instead, which carries the prefix verbatim — the same information, one step
// less digested. That is the trade a single mechanism costs, and it is smaller
// than the drift two mechanisms guarantee.
//
// ── Nothing here is a hardcoded colour ──────────────────────────────────────
// Every ink, every surface and every ratio is resolved from the shipped
// stylesheet (`packages/design-system/theme.css`) in the base palette's LIGHT
// theme, which is the binding one: in dark, `--el-text-muted`,
// `--el-text-secondary` and `--el-text-identifier` all resolve to the same hex,
// so the pairing is legal there whatever the ink. A token whose Tier-0 value
// moves therefore fails HERE, naming the number, rather than silently relaxing
// the rule.

const { push, listRootIssuesAction, listChildIssuesAction } = vi.hoisted(() => ({
  push: vi.fn(),
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({ listRootIssuesAction, listChildIssuesAction }));
// The rows are inline-editable (Subtask 2.5.5), so the cells import the detail
// page's edit Server Actions — stub them so this client test stays DB-free.
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: () => {},
    openCreateIssue: () => {},
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Resolved tokens ─────────────────────────────────────────────────────────

/** The base palette in its LIGHT theme — light means the attribute is ABSENT. */
const LIGHT: ThemeContext = { palette: 'motir', theme: 'light' };
const { rules } = loadTokenLayer();
const resolve = (token: string): string => {
  const { value, unresolved } = resolveToken(rules, LIGHT, token);
  if (unresolved.length > 0) throw new Error(`unresolved token(s): ${unresolved.join(', ')}`);
  return value;
};

const classesOf = (el: Element): string => el.getAttribute('class') ?? '';

/**
 * The rendered ROWS — the population this guard is scoped to. The sweep below
 * takes them as its roots rather than the whole container, which keeps the
 * subject exactly what it was: text inside an `/items` row, over the tint the
 * row itself paints. The shared resolver still walks UP out of a root to find
 * the painter, so the row's own `hover:bg-(--el-surface)` is what it lands on.
 */
function rowsIn(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[role="row"]'));
}

/**
 * Every element inside a rendered `/items` ROW that paints `--el-text-muted` as
 * TEXT over a surface that ink fails AA on — resolved by the SHARED render-time
 * resolver (MOTIR-4251), so this file adds no second walk and no second
 * exemption predicate of its own.
 */
function offendersIn(container: HTMLElement): string[] {
  return findInkContrastFailures(rowsIn(container), {
    theme: 'light',
    inks: [MUTED_INK],
  }).map(formatRenderedFinding);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const members: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Ada', email: 'ada@x.com', role: 'admin' },
];
const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
  ],
  transitions: [],
  policyMode: 'restricted',
};
const sort = { column: 'key', direction: 'asc' } as const;

function listRow(over: Partial<IssueRowData> & { identifier: string }): IssueRowData {
  return {
    id: 'i1',
    title: 'Email + password sign-in',
    kind: 'task',
    type: null,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: 'u1',
    assigneeName: 'Ada',
    updatedAt: '2026-06-01T00:00:00.000Z',
    priority: 'medium',
    reporterName: 'Ada',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    estimateLabel: null,
    storyPoints: null,
    storyPointsLabel: null,
    hasChildren: false,
    ...over,
  } as IssueRowData;
}

function treeNode(
  over: Partial<WorkItemTreeRowDto> & { id: string; key: number },
): WorkItemTreeRowDto {
  return {
    parentId: null,
    kind: 'task',
    type: null,
    identifier: `PROD-${over.key}`,
    title: `Issue ${over.key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    hasChildren: false,
    ...over,
  };
}

function renderList() {
  return render(
    <IssueListTable
      rows={[listRow({ identifier: 'PROD-1' })]}
      sort={sort}
      filter={EMPTY_FILTER}
      pagination={{ total: 1, page: 1, pageSize: 50 }}
      workflow={workflow}
      members={members}
    />,
  );
}

function renderTree(initialLevel: TreeLevelDto) {
  return render(
    <IssueTreeTable
      initialLevel={initialLevel}
      sort={sort}
      filter={EMPTY_FILTER}
      workflow={workflow}
      members={members}
    />,
  );
}

// ── The measurement the rule is built on ────────────────────────────────────

describe('MOTIR-4246 · the /items row resolves its own ink', () => {
  it('the resolved table: muted fails on the row tint, identifier and secondary clear it', () => {
    const muted = resolve('--el-text-muted');
    const identifier = resolve('--el-text-identifier');
    const secondary = resolve('--el-text-secondary');
    const rowTint = resolve('--el-surface');
    const page = resolve('--el-page-bg');

    // At rest the muted ink is legal on the page by 0.04 — which is why the
    // static lane, which resolves this site's surface as "none found", read the
    // whole row as safe.
    expect(contrast(muted, page)).toBeGreaterThanOrEqual(AA);
    expect(contrast(muted, page)).toBeCloseTo(4.54, 2);
    // On hover the row paints --el-surface underneath it, and it is not.
    expect(contrast(muted, rowTint)).toBeCloseTo(4.17, 2);
    expect(contrast(muted, rowTint)).toBeLessThan(AA);
    // Both destination inks are legal on the tint AND on the page, so neither
    // fix has to know which state the row is in.
    for (const ink of [identifier, secondary]) {
      expect(contrast(ink, rowTint)).toBeCloseTo(6.24, 2);
      expect(contrast(ink, page)).toBeGreaterThanOrEqual(AA);
    }

    // And the SAME measurement taken through the shared resolver (MOTIR-4263).
    // The two agreeing is what says the helper models the token layer the way
    // this card measured it by hand — and it is the assertion that would have
    // gone red had the two resolvers been allowed to drift.
    expect(ratio('light', MUTED_INK, '--el-surface')).toBeCloseTo(4.17, 2);
    expect(ratio('light', MUTED_INK, '--el-page-bg')).toBeCloseTo(4.54, 2);
    expect(surfacesUnderAA('light', MUTED_INK)).toContain('--el-surface');
    expect(surfacesUnderAA('light', MUTED_INK)).not.toContain('--el-page-bg');
  });

  it('the LIST chrome: no text in a row carries --el-text-muted over the hover tint', () => {
    const { container } = renderList();
    // The row really rendered, and it really paints the tint — otherwise this
    // test passes by ruling on nothing.
    const row = screen.getByTestId('issue-row-PROD-1');
    expect(classesOf(row)).toContain('hover:bg-(--el-surface)');
    // …and the shared resolver SEES that tint. A sweep whose roots paint no
    // failing surface is green for a reason that has nothing to do with the
    // code, which is the one way this guard can pass while saying nothing.
    expect(paintedSurfaces(rowsIn(container))).toContain('--el-surface');

    expect(
      offendersIn(container),
      'the /items list row paints --el-surface on hover, where --el-text-muted is 4.17:1 — under AA',
    ).toEqual([]);
  });

  it('the LIST chrome: the Key column uses the token the design system named for it', () => {
    renderList();
    const identifier = within(screen.getByTestId('issue-row-PROD-1')).getByText('PROD-1');
    // --el-text-identifier is declared for exactly this element — "monospace
    // MOTIR-123 keys" — and `Combobox` already uses it for the same one.
    expect(classesOf(identifier)).toContain('text-(--el-text-identifier)');
  });

  it('the TREE chrome: neither the forwarded key cell nor the loading caption is muted', async () => {
    // A never-settling child fetch holds the synthetic lazy-expand row on
    // screen, which is the only state that renders the "Loading children…"
    // caption at all.
    listChildIssuesAction.mockReturnValue(new Promise(() => {}));
    const { container } = renderTree({
      rows: [treeNode({ id: 'a', key: 1, hasChildren: true })],
      hasMore: false,
      total: 1,
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('issue-row-PROD-1')).getByRole('button', { name: 'Expand row' }),
      );
    });

    // Both populations are in front of the assertion: the key cell the tree
    // forwards from the shared columns, and the synthetic loading row.
    expect(screen.getByText('Loading children…')).toBeTruthy();
    expect(within(screen.getByTestId('issue-row-PROD-1')).getByText('PROD-1')).toBeTruthy();
    // The tree chrome paints the same row tint, and the shared resolver sees it.
    expect(paintedSurfaces(rowsIn(container))).toContain('--el-surface');

    expect(
      offendersIn(container),
      'the /items tree row paints --el-surface on hover, where --el-text-muted is 4.17:1 — under AA',
    ).toEqual([]);
  });
});
