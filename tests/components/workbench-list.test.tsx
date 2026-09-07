// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderRaw, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { HomeTabCountsDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The `/workbench` list row and its five-tab strip (Story MOTIR-2649 ·
// MOTIR-2653, widened by Story MOTIR-4777 · MOTIR-4782) under happy-dom. The
// reads are covered against real Postgres in `tests/integration/workbench/`;
// these cover what only the RENDER can be wrong about — the cells the design
// added, the agent treatment, the Finished column, and the Watching bands.

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: 'workbench') =>
      createTranslator({ locale: 'en', messages, namespace }),
  };
});

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { WorkbenchTabs } from '@/app/(authed)/workbench/_components/WorkbenchTabs';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';
import type { WorkbenchTab } from '@/lib/workbench/tab';

afterEach(() => {
  cleanup();
  push.mockReset();
});

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Zhu Yue', email: 'yue@example.com', role: 'owner' },
  { userId: 'u2', name: 'Mei Lin', email: 'mei@example.com', role: 'member' },
];

/** The ACTIVE project's workflow — one, since MOTIR-2761 narrowed Home to it.
 *  The per-project MAP this used to be existed because Home spanned projects
 *  that can spell the same status key differently; the rows now share a project,
 *  so they share its workflow the way the `/items` rows do. */
const WORKFLOW = {
  statuses: [
    { key: 'todo', label: 'To Do', category: 'todo' },
    { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    { key: 'done', label: 'Done', category: 'done' },
    { key: 'cancelled', label: 'Cancelled', category: 'done' },
  ],
} as unknown as WorkflowDto;

function dto(over: Partial<HomeWorkItemRowDto> & { identifier: string }): HomeWorkItemRowDto {
  return {
    id: `wi_${over.identifier}`,
    kind: 'task',
    type: null,
    key: 1,
    title: 'An item',
    status: 'in_progress',
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-08-11T00:00:00.000Z',
    // Null unless a test says otherwise: `completedAt` (MOTIR-4780) is stamped
    // only on entry to a done-category status, and this strip's rows are live.
    completedAt: null,
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: true,
    ...over,
  };
}

const renderRows = (rows: HomeWorkItemRowDto[], tab: WorkbenchTab = 'todo') =>
  render(
    <WorkbenchList
      rows={toWorkbenchRowViews(rows, WORKFLOW, MEMBERS, tab === 'watching')}
      label="To do"
      tab={tab}
    />,
  );

describe('the Workbench row — the cells the design added', () => {
  it('carries NO project cell or column — the page is one project (MOTIR-2761)', () => {
    renderRows([dto({ identifier: 'MOTIR-1' })]);

    // The chip is gone from the row AND its header from the strip. A column
    // whose every row repeats the project switcher two rows above it is not
    // information — and while it was here it was the visible half of a surface
    // reading across a boundary it should not have crossed.
    expect(within(screen.getByTestId('workbench-row-MOTIR-1')).queryByText('Motir')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Project' })).toBeNull();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Title',
      'Your role',
      'Assignee',
      'Status',
    ]);
  });

  it('names the reader s relation, and marks BOTH as the one worth spotting', () => {
    renderRows([
      dto({ identifier: 'A-1', viewerIsAssignee: true, viewerIsReporter: false }),
      dto({ identifier: 'R-1', viewerIsAssignee: false, viewerIsReporter: true, assigneeId: 'u2' }),
      dto({ identifier: 'B-1', viewerIsAssignee: true, viewerIsReporter: true }),
    ]);

    expect(within(screen.getByTestId('workbench-row-A-1')).getByText('Assigned')).toBeTruthy();
    expect(within(screen.getByTestId('workbench-row-R-1')).getByText('Reported')).toBeTruthy();

    // `Both` is the only value not derivable from the Assignee cell, and it is
    // the dedupe made visible — so it carries WEIGHT as well as ink, the
    // non-colour redundant cue (finding #35).
    const both = within(screen.getByTestId('workbench-row-B-1')).getByText('Both');
    expect(both.className).toContain('font-medium');
    expect(both.className).toContain('--el-text-strong');
  });

  it('reads "Watching" for an item the reader follows but does not own', () => {
    renderRows(
      [
        dto({
          identifier: 'W-1',
          viewerIsAssignee: false,
          viewerIsReporter: false,
          assigneeId: 'u2',
        }),
      ],
      'watching',
    );
    expect(within(screen.getByTestId('workbench-row-W-1')).getByText('Watching')).toBeTruthy();
  });

  it('resolves every row s status against the ACTIVE project s workflow', () => {
    renderRows([dto({ identifier: 'MOTIR-1' }), dto({ identifier: 'MOTIR-2' })]);

    // One project, one workflow, one label — the shape `/items` has always had.
    // The per-project map this replaced was rent Home paid on spanning projects.
    expect(
      within(screen.getByTestId('workbench-row-MOTIR-1')).getByText('In Progress'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('workbench-row-MOTIR-2')).getByText('In Progress'),
    ).toBeTruthy();
  });

  it('falls back to the raw status key when the workflow cannot classify it', () => {
    renderRows([dto({ identifier: 'X-1', status: 'some_custom_state' })]);
    expect(
      within(screen.getByTestId('workbench-row-X-1')).getByText('some_custom_state'),
    ).toBeTruthy();
  });

  it('says Unassigned for an assignee who is no longer a workspace MEMBER', () => {
    // A person can leave a workspace while still holding assignments — the row
    // keeps the id and the member list stops carrying the name. The mapper is
    // total over that, because the alternative is a row rendering a raw cuid.
    renderRows([dto({ identifier: 'G-1', assigneeId: 'u_departed' })]);
    expect(within(screen.getByTestId('workbench-row-G-1')).getByText('Unassigned')).toBeTruthy();
    expect(within(screen.getByTestId('workbench-row-G-1')).queryByText('u_departed')).toBeNull();
  });

  it('resolves the assignee name, and says Unassigned rather than nothing', () => {
    renderRows([
      dto({ identifier: 'A-1', assigneeId: 'u2' }),
      dto({ identifier: 'N-1', assigneeId: null, viewerIsAssignee: false }),
    ]);
    expect(within(screen.getByTestId('workbench-row-A-1')).getByText('Mei Lin')).toBeTruthy();
    expect(within(screen.getByTestId('workbench-row-N-1')).getByText('Unassigned')).toBeTruthy();
  });
});

