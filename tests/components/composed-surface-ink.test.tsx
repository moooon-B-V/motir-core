// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  AA,
  FAINT_INK,
  MUTED_INK,
  findInkContrastFailures,
  formatRenderedFinding,
  measuredInkSites,
  paintedSurfaces,
  rootList,
  surfacesUnderAA,
  themesThatBind,
} from '../helpers/renderedInkContrast';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { CommandGroup } from '@/components/ui/CommandPalette';

// MOTIR-4251 — the render-time ink guard, pointed at COMPOSED surfaces.
//
// ── What this covers, and how the list was derived ─────────────────────────
// `tests/theme/inkContrastLint.test.ts`'s muted arm resolves an ink's background
// from the module the ink is written in and ABSTAINS when the tint is painted
// elsewhere. That abstention is deliberate and is not widened here; this guard
// sits beside it and rules on what it declines to rule on. The population is
// enumerated rather than described — `tests/theme/composedInkAbstentions.ts`
// runs the arm's OWN predicates over the same file set and records the sites it
// walks past, and `tests/theme/composedSurfaceInkCoverage.test.ts` pins the
// modules below as a genuine subset of it.
//
// ── ⚠️ THE TRAP THIS FILE IS WRITTEN AGAINST ───────────────────────────────
// A sweep over a mounted component returns `[]` for two reasons that look
// identical from outside: the surface is clean, or the mount rendered no ink at
// all. A guard that asserts only the empty list cannot tell them apart and stays
// green through any refactor that stops rendering the text. So EVERY case below
// also asserts that the mounted tree paints a background the ink actually FAILS
// on — the condition under which a regression here would be caught. A check that
// cannot go red is not evidence, it is a tautology.
//
// That is also why the covered set is what it is. These are the surfaces the
// class's five bug cards FIXED, and none of them had a regression guard: revert
// any one of those fixes and the corresponding case below goes red, which is the
// property being bought. MOTIR-4246's `/items` row is the one member of the five
// that is not here, and it never will be: that card shipped (#2543) with its own
// guard — `tests/components/items-row-ink.test.tsx`, its acceptance criterion 3 —
// and its fix moved both sites OFF `--el-text-muted` entirely, so neither module
// is in the abstention this file is pointed at any more.
//
// ── What the guard found on its first run: MOTIR-4260 ──────────────────────
// Pointing it at the plan canvas node in its `remove` state returned a SIXTH
// site of this class — the node's title in `--el-text-muted` on its own
// `--el-muted` frame, 4.12:1. MOTIR-4251 could not mount that state, because the
// defect was open and the case would have shipped red. MOTIR-4260 closes it: the
// title takes `--el-text-secondary` (6.18:1, and what `design/ai-planning`'s
// `.node.remove .ttl` specified all along), and the `remove` state is mounted
// below beside the `modify` one. The two are different STATES of one module,
// which is exactly why MOTIR-4030's fix to this very file did not reach it.
//
// ── One reading decision, stated because it differs from the static walk ────
// The worst background an ancestor can paint decides, so `hover:bg-(--el-surface)`
// counts. Hover is a state of the TEXT rather than a separate element, which is
// 1.4.3's reading and MOTIR-4246's. The static walk clears an unprefixed white
// first; over-reporting a conditional tint is the documented safe direction.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Everything a portalling surface renders, plus the container itself. */
const wholeDocument = (container: HTMLElement): ParentNode[] => [container, document.body];

/**
 * The sweep, plus the two things that make its green mean something: the tree
 * paints a surface this ink fails on, so a regression WOULD be caught here.
 */
function expectNoFailingInk(roots: HTMLElement | readonly ParentNode[], label: string): void {
  const list = rootList(roots);
  const failing = new Set(surfacesUnderAA('light', MUTED_INK));
  const painted = paintedSurfaces(list);
  expect(
    painted.filter((token) => failing.has(token)),
    `${label} paints no surface the muted ink fails on, so this sweep cannot go red — ` +
      `it painted [${painted.join(', ')}]`,
  ).not.toHaveLength(0);

  const findings = findInkContrastFailures(list, { theme: 'light' });
  expect(findings.map(formatRenderedFinding), `${label} — ink under AA on its own surface`).toEqual(
    [],
  );
}

