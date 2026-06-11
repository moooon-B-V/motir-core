// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type {
  ActivityAllPageDto,
  ActivityEntryDto,
  ActivityEntryPartDto,
  ActivityHistoryPageDto,
} from '@/lib/dto/activity';
import type { CommentDTO, CommentThreadDTO } from '@/lib/dto/comments';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// ActivitySection (Subtask 5.5.4) — the completed Activity section: the three
// LIVE URL-driven tabs (default Comments), the history row grammar (a render
// test per change-type form, per `activity-history.mock.html` panels 1–2),
// the All interleave, "Show more" paging, and the ONE sort toggle governing
// every tab (the shared 5.1.5 store). The service matrix belongs to the
// 5.5.1/5.5.2 integration tests; the live journey to the 5.5.5 story E2E.

const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
  usePathname: () => '/issues/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/issues/[key]/commentActions', () => ({
  addCommentAction: vi.fn(),
  editCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
// The composer embeds the client-only Tiptap MarkdownEditor — stub it to a
// labelled textarea (the CommentsSection test convention).
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import { ActivitySection } from '@/app/(authed)/issues/[key]/_components/ActivitySection';
import { resetCommentsSortForTests } from '@/lib/hooks/useCommentsSort';

const BO = { userId: 'u-bo', name: 'Bo Philips', image: null };

const WORKFLOW: WorkflowStatusDto[] = (
  [
    ['todo', 'To do', 'todo'],
    ['in_progress', 'In progress', 'in_progress'],
    ['done', 'Done', 'done'],
    ['blocked', 'Blocked', 'todo'],
  ] as const
).map(([key, label, category], index) => ({
  id: `ws-${key}`,
  projectId: 'p-1',
  key,
  label,
  category,
  color: null,
  position: String(index),
  isInitial: key === 'todo',
}));

let revSeq = 0;
/** Entries are built NEWEST-first (the held-desc window order). */
function entry(
  parts: ActivityEntryPartDto[],
  overrides: Partial<ActivityEntryDto> = {},
): ActivityEntryDto {
  revSeq += 1;
  return {
    id: `rev-${revSeq}`,
    workItemId: 'wi-1',
    changeKind: 'updated',
    changedAt: new Date(Date.now() - revSeq * 60_000).toISOString(),
    actor: BO,
    parts,
    ...overrides,
  };
}

function historyPage(
  entries: ActivityEntryDto[],
  overrides: Partial<ActivityHistoryPageDto> = {},
): ActivityHistoryPageDto {
  return { entries, nextCursor: null, totalCount: entries.length, ...overrides };
}

let commentSeq = 0;
function comment(overrides: Partial<CommentDTO> = {}): CommentDTO {
  commentSeq += 1;
  return {
    id: `c-${commentSeq}`,
    workItemId: 'wi-1',
    parentCommentId: null,
    author: { id: 'u-zhu', name: 'Zhu Yue', image: null },
    bodyMd: `Comment body ${commentSeq}`,
    editedAt: null,
    createdAt: new Date(Date.now() - commentSeq * 90_000).toISOString(),
    mentionedUserIds: [],
    ...overrides,
  };
}
function thread(replies: CommentDTO[] = []): CommentThreadDTO {
  return { ...comment(), replies };
}

const COMMENTS_PROPS = {
  canComment: true,
  canModerate: false,
  currentUserId: 'u-me',
  currentUserName: 'Me',
  mentionCandidates: [],
};

function renderSection({
  tab = 'history' as const,
  initialHistory = null as ActivityHistoryPageDto | null,
  initialAll = null as ActivityAllPageDto | null,
}: {
  tab?: 'all' | 'comments' | 'history';
  initialHistory?: ActivityHistoryPageDto | null;
  initialAll?: ActivityAllPageDto | null;
} = {}) {
  return render(
    <ActivitySection
      workItemId="wi-1"
      tab={tab}
      workflowStatuses={WORKFLOW}
      comments={COMMENTS_PROPS}
      initialComments={null}
      initialHistory={initialHistory}
      initialAll={initialAll}
    />,
  );
}

describe('ActivitySection (5.5.4)', () => {
  beforeEach(() => {
    revSeq = 0;
    commentSeq = 0;
    resetCommentsSortForTests();
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ── the history row grammar — one render assertion per change-type form ──

  it('renders scalar, status, user, date, body-edit and sprint forms (panel 1)', () => {
    renderSection({
      initialHistory: historyPage([
        entry([
          {
            kind: 'field',
            field: 'priority',
            from: { type: 'text', text: 'Medium' },
            to: { type: 'text', text: 'High' },
          },
        ]),
        entry([
          {
            kind: 'field',
            field: 'status',
            from: { type: 'status', key: 'todo', label: 'To do' },
            to: { type: 'status', key: 'blocked', label: 'Blocked' },
          },
        ]),
        entry([
          {
            kind: 'field',
            field: 'assigneeId',
            from: { type: 'none' },
            to: { type: 'user', userId: 'u-mo', name: 'Mo', image: null },
          },
        ]),
        entry([
          {
            kind: 'field',
            field: 'dueDate',
            from: { type: 'none' },
            to: { type: 'date', date: '2026-06-12T00:00:00.000Z' },
          },
        ]),
        entry([{ kind: 'fieldEdited', field: 'descriptionMd' }]),
        entry([
          {
            kind: 'field',
            field: 'sprintId',
            from: { type: 'sprint', sprintId: 'sp-3', name: 'Sprint 3' },
            to: { type: 'sprint', sprintId: 'sp-4', name: 'Sprint 4' },
          },
        ]),
        entry([
          {
            kind: 'field',
            field: 'sprintId',
            from: { type: 'sprint', sprintId: 'sp-4', name: 'Sprint 4' },
            to: { type: 'none' },
          },
        ]),
      ]),
    });

    const feed = screen.getByRole('list', { name: 'History' });
    // scalar — old struck, new emphasised
    expect(within(feed).getByText('Medium').className).toContain('line-through');
    expect(within(feed).getByText('High').className).toContain('font-medium');
    // status — workflow LABELS as category-tinted Pills (blocked → peach)
    expect(within(feed).getByText('To do').className).toContain('tint-lavender');
    expect(within(feed).getByText('Blocked').className).toContain('tint-peach');
    // user — "None" empty sides (assignee + due date) + avatar'd name
    expect(within(feed).getAllByText('None')).toHaveLength(2);
    expect(within(feed).getByText('Mo')).toBeTruthy();
    // date — the rail formatDate form
    expect(within(feed).getByText('Jun 12, 2026')).toBeTruthy();
    // body edit — the verb sentence only, never the text
    expect(within(feed).getByText(/updated the/)).toBeTruthy();
    expect(within(feed).getByText('Description')).toBeTruthy();
    // sprint — names resolved; the backlog form
    expect(within(feed).getAllByText('Sprint 4').length).toBeGreaterThan(0);
    expect(within(feed).getAllByText(/moved this issue to/).length).toBe(2);
    expect(within(feed).getAllByText('Backlog').length).toBeGreaterThan(0);
  });

  it('renders link, chip, attachment, custom-field, comment-deletion, fallback and anchor forms (panel 2)', () => {
    renderSection({
      initialHistory: historyPage([
        entry([
          {
            kind: 'link',
            op: 'added',
            linkKind: 'blocks',
            target: { type: 'issue', workItemId: 'wi-12', identifier: 'PROD-12' },
          },
        ]),
        entry([
          {
            kind: 'link',
            op: 'removed',
            linkKind: 'relates_to',
            target: { type: 'issue', workItemId: 'wi-48', identifier: 'PROD-48' },
          },
        ]),
        entry([{ kind: 'collection', field: 'labels', op: 'added', items: ['design'] }]),
        entry([
          { kind: 'collection', field: 'components', op: 'removed', items: ['Board engine'] },
        ]),
        entry([
          { kind: 'collection', field: 'attachments', op: 'added', items: ['drag-repro.mp4'] },
        ]),
        entry([
          {
            kind: 'field',
            field: 'customFields.severity',
            from: { type: 'none' },
            to: { type: 'text', text: 'Critical' },
          },
        ]),
        entry([
          {
            kind: 'commentDeleted',
            author: { type: 'user', userId: 'u-zhu', name: 'Zhu Yue', image: null },
            replyCount: 2,
          },
        ]),
        entry([{ kind: 'generic', key: 'riskScore', from: '3', to: '7' }]),
        entry(
          [
            {
              kind: 'field',
              field: 'estimateMinutes',
              from: { type: 'text', text: '30' },
              to: { type: 'text', text: '45' },
            },
          ],
          { actor: { userId: 'u-gone', name: null, image: null } },
        ),
        entry([{ kind: 'archived' }], { changeKind: 'archived' }),
        entry([{ kind: 'created' }], { changeKind: 'created' }),
      ]),
    });

    const feed = screen.getByRole('list', { name: 'History' });
    // links — mono identifier (a real link) + the italic kind
    expect(within(feed).getByRole('link', { name: 'PROD-12' })).toBeTruthy();
    expect(within(feed).getByText('blocks')).toBeTruthy();
    expect(within(feed).getByText('relates to')).toBeTruthy();
    expect(within(feed).getByRole('link', { name: 'PROD-48' })).toBeTruthy();
    // label chip (name-hash tint) + neutral component chip + mono filename
    expect(within(feed).getByText('design')).toBeTruthy();
    expect(within(feed).getByText('Board engine')).toBeTruthy();
    expect(within(feed).getByText('drag-repro.mp4')).toBeTruthy();
    // custom field — the stored key suffix as the field name
    expect(within(feed).getByText('severity')).toBeTruthy();
    expect(within(feed).getByText('Critical')).toBeTruthy();
    // comment deletion — who/when + the reply gloss, NEVER the content
    expect(within(feed).getByText(/deleted a comment/)).toBeTruthy();
    expect(within(feed).getByText('and its 2 replies — content not retained')).toBeTruthy();
    // the generic fallback — a designed state (mono key + values)
    expect(within(feed).getByText('riskScore')).toBeTruthy();
    expect(within(feed).getByText('3')).toBeTruthy();
    expect(within(feed).getByText('7')).toBeTruthy();
    // deleted referent — the Former member form
    expect(within(feed).getByText('Former member')).toBeTruthy();
    // anchors
    expect(within(feed).getByText(/created the issue/)).toBeTruthy();
    expect(within(feed).getByText(/archived the issue/)).toBeTruthy();
  });

  it('history is read-only: no row carries any action affordance', () => {
    renderSection({
      initialHistory: historyPage([
        entry([
          {
            kind: 'field',
            field: 'title',
            from: { type: 'text', text: 'Old' },
            to: { type: 'text', text: 'New' },
          },
        ]),
      ]),
    });
    // The only buttons in the section are the header controls (filter + sort).
    const feed = screen.getByRole('list', { name: 'History' });
    expect(within(feed).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the changes count gloss and the empty-history state', () => {
    const { unmount } = renderSection({
      initialHistory: historyPage([entry([{ kind: 'created' }], { changeKind: 'created' })], {
        totalCount: 34,
      }),
    });
    expect(screen.getByText('— 34 changes')).toBeTruthy();
    unmount();

    renderSection({ initialHistory: historyPage([]) });
    expect(
      screen.getByText('No history yet — changes to this issue will show up here'),
    ).toBeTruthy();
  });

  // ── paging ──

  it('"Show more changes (N older)" fetches the next cursor page and appends it', async () => {
    const older = entry([{ kind: 'created' }], { changeKind: 'created' });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => historyPage([older], { totalCount: 2 }),
    } as Response);

    renderSection({
      initialHistory: historyPage(
        [
          entry([
            {
              kind: 'field',
              field: 'priority',
              from: { type: 'text', text: 'Low' },
              to: { type: 'text', text: 'High' },
            },
          ]),
        ],
        { totalCount: 2, nextCursor: 'rev-1' },
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show more changes (1 older)' }));
    await waitFor(() => expect(screen.getByText(/created the issue/)).toBeTruthy());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/work-items/wi-1/activity/history?order=desc&cursor=rev-1',
    );
  });

  // ── tab switching (URL-driven) ──

  it('switching tabs replaces the URL: non-default sets ?activity=, Comments clears it', () => {
    renderSection({ initialHistory: historyPage([]) });
    const filter = () => screen.getByRole('group', { name: 'Activity filter' });

    fireEvent.click(within(filter()).getByRole('button', { name: 'All' }));
    expect(replace).toHaveBeenCalledWith('/issues/PROD-7?activity=all', { scroll: false });

    // The section re-renders (the transition skeleton) — re-query the control.
    fireEvent.click(within(filter()).getByRole('button', { name: 'Comments' }));
    expect(replace).toHaveBeenCalledWith('/issues/PROD-7', { scroll: false });
  });

  it('the default Comments tab renders the 5.1.5 surface with the live filter', () => {
    renderSection({ tab: 'comments' });
    // CommentsSection with a null page → its ErrorState (the 5.1.5 behaviour)
    expect(screen.getByText("Couldn't load comments")).toBeTruthy();
    // …but the header filter is the LIVE three-tab control, History enabled.
    const filter = screen.getByRole('group', { name: 'Activity filter' });
    const history = within(filter).getByRole('button', { name: 'History' });
    expect((history as HTMLButtonElement).disabled).toBe(false);
    expect(within(filter).getByRole('button', { name: 'All' })).toBeTruthy();
  });

  // ── the ONE sort toggle ──

  it('the sort toggle flips the displayed order without refetching and persists', () => {
    renderSection({
      initialHistory: historyPage([
        entry([
          {
            kind: 'field',
            field: 'priority',
            from: { type: 'text', text: 'Low' },
            to: { type: 'text', text: 'High' },
          },
        ]),
        entry([{ kind: 'created' }], { changeKind: 'created' }),
      ]),
    });

    // Default oldest-first: the created anchor renders first.
    let items = within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('created the issue');

    fireEvent.click(screen.getByRole('button', { name: 'Sort activity, oldest first' }));
    items = within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Priority');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('prodect.issues.comments.sort')).toBe('desc');
  });

  // ── the All stream ──

  it('All interleaves comments (native grammar, actions live) with quiet history rows', () => {
    const threadEntry = thread();
    renderSection({
      tab: 'all',
      initialAll: {
        entries: [
          {
            type: 'history',
            entry: entry([
              {
                kind: 'field',
                field: 'status',
                from: { type: 'status', key: 'todo', label: 'To do' },
                to: { type: 'status', key: 'in_progress', label: 'In progress' },
              },
            ]),
          },
          { type: 'comment', thread: threadEntry },
          {
            type: 'history',
            entry: entry([
              {
                kind: 'commentDeleted',
                author: { type: 'user', userId: 'u-zhu', name: 'Zhu Yue', image: null },
                replyCount: 0,
              },
            ]),
          },
        ],
        nextCursor: null,
        totalComments: 12,
        totalChanges: 34,
      },
    });

    // The both-sources gloss.
    expect(screen.getByText('— 12 comments · 34 changes')).toBeTruthy();
    const feed = screen.getByRole('list', { name: 'All activity' });
    // The comment renders its full 5.1.3 grammar — body + live Reply.
    expect(within(feed).getByText(threadEntry.bodyMd)).toBeTruthy();
    expect(within(feed).getByRole('button', { name: 'Reply' })).toBeTruthy();
    // History rows render the quiet grammar between comments.
    expect(within(feed).getByText('In progress')).toBeTruthy();
    // The deletion record appears once, as history, content-free.
    expect(within(feed).getByText(/deleted a comment/)).toBeTruthy();
    expect(within(feed).getByText('content not retained')).toBeTruthy();
  });

  it('All pages through the composite cursor with "Show more activity (N older)"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [
          { type: 'history', entry: entry([{ kind: 'created' }], { changeKind: 'created' }) },
        ],
        nextCursor: null,
        totalComments: 1,
        totalChanges: 2,
      }),
    } as Response);

    renderSection({
      tab: 'all',
      initialAll: {
        entries: [{ type: 'comment', thread: thread() }],
        nextCursor: 'composite-1',
        totalComments: 1,
        totalChanges: 2,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show more activity (2 older)' }));
    await waitFor(() => expect(screen.getByText(/created the issue/)).toBeTruthy());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/work-items/wi-1/activity/all?order=desc&cursor=composite-1',
    );
  });

  // ── failure states ──

  it('a failed server read renders the tab ErrorState and retry refetches page 1', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        historyPage([entry([{ kind: 'created' }], { changeKind: 'created' })], { totalCount: 1 }),
    } as Response);

    renderSection({ initialHistory: null });
    expect(screen.getByText("Couldn't load history")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText(/created the issue/)).toBeTruthy());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/work-items/wi-1/activity/history?order=desc',
    );
  });
});