describe('the Workbench row — the agent treatment', () => {
  it('badges the ASSIGNEE AVATAR, and says so for a screen reader', () => {
    renderRows([dto({ identifier: 'AG-1', executor: 'coding_agent' })]);
    const row = screen.getByTestId('workbench-row-AG-1');

    // The meaning is carried by text, not by the glyph — the badge is
    // aria-hidden decoration (the AA rule).
    expect(within(row).getByText('An agent is executing this item')).toBeTruthy();
    expect(row.querySelector('.bg-\\(--el-executor-agent\\)')).toBeTruthy();
    // …and it is on a row in the SAME list, with no section of its own.
    expect(within(row).getByText('Zhu Yue')).toBeTruthy();
  });

  it('leaves a human-executed row unbadged', () => {
    renderRows([dto({ identifier: 'HU-1', executor: 'human' })]);
    const row = screen.getByTestId('workbench-row-HU-1');
    expect(within(row).queryByText('An agent is executing this item')).toBeNull();
    expect(row.querySelector('.bg-\\(--el-executor-agent\\)')).toBeNull();
  });

  it('renders NO agent section or heading anywhere — it is a row state', () => {
    renderRows([
      dto({ identifier: 'AG-1', executor: 'coding_agent' }),
      dto({ identifier: 'HU-1', executor: 'human' }),
    ]);
    // One list, one rowgroup of rows. If an implementation ever sections agent
    // work off, this count changes.
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + two rows
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });
});

describe('the Workbench row — the whole-row link', () => {
  it('points at the item, and a PLAIN click opens the peek instead of navigating', () => {
    renderRows([dto({ identifier: 'MOTIR-1', title: 'The personal reads' })]);
    const link = screen.getByRole('link', { name: 'MOTIR-1 The personal reads' });

    // The href is real, so ⌘/middle-click still opens the detail page in a new
    // tab — the peek is an interception, not a replacement.
    expect(link.getAttribute('href')).toBe('/items/MOTIR-1');

    const pushState = vi.spyOn(window.history, 'pushState');
    fireEvent.click(link, { button: 0 });
    // The SAME `?peek=` island /items, /ready and the board use — a SHALLOW URL
    // push, not a route navigation, so the host page never re-renders. Opening
    // a row from the Workbench is not a different interaction, so it is not a second
    // surface.
    expect(pushState).toHaveBeenCalledWith(null, '', expect.stringContaining('peek=MOTIR-1'));
    pushState.mockRestore();
  });

  it('lets a MODIFIED click through to the browser', () => {
    renderRows([dto({ identifier: 'MOTIR-1', title: 'The personal reads' })]);
    const pushState = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByRole('link', { name: 'MOTIR-1 The personal reads' }), {
      button: 0,
      metaKey: true,
    });
    // ⌘/ctrl/middle-click keeps its native meaning — open the detail page in a
    // new tab — which is why the row's href has to be real in the first place.
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });
});

