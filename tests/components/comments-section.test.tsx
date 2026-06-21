// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { CommentDTO, CommentsPageDTO, CommentThreadDTO } from '@/lib/dto/comments';

// CommentsSection (Subtask 5.1.5) — the detail page's Activity slot. Covers
// the role matrix rendering (viewer / member / author / moderator), the
// "Show more comments (N older)" paging read, the reply auto-collapse, the
// sort toggle's presentation flip, and the delete confirm's reply-count copy
// — the section's own client logic; the service matrix + the live journey
// belong to the 5.1.2 integration tests and the 5.1.7 story E2E.

const addCommentAction = vi.fn();
const editCommentAction = vi.fn();
const deleteCommentAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/commentActions', () => ({
  addCommentAction: (...args: unknown[]) => addCommentAction(...args),
  editCommentAction: (...args: unknown[]) => editCommentAction(...args),
  deleteCommentAction: (...args: unknown[]) => deleteCommentAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
// The composer embeds the client-only Tiptap MarkdownEditor — stub it to a
// labelled textarea (the CreateIssueModal/EditIssueForm test convention).
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

import { CommentsSection } from '@/app/(authed)/items/[key]/_components/CommentsSection';
import { resetCommentsSortForTests } from '@/lib/hooks/useCommentsSort';

const ME = { id: 'user-me', name: 'Zhu Yue', image: null };
const BO = { id: 'user-bo', name: 'Bo Philips', image: null };

let commentSeq = 0;
function comment(author: typeof ME, overrides: Partial<CommentDTO> = {}): CommentDTO {
  commentSeq += 1;
  return {
    id: `c-${commentSeq}`,
    workItemId: 'wi-1',
    parentCommentId: null,
    author,
    bodyMd: `Comment body ${commentSeq}`,
    editedAt: null,
    createdAt: new Date(Date.now() - commentSeq * 60_000).toISOString(),
    mentionedUserIds: [],
    ...overrides,
  };
}
function thread(author: typeof ME, replies: CommentDTO[] = []): CommentThreadDTO {
  return { ...comment(author), replies };
}
function page(
  threads: CommentThreadDTO[],
  overrides: Partial<CommentsPageDTO> = {},
): CommentsPageDTO {
  const total = threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
  return { threads, totalCount: total, nextCursor: null, order: 'desc', ...overrides };
}

function renderSection(
  initialPage: CommentsPageDTO | null,
  props: Partial<Parameters<typeof CommentsSection>[0]> = {},
) {
  return render(
    <CommentsSection
      workItemId="wi-1"
      canComment
      canModerate={false}
      currentUserId={ME.id}
      currentUserName={ME.name}
      mentionCandidates={[{ id: BO.id, name: BO.name, email: 'bophilips@motir.co' }]}
      initialPage={initialPage}
      {...props}
    />,
  );
}

beforeEach(() => {
  addCommentAction.mockReset();
  editCommentAction.mockReset();
  deleteCommentAction.mockReset();
  refresh.mockReset();
  window.localStorage.clear();
  resetCommentsSortForTests();
  vi.unstubAllGlobals();
});
afterEach(cleanup);

