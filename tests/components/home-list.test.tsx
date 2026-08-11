// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderRaw, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The `/home` list row (Story MOTIR-2649 · Subtask MOTIR-2653) under happy-dom.
// The reads are covered against real Postgres in `tests/integration/home/`;
// these cover the two things only the RENDER can be wrong about — the cells the
// design added, and the agent treatment.

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: 'home') =>
      createTranslator({ locale: 'en', messages, namespace }),
  };
});

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
}));

import { HomeList } from '@/app/(authed)/home/_components/HomeList';
import { HomeTabs } from '@/app/(authed)/home/_components/HomeTabs';
import { toHomeRowViews } from '@/app/(authed)/home/_components/homeRows';

afterEach(() => {
  cleanup();
  push.mockReset();
});

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Zhu Yue', email: 'yue@example.com', role: 'owner' },
  { userId: 'u2', name: 'Mei Lin', email: 'mei@example.com', role: 'member' },
];

/** Two projects that spell the SAME status key differently — the case a shared
 *  workflow would render wrong, and silently. */
const WORKFLOWS = new Map<string, WorkflowDto>([
  [
    'p1',
    {
      statuses: [{ key: 'in_progress', label: 'In Progress', category: 'in_progress' }],
    } as unknown as WorkflowDto,
  ],
  [
    'p2',
    {
      statuses: [{ key: 'in_progress', label: 'Doing', category: 'in_progress' }],
    } as unknown as WorkflowDto,
  ],
]);

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
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: true,
    ...over,
  };
}

const renderRows = (rows: HomeWorkItemRowDto[], tab: 'work' | 'watching' = 'work') =>
  render(<HomeList rows={toHomeRowViews(rows, WORKFLOWS, MEMBERS, tab)} label="My work" />);

describe('the Home row — the cells the design added', () => {
  it('identifies the owning project on every row', () => {
    renderRows([
      dto({ identifier: 'MOTIR-1' }),
      dto({ identifier: 'ATLAS-1', project: { id: 'p2', identifier: 'ATLAS', name: 'Atlas' } }),
    ]);

    expect(within(screen.getByTestId('home-row-MOTIR-1')).getByText('Motir')).toBeTruthy();
    expect(within(screen.getByTestId('home-row-ATLAS-1')).getByText('Atlas')).toBeTruthy();
  });

  it('names the reader s relation, and marks BOTH as the one worth spotting', () => {
    renderRows([
      dto({ identifier: 'A-1', viewerIsAssignee: true, viewerIsReporter: false }),
      dto({ identifier: 'R-1', viewerIsAssignee: false, viewerIsReporter: true, assigneeId: 'u2' }),
      dto({ identifier: 'B-1', viewerIsAssignee: true, viewerIsReporter: true }),
    ]);

    expect(within(screen.getByTestId('home-row-A-1')).getByText('Assigned')).toBeTruthy();
    expect(within(screen.getByTestId('home-row-R-1')).getByText('Reported')).toBeTruthy();

    // `Both` is the only value not derivable from the Assignee cell, and it is
    // the dedupe made visible — so it carries WEIGHT as well as ink, the
    // non-colour redundant cue (finding #35).
    const both = within(screen.getByTestId('home-row-B-1')).getByText('Both');
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
    expect(within(screen.getByTestId('home-row-W-1')).getByText('Watching')).toBeTruthy();
  });

  it('resolves each row s status against ITS OWN project s workflow', () => {
    renderRows([
      dto({ identifier: 'MOTIR-1' }),
      dto({ identifier: 'ATLAS-1', project: { id: 'p2', identifier: 'ATLAS', name: 'Atlas' } }),
    ]);

    // Same status KEY, two projects, two labels. A single shared workflow would
    // render one of these wrong and would never say so.
    expect(within(screen.getByTestId('home-row-MOTIR-1')).getByText('In Progress')).toBeTruthy();
    expect(within(screen.getByTestId('home-row-ATLAS-1')).getByText('Doing')).toBeTruthy();
  });

  it('falls back to the raw status key when a project s workflow cannot classify it', () => {
    renderRows([dto({ identifier: 'X-1', status: 'some_custom_state' })]);
    expect(within(screen.getByTestId('home-row-X-1')).getByText('some_custom_state')).toBeTruthy();
  });

  it('resolves the assignee name, and says Unassigned rather than nothing', () => {
    renderRows([
      dto({ identifier: 'A-1', assigneeId: 'u2' }),
      dto({ identifier: 'N-1', assigneeId: null, viewerIsAssignee: false }),
    ]);
    expect(within(screen.getByTestId('home-row-A-1')).getByText('Mei Lin')).toBeTruthy();
    expect(within(screen.getByTestId('home-row-N-1')).getByText('Unassigned')).toBeTruthy();
  });
});