describe('toWorkbenchRowViews — the role fallback', () => {
  it('never leaves a WORK row without a role, even if the read ever widened', () => {
    // Unreachable through the shipped read — its predicate IS assignee-or-
    // reporter — but the mapper is total rather than trusting that, because a
    // row with no role would render an empty cell and look like a bug in the
    // data rather than in the read.
    const [row] = toWorkbenchRowViews(
      [dto({ identifier: 'Z-1', viewerIsAssignee: false, viewerIsReporter: false })],
      WORKFLOW,
      MEMBERS,
      false,
    );
    expect(row?.role).toBe('assigned');
  });
});

describe('the Workbench tab strip', () => {
  const counts: HomeTabCountsDto = {
    myWork: 12,
    toDo: 5,
    inProgress: 7,
    recentlyFinished: 2,
    approvals: 0,
    watching: 4,
  };

  it('spells each of the five tabs as a real href, with the active one marked', async () => {
    renderRaw(await WorkbenchTabs({ active: 'todo', counts }));

    // The selection is a URL, not component state — which is what makes it
    // linkable, reload-safe and cheap to assert. To do is the DEFAULT and is
    // therefore spelled as the ABSENCE of the param.
    const href = (key: string) => screen.getByTestId(`workbench-tab-${key}`).getAttribute('href');
    expect(href('todo')).toBe('/workbench');
    expect(href('in-progress')).toBe('/workbench?tab=in-progress');
    expect(href('finished')).toBe('/workbench?tab=finished');
    expect(href('watching')).toBe('/workbench?tab=watching');
    expect(href('approvals')).toBe('/workbench?tab=approvals');

    expect(screen.getByTestId('workbench-tab-todo').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('workbench-tab-watching').getAttribute('aria-current')).toBeNull();
  });

  it('reads the design s labels — and the fifth names an ACTION, not a set', async () => {
    renderRaw(await WorkbenchTabs({ active: 'todo', counts }));
    expect(screen.getAllByRole('link').map((l) => l.textContent?.replace(/\d+$/, ''))).toEqual([
      'To do',
      'In progress',
      'Recently finished',
      'Watching',
      // ⚠️ The LABEL and the SLUG differ on purpose: the four above name a state
      // a work item is IN, and this one names something the READER must do,
      // which is the whole reason it sits apart from them. Its href is asserted
      // as `?tab=approvals` above; the two spellings are checked together so
      // neither can be "fixed" into agreement.
      'To approve',
    ]);
  });

  it('marks a non-default tab current on that tab', async () => {
    renderRaw(await WorkbenchTabs({ active: 'finished', counts }));
    expect(screen.getByTestId('workbench-tab-finished').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('workbench-tab-todo').getAttribute('aria-current')).toBeNull();
  });

  it('shows every count', async () => {
    renderRaw(await WorkbenchTabs({ active: 'todo', counts }));
    const count = (key: string) => screen.getByTestId(`workbench-tab-${key}`).textContent;
    expect(count('todo')).toContain('5');
    expect(count('in-progress')).toContain('7');
    expect(count('finished')).toContain('2');
    expect(count('watching')).toContain('4');
    // Zero beside four non-zero siblings is INFORMATION — "nothing over there
    // either" — which is why the suppression below is on all-zero, not on each.
    expect(count('approvals')).toContain('0');
  });

  it('SUPPRESSES every count when they are ALL zero', async () => {
    renderRaw(
      await WorkbenchTabs({
        active: 'todo',
        counts: {
          myWork: 0,
          toDo: 0,
          inProgress: 0,
          recentlyFinished: 0,
          approvals: 0,
          watching: 0,
        },
      }),
    );
    // A brand-new user's first screen: five "0"s are five numbers they have to
    // read and then discard. The shipped rule, now suppressing five, not two.
    for (const key of ['todo', 'in-progress', 'finished', 'watching', 'approvals']) {
      expect(within(screen.getByTestId(`workbench-tab-${key}`)).queryByText('0')).toBeNull();
    }
  });

  it('SCROLLS at narrow widths rather than shrinking or wrapping', async () => {
    renderRaw(await WorkbenchTabs({ active: 'todo', counts }));
    // Measured on the design asset: five tabs are 662px of track and the `< md`
    // content box is 386px, where the two-tab strip this replaces was 249px and
    // fitted. Shrinking truncates the labels that make a tab worth switching to.
    const nav = screen.getByRole('navigation');
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).toContain('max-w-full');
    expect(screen.getByTestId('workbench-tab-todo').className).toContain('shrink-0');
  });
});