describe('CommentsSection (5.1.5)', () => {
  it('renders the thread with the count gloss, the disabled History seam, and the composer at rest', () => {
    renderSection(page([thread(BO), thread(ME)]));
    expect(screen.getByText('— 2 comments')).toBeTruthy();
    const history = screen.getByRole('button', { name: 'History' }) as HTMLButtonElement;
    expect(history.disabled).toBe(true);
    expect(history.title).toContain('Story 5.5');
    expect(screen.getByRole('button', { name: 'Add a comment…' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Comments' })).toBeTruthy();
  });

  it('renders the inviting empty state with the composer still live', () => {
    renderSection(page([]));
    expect(screen.getByText('No comments yet — start the conversation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a comment…' })).toBeTruthy();
  });

  it('viewer (read-only): thread visible, no composer, no row actions, the quiet notice', () => {
    renderSection(page([thread(BO)]), { canComment: false });
    expect(screen.getByRole('list', { name: 'Comments' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a comment…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(
      screen.getByText("Read-only access — you can view comments but can't add them."),
    ).toBeTruthy();
  });

  it("role matrix: a member sees Edit/Delete on their OWN comment only; a moderator on anyone's", () => {
    const { unmount } = renderSection(page([thread(BO), thread(ME)]));
    // Two rows: Bo's (other) → Reply only; mine → Reply · Edit · Delete.
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    unmount();

    renderSection(page([thread(BO), thread(ME)]), { canModerate: true });
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
  });

  it('shows the "Edited" tag only on edited comments', () => {
    renderSection(
      page([{ ...comment(BO, { editedAt: new Date().toISOString() }), replies: [] }, thread(ME)]),
    );
    expect(screen.getAllByText('· Edited')).toHaveLength(1);
  });

  it('posting a comment calls the action, appends the new root, and bumps the count', async () => {
    const created = comment(ME, { bodyMd: 'A fresh take' });
    addCommentAction.mockResolvedValue({ ok: true, comment: created });
    renderSection(page([thread(BO)]));

    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), {
      target: { value: 'A fresh take' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() =>
      expect(addCommentAction).toHaveBeenCalledWith({ workItemId: 'wi-1', bodyMd: 'A fresh take' }),
    );
    await waitFor(() => expect(screen.getByText('— 2 comments')).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });

  it('the Comment button stays disabled while the body is empty', () => {
    renderSection(page([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('a failed post renders the action error inline and keeps the draft', async () => {
    addCommentAction.mockResolvedValue({ ok: false, error: 'You don’t have permission.' });
    renderSection(page([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('permission'));
    expect(
      (screen.getByRole('textbox', { name: 'Add a comment' }) as HTMLTextAreaElement).value,
    ).toBe('draft');
  });

  it('Reply opens the thread composer pre-mentioning the author and posts to the root', async () => {
    const root = thread(BO);
    const reply = comment(ME, { parentCommentId: root.id });
    addCommentAction.mockResolvedValue({ ok: true, comment: reply });
    renderSection(page([root]));

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Write a reply' }) as HTMLTextAreaElement;
    expect(box.value).toBe(`[@${BO.name}](mention:${BO.id}) `);
    fireEvent.change(box, { target: { value: 'On it' } });
    // Two "Reply" buttons now: the row action and the composer submit (last).
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1)!);

    await waitFor(() =>
      expect(addCommentAction).toHaveBeenCalledWith({
        workItemId: 'wi-1',
        bodyMd: 'On it',
        parentCommentId: root.id,
      }),
    );
  });

  it('collapses long threads behind "Show more replies" and expands on click', () => {
    const replies = [comment(BO), comment(ME), comment(BO), comment(ME), comment(BO)].map(
      (reply, index) => ({ ...reply, bodyMd: `Reply ${index + 1}` }),
    );
    renderSection(page([thread(BO, replies)]));

    // Collapsed: only the newest reply visible, the rest behind the button.
    expect(screen.getByText('Reply 5')).toBeTruthy();
    expect(screen.queryByText('Reply 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more replies' }));
    expect(screen.getByText('Reply 1')).toBeTruthy();
  });

  it('delete confirm names the reply count on a root and removes the thread on confirm', async () => {
    deleteCommentAction.mockResolvedValue({ ok: true });
    const root = thread(ME, [comment(BO), comment(BO)]);
    renderSection(page([root]));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(
      screen.getByText("Delete this comment? Also deletes 2 replies — comments can't be restored."),
    ).toBeTruthy();
    const dialogDelete = screen
      .getAllByRole('button', { name: 'Delete' })
      .at(-1) as HTMLButtonElement;
    fireEvent.click(dialogDelete);

    await waitFor(() => expect(deleteCommentAction).toHaveBeenCalledWith({ commentId: root.id }));
    await waitFor(() => expect(screen.getByText('— 0 comments')).toBeTruthy());
  });

  it('edit-in-place saves through the action and swaps the row body', async () => {
    const mine = thread(ME);
    const updated = { ...mine, bodyMd: 'Re-worded', editedAt: new Date().toISOString() };
    editCommentAction.mockResolvedValue({ ok: true, comment: updated });
    renderSection(page([mine]));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(box.value).toBe(mine.bodyMd);
    fireEvent.change(box, { target: { value: 'Re-worded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(editCommentAction).toHaveBeenCalledWith({ commentId: mine.id, bodyMd: 'Re-worded' }),
    );
    await waitFor(() => expect(screen.getByText('· Edited')).toBeTruthy());
  });

  it('"Show more comments (N older)" fetches the next cursor page and appends it', async () => {
    const olderThread = thread(BO);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(page([olderThread], { totalCount: 22, nextCursor: null })),
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = Array.from({ length: 20 }, () => thread(ME));
    renderSection(page(first, { totalCount: 22, nextCursor: first.at(-1)!.id }));

    const showMore = screen.getByRole('button', { name: 'Show more comments (2 older)' });
    fireEvent.click(showMore);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/work-items/wi-1/comments?order=desc&cursor=${first.at(-1)!.id}`,
      ),
    );
    // The pager disappears once the window holds the whole set.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Show more comments/ })).toBeNull(),
    );
  });

  it('sort toggle flips the displayed order without refetching and persists the choice', () => {
    const older = { ...thread(BO), bodyMd: 'older root' };
    const newer = { ...thread(ME), bodyMd: 'newer root' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The window is held newest-first; oldest-first display reverses it.
    renderSection(page([newer, older]));

    const list = screen.getByRole('list', { name: 'Comments' });
    const textsBefore = within(list)
      .getAllByText(/root$/)
      .map((node) => node.textContent);
    expect(textsBefore).toEqual(['older root', 'newer root']);

    fireEvent.click(screen.getByRole('button', { name: 'Sort comments, oldest first' }));
    const textsAfter = within(list)
      .getAllByText(/root$/)
      .map((node) => node.textContent);
    expect(textsAfter).toEqual(['newer root', 'older root']);
    expect(window.localStorage.getItem('motir.issues.comments.sort')).toBe('desc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed server read renders ErrorState and retry refetches page 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(page([thread(BO)])),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSection(null);

    expect(screen.getByText("Couldn't load comments")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/work-items/wi-1/comments?order=desc'),
    );
    await waitFor(() => expect(screen.getByText('— 1 comment')).toBeTruthy());
  });
});