describe('the Home row — the agent treatment', () => {
  it('badges the ASSIGNEE AVATAR, and says so for a screen reader', () => {
    renderRows([dto({ identifier: 'AG-1', executor: 'coding_agent' })]);
    const row = screen.getByTestId('home-row-AG-1');

    // The meaning is carried by text, not by the glyph — the badge is
    // aria-hidden decoration (the AA rule).
    expect(within(row).getByText('An agent is executing this item')).toBeTruthy();
    expect(row.querySelector('.bg-\\(--el-executor-agent\\)')).toBeTruthy();
    // …and it is on a row in the SAME list, with no section of its own.
    expect(within(row).getByText('Zhu Yue')).toBeTruthy();
  });

  it('leaves a human-executed row unbadged', () => {
    renderRows([dto({ identifier: 'HU-1', executor: 'human' })]);
    const row = screen.getByTestId('home-row-HU-1');
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

describe('the Home row — the whole-row link', () => {
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
    // a row from Home is not a different interaction, so it is not a second
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

describe('toHomeRowViews — the role fallback', () => {
  it('never leaves a My work row without a role, even if the read ever widened', () => {
    // Unreachable through the shipped read — its predicate IS assignee-or-
    // reporter — but the mapper is total rather than trusting that, because a
    // row with no role would render an empty cell and look like a bug in the
    // data rather than in the read.
    const [row] = toHomeRowViews(
      [dto({ identifier: 'Z-1', viewerIsAssignee: false, viewerIsReporter: false })],
      WORKFLOWS,
      MEMBERS,
      'work',
    );
    expect(row?.role).toBe('assigned');
  });
});

describe('the Home tab strip', () => {
  const counts = { myWork: 12, watching: 4 };

  it('spells each tab as a real href, with the active one marked', async () => {
    renderRaw(await HomeTabs({ active: 'work', counts }));

    const work = screen.getByTestId('home-tab-work');
    const watching = screen.getByTestId('home-tab-watching');
    // The selection is a URL, not component state — which is what makes it
    // linkable, reload-safe and cheap to assert.
    expect(work.getAttribute('href')).toBe('/home');
    expect(watching.getAttribute('href')).toBe('/home?tab=watching');
    expect(work.getAttribute('aria-current')).toBe('page');
    expect(watching.getAttribute('aria-current')).toBeNull();
  });

  it('marks the Watching tab current on that tab', async () => {
    renderRaw(await HomeTabs({ active: 'watching', counts }));
    expect(screen.getByTestId('home-tab-watching').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('home-tab-work').getAttribute('aria-current')).toBeNull();
  });

  it('shows both counts', async () => {
    renderRaw(await HomeTabs({ active: 'work', counts }));
    expect(within(screen.getByTestId('home-tab-work')).getByText('12')).toBeTruthy();
    expect(within(screen.getByTestId('home-tab-watching')).getByText('4')).toBeTruthy();
  });

  it('SUPPRESSES both counts when both are zero', async () => {
    renderRaw(await HomeTabs({ active: 'work', counts: { myWork: 0, watching: 0 } }));
    // A brand-new user's first screen: a "0" beside each tab is a number they
    // have to read and then discard.
    expect(within(screen.getByTestId('home-tab-work')).queryByText('0')).toBeNull();
    expect(within(screen.getByTestId('home-tab-watching')).queryByText('0')).toBeNull();
  });

  it('KEEPS a zero that sits beside a non-zero sibling', async () => {
    renderRaw(await HomeTabs({ active: 'work', counts: { myWork: 3, watching: 0 } }));
    // That zero is information — "nothing over there either" — rather than
    // noise, which is why the suppression is on both-zero and not on each.
    expect(within(screen.getByTestId('home-tab-watching')).getByText('0')).toBeTruthy();
  });
});