describe('MOTIR-4251 · the rule this guard enforces, as resolved values', () => {
  it('the failing surface set is DERIVED from theme.css, and it is wider than the static list', () => {
    const failing = surfacesUnderAA('light', MUTED_INK);
    // The three the static guard calls SAFE are the three the ink clears — and
    // deriving the set is what makes the third one (an alias of the first two,
    // MOTIR-2497) fall out rather than have to be remembered.
    for (const safe of ['--el-page-bg', '--el-card', '--el-sidebar-item-bg-active']) {
      expect(failing, `${safe} should clear AA for the muted ink`).not.toContain(safe);
    }
    // MOTIR-3693's alias: the same `#f6f5f4` as `--el-surface`, a different name.
    expect(failing).toContain('--el-sidebar-bg');
    // And four families a hand-written tinted list does not reach.
    for (const token of [
      '--el-tint-lavender',
      '--el-tint-rose',
      '--el-tooltip-bg',
      '--el-danger-surface',
    ]) {
      expect(failing).toContain(token);
    }
  });

  it('LIGHT is the binding theme for the muted ink, and dark is not a second measurement', () => {
    const surfaces = ['--el-surface', '--el-surface-soft', '--el-muted', '--el-sidebar-bg'];
    // In dark `--el-text-muted` and `--el-text-secondary` are the same hex, so
    // the muted ink passes on every one of these. Sweeping dark for it would be
    // measuring the same pass twice, which is why every sweep below pins light.
    expect(themesThatBind(MUTED_INK, surfaces)).toEqual(['light']);
    // The faint ink is the other way round: it clears AA on no background in
    // EITHER theme, so its rule has no surface term and needs no theme choice.
    expect(themesThatBind(FAINT_INK, surfaces)).toEqual(['light', 'dark']);
    expect(surfacesUnderAA('light', FAINT_INK)).toContain('--el-page-bg');
    expect(surfacesUnderAA('dark', FAINT_INK)).toContain('--el-page-bg');
    expect(AA).toBe(4.5);
  });
});