describe('Recently finished — the fifth column', () => {
  const finished = (over: Partial<HomeWorkItemRowDto> & { identifier: string }) =>
    dto({ status: 'done', completedAt: '2026-08-11T00:00:00.000Z', ...over });

  it('adds a Finished header, and ONLY on that tab', () => {
    renderRows([finished({ identifier: 'F-1' })], 'finished');
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Title',
      'Your role',
      'Assignee',
      'Status',
      'Finished',
    ]);

    cleanup();
    renderRows([dto({ identifier: 'T-1' })], 'todo');
    expect(screen.queryByRole('columnheader', { name: 'Finished' })).toBeNull();
  });

  it('renders the finish time RELATIVE, and yesterday as a word', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    renderRows([finished({ identifier: 'F-1', completedAt: yesterday })], 'finished');
    // `numeric: 'auto'` is what turns −1 into "yesterday" rather than "1 day
    // ago"; a list of this week's work reads as a week, not as arithmetic.
    expect(within(screen.getByTestId('workbench-row-F-1')).getByText('yesterday')).toBeTruthy();
  });

  it('never renders a FUTURE finish — a clock skew is clamped to today', () => {
    const ahead = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    renderRows([finished({ identifier: 'F-2', completedAt: ahead })], 'finished');
    expect(within(screen.getByTestId('workbench-row-F-2')).getByText('today')).toBeTruthy();
  });

  it('renders an EMPTY finished cell rather than a date it does not have', () => {
    // Unreachable through the shipped read — Recently finished filters on
    // `completedAt >= <window>`, so every row it returns carries one — but the
    // cell is total anyway, because the alternative is `Invalid Date` in a
    // column on the landing page. Cheap to build here (the component takes
    // props), so it is COVERED rather than adjudicated: the arm is only
    // unreachable through one caller, and a component is not owned by its
    // callers.
    renderRows([finished({ identifier: 'F-0', completedAt: null })], 'finished');
    const cells = within(screen.getByTestId('workbench-row-F-0')).getAllByRole('cell');
    expect(cells).toHaveLength(5); // Title · Your role · Assignee · Status · Finished
    expect(cells.at(-1)?.textContent).toBe('');
  });

  it('draws Cancelled BESIDE Done, and not as the same thing', () => {
    // Both are `done`-category and both land here. Cancelled means ABANDONED,
    // not accomplished — the discrimination `applyStatusTransition`'s stamp and
    // `roadmapDoneStatusKeys` already make — so the two carry different chips.
    renderRows(
      [
        finished({ identifier: 'D-1', status: 'done' }),
        finished({ identifier: 'C-1', status: 'cancelled' }),
      ],
      'finished',
    );
    const chip = (id: string) =>
      within(screen.getByTestId(`workbench-row-${id}`)).getByText(
        id === 'D-1' ? 'Done' : 'Cancelled',
      );
    expect(chip('D-1').className).not.toBe(chip('C-1').className);
  });
});

describe('Watching — the two group bands', () => {
  const watching = (identifier: string, status: string) =>
    dto({ identifier, status, viewerIsAssignee: false, viewerIsReporter: false, assigneeId: 'u2' });

  it('bands what is MOVING above what is WAITING, in the read s own order', () => {
    // The READ ordered these (MOTIR-4781); the list finds the boundary rather
    // than sorting, because a client-side re-sort of a keyset-paged list is
    // exactly what stops a page boundary being exact.
    renderRows(
      [watching('M-1', 'in_progress'), watching('M-2', 'in_progress'), watching('W-1', 'todo')],
      'watching',
    );

    const bands = screen.getAllByRole('rowheader').map((b) => b.textContent);
    expect(bands).toEqual(['In progress', 'To do']);

    // Each band carries a COUNT — which is what stops it reading as a second
    // set of column labels, since a column header never counts anything.
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    expect(rows[1]).toContain('2');
    expect(rows.findIndex((r) => r.includes('To do'))).toBeGreaterThan(
      rows.findIndex((r) => r.includes('M-2')),
    );
  });

  it('renders only the band a page actually holds', () => {
    // A keyset page can land entirely inside one group; a band over nothing
    // would claim a group the reader cannot see.
    renderRows([watching('W-1', 'todo'), watching('W-2', 'todo')], 'watching');
    expect(screen.getAllByRole('rowheader').map((b) => b.textContent)).toEqual(['To do']);
  });

  it('bands NOTHING on the four work tabs', () => {
    renderRows([dto({ identifier: 'T-1', status: 'in_progress' })], 'in-progress');
    expect(screen.queryAllByRole('rowheader')).toEqual([]);
  });
});