describe('MOTIR-4251 · composed surfaces resolve their own ink', () => {
  it('the plan canvas node — components/planning/PlanItemNode.tsx (MOTIR-4030)', async () => {
    const { PlanItemNode } = await import('@/components/planning/PlanItemNode');
    // The `modify` node with changes is the shape MOTIR-4030 was filed against:
    // its inline diff overlay is text painted on the node's own `--el-surface`,
    // written in a module that never sees that tint.
    const { container } = renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          op: 'modify',
          nodeId: 'wi_1',
          identifier: 'PROD-14',
          title: 'Seller onboarding',
          status: 'in_progress',
          storyPoints: 3,
          estimateMinutes: 45,
          targetRepo: 'motir-core',
          changes: [
            { field: 'priority', from: 'medium', to: 'high' },
            { field: 'title', from: 'old', to: 'new' },
          ],
          // The peek envelope (MOTIR-4183) restates the op and the moved field
          // set the `changes` above carry — the builder's default describes an
          // `add`, which this case is not.
          proposal: {
            op: 'modify',
            identifier: 'PROD-14',
            changedFields: ['priority', 'title'],
            settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
          },
        })}
      />,
    );
    // The overlay MOTIR-4030 re-inked is on screen — without this the sweep
    // below could pass by never rendering the thing it is guarding.
    expect(screen.getByTestId('diff-line')).toBeTruthy();
    expect(screen.getByText('PROD-14')).toBeTruthy();
    expectNoFailingInk(container, 'PlanItemNode (modify, with a diff overlay)');
  });

  it('the plan canvas node in its REMOVE state — the same module, MOTIR-4030 did not reach it (MOTIR-4260)', async () => {
    const { PlanItemNode } = await import('@/components/planning/PlanItemNode');
    // The `remove` node is the one op that paints its OWN fill: the frame is
    // computed into a `frame` variable and interpolated onto the root `div`,
    // while the title's ink is a ternary six elements down. The static walk
    // resolves nothing across that gap and ABSTAINS, so the pairing was green in
    // `tests/theme/inkContrastLint.test.ts` and always would have been.
    const { container } = renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          op: 'remove',
          nodeId: 'wi_2',
          identifier: 'PROD-21',
          title: 'Superseded subtask',
          status: 'todo',
          // The peek envelope (MOTIR-4183) restates the op; the builder's
          // default describes an `add`, which this case is not.
          proposal: {
            op: 'remove',
            identifier: 'PROD-21',
            changedFields: [],
            settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
          },
        })}
      />,
    );
    // The struck title is on screen AND the node paints its own `--el-muted`
    // frame under it. Both are asserted because either one absent turns the
    // sweep below into a tautology — the muted ink fails on `--el-muted` at
    // 4.12:1, so this is the state in which a re-inking would be caught.
    expect(screen.getByText('Superseded subtask')).toBeTruthy();
    expect(paintedSurfaces(container)).toContain('--el-muted');
    expectNoFailingInk(container, 'PlanItemNode (remove)');
  });

  it('the command palette — components/ui/CommandPalette.tsx', async () => {
    const { CommandPalette } = await import('@/components/ui/CommandPalette');
    const groups: CommandGroup[] = [
      {
        heading: 'Navigation',
        actions: [
          { id: 'dash', label: 'Go to Dashboard', onSelect: vi.fn() },
          { id: 'issues', label: 'Go to Work Items', onSelect: vi.fn() },
        ],
      },
      { heading: 'Account', actions: [{ id: 'signout', label: 'Sign out', onSelect: vi.fn() }] },
    ];
    function Host() {
      const [open, setOpen] = useState(true);
      return <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />;
    }
    const { container } = renderWithIntl(<Host />);
    const roots = wholeDocument(container);
    // Three real muted sites — the two group headings and the footer hint —
    // whose surface is painted by the dialog primitive in another module. This
    // is the abstention with text in it, so the sweep has something to rule on.
    const sites = measuredInkSites(roots).filter((s) => s.ink === MUTED_INK);
    expect(sites.map((s) => s.text)).toContain('Navigation');
    expectNoFailingInk(roots, 'CommandPalette (open)');
  });

  it('the work-item actions menu — the exemption arm, on a portalled body', async () => {
    const { ToastProvider } = await import('@/components/ui/Toast');
    const { WorkItemActionsMenu } = await import('@/components/issues/actions/WorkItemActionsMenu');
    const menu: ReactElement = (
      <ToastProvider>
        <WorkItemActionsMenu
          itemId="wi-1"
          identifier="PROD-1"
          title="A bug"
          onDeleted={vi.fn()}
          onArchived={vi.fn()}
          canEdit
          canArchive
          canDelete
        />
      </ToastProvider>
    );
    const { container } = renderWithIntl(menu);
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
    const roots = wholeDocument(container);
    // Every muted ink in this module is on an `aria-hidden` glyph, and the menu
    // body is portalled onto `--el-page-bg` — so what this case pins is the
    // EXEMPTION arm reading the composed DOM rather than an AST's guess about
    // it. The tree still paints `--el-muted` and `--el-tint-rose`, so a label
    // that took the muted ink would be caught.
    expect(paintedSurfaces(roots)).toContain('--el-muted');
    expectNoFailingInk(roots, 'WorkItemActionsMenu (open)');
  });

  it('the app sidebar — components/ui/Sidebar.tsx, on the --el-sidebar-bg ALIAS', async () => {
    vi.doMock('next/navigation', () => ({ usePathname: () => '/items' }));
    const { Sidebar } = await import('@/components/ui/Sidebar');
    const { container } = renderWithIntl(
      <Sidebar
        collapsed={false}
        sections={[
          {
            id: 'primary',
            label: 'Workspace',
            items: [
              { icon: <span />, label: 'Dashboard', href: '/dashboard', kbd: 'G D' },
              { icon: <span />, label: 'Work Items', href: '/items', active: true },
            ],
          },
          {
            id: 'meta',
            label: 'More',
            items: [
              { icon: <span />, label: 'Settings', href: '/settings' },
              // A designed-for, not-yet-built row: faint ink, cleared by
              // `aria-disabled` rather than by anything about its colour. The
              // static guard infers that grant from a ternary's CONDITION; here
              // it is read off the attribute that actually rendered.
              { icon: <span />, label: 'Automation', href: '/settings/automation', disabled: true },
            ],
          },
        ]}
      />,
    );
    // The rail is the MOTIR-3693 case in one render: `--el-sidebar-bg` is an
    // alias of `--el-surface`, so a guard that models surfaces by NAME reads
    // this whole subtree as unpainted.
    expect(paintedSurfaces(container)).toContain('--el-sidebar-bg');
    expect(screen.getByText('Automation')).toBeTruthy();
    expectNoFailingInk(container, 'Sidebar (expanded, with a disabled row)');
  });
});
