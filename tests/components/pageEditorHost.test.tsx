// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  PageEditorHost,
  openWorkItemPeek,
  renderPageWorkItemChip,
} from '@/components/pages/PageEditorHost';
import { applyUpdate, emptyState, markdownToUpdate } from '@/lib/pages';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The page editor host's MENTION binding (Story MOTIR-5747 · MOTIR-7574): the
// real `<PageEditor>` behind the real host, under the real en catalogue, with
// only `fetch` stubbed. It holds what the host owes the package — the search
// narrowed to the page's project, `PageDto.workItemRefs` as the chips' data, the
// shipped `motir:` chip and `MentionList` row as the renderers, and the copy.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/pages/page-1',
}));

/** A page body mentioning three items, as the editor stores it (id only). */
function bodyState(markdown: string): string {
  const empty = emptyState();
  return Buffer.from(applyUpdate(empty, markdownToUpdate(empty, markdown))).toString('base64');
}
const BODY = bodyState('See [](motir:ckLive), [](motir:ckOld) and [](motir:ckHidden).\n');

const REFS: WorkItemRefMap = {
  ckLive: {
    accessible: true,
    id: 'ckLive',
    identifier: 'MOTIR-1188',
    title: 'Page export to Markdown',
    kind: 'task',
    archived: false,
    status: { key: 'done', label: 'Done', category: 'done' },
  },
  ckOld: {
    accessible: true,
    id: 'ckOld',
    identifier: 'MOTIR-919',
    title: 'Old outline approach',
    kind: 'task',
    archived: true,
    status: null,
  },
  ckHidden: { accessible: false, id: 'ckHidden' },
};

const ROW = {
  id: 'ck805',
  parentId: null,
  kind: 'story',
  key: 805,
  identifier: 'MOTIR-805',
  title: 'Issue-tree generation',
  status: 'in_progress',
  priority: 'medium',
  assigneeId: null,
  position: 'a0',
  estimateMinutes: null,
  storyPoints: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  archivedAt: null,
};

const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function mount(
  props: Partial<Parameters<typeof PageEditorHost>[0]> = {},
  messages?: Record<string, unknown>,
) {
  const utils = renderWithIntl(
    <PageEditorHost
      pageId="page-1"
      bodyState={BODY}
      canEdit
      projectId="proj-1"
      workItemRefs={REFS}
      {...props}
    />,
    messages ? { locale: 'zh', messages } : {},
  );
  const surface = await screen.findByRole('textbox');
  await act(async () => {});
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  return { ...utils, surface, editor };
}

/** Type `text` at the end of the first paragraph and let the suggestion open. */
async function type(editor: Editor, text: string) {
  act(() => {
    editor
      .chain()
      .focus()
      .setTextSelection(editor.state.doc.child(0).nodeSize - 1)
      .insertContent(text)
      .run();
  });
  await act(async () => {});
}

/** Wait out the picker's debounce and the answer. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/pages/page-1');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the chips read PageDto.workItemRefs', () => {
  it('draws the shipped chip for a live and an archived item, and hides a no-access one', async () => {
    const { surface } = await mount({ canEdit: false });
    const live = surface.querySelector('[data-work-item-id="ckLive"] a.wi-chip')!;
    expect(live.getAttribute('href')).toBe('/items/MOTIR-1188');
    expect(live.textContent).toBe('MOTIR-1188Page export to Markdown');
    expect(live.querySelector('.wi-dot.s-done')).not.toBeNull();
    expect(
      surface.querySelector('[data-work-item-id="ckOld"] .wi-chip.is-archived'),
    ).not.toBeNull();
    const hidden = surface.querySelector('[data-work-item-id="ckHidden"]')!;
    expect(hidden.textContent).toBe('Unavailable work item');
    expect(hidden.textContent).not.toContain('MOTIR');
    expect(hidden.querySelector('.wi-chip')!.getAttribute('title')).toBe(
      'This work item was deleted, or you can’t see it.',
    );
  });

  it('draws every chip unavailable when no refs are passed', async () => {
    const { surface } = await mount({ canEdit: false, workItemRefs: undefined });
    expect(surface.querySelectorAll('.wi-chip.is-unavailable')).toHaveLength(3);
  });

  it('opens the peek for a click the chip itself did not take', async () => {
    const { surface } = await mount({ canEdit: false });
    // The shipped chip opens the peek itself.
    fireEvent.click(surface.querySelector('[data-work-item-id="ckLive"] a.wi-chip')!);
    expect(window.location.search).toBe('?peek=MOTIR-1188');
    window.history.replaceState(null, '', '/pages/page-1?view=x');
    // A click on the chip's frame, outside the link, opens it through the host.
    fireEvent.click(surface.querySelector('[data-work-item-id="ckLive"]')!);
    expect(window.location.search).toBe('?view=x&peek=MOTIR-1188');
  });

  it('writes the peek param over whatever is there', () => {
    window.history.replaceState(null, '', '/pages/page-1?peek=OLD-1');
    openWorkItemPeek('MOTIR-2');
    expect(window.location.search).toBe('?peek=MOTIR-2');
  });

  it('titles a chip with its title alone when it has no status', () => {
    const chip = renderPageWorkItemChip({
      accessible: true,
      id: 'ck1',
      identifier: 'MOTIR-1',
      title: 'No status',
      kind: 'task',
      archived: false,
      status: null,
    });
    expect((chip as { props: { content: string } }).props.content).toBe('No status');
    const withStatus = renderPageWorkItemChip({
      accessible: true,
      id: 'ck2',
      identifier: 'MOTIR-2',
      title: 'Has status',
      kind: 'task',
      archived: false,
      status: { label: 'To Do', category: 'todo' },
    });
    expect((withStatus as { props: { content: string } }).props.content).toBe('Has status · To Do');
  });
});

describe('the picker searches the page’s project', () => {
  it('passes projectId to the mention search and draws MentionList’s row', async () => {
    const { editor } = await mount();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json([ROW]));
    await type(editor, ' @is');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/api/work-items/mention-search?q=is&projectId=proj-1',
    );
    const picker = screen.getByRole('listbox', { name: 'Mention a work item' });
    const option = within(picker).getByRole('option');
    expect(option.textContent).toContain('MOTIR-805');
    expect(option.textContent).toContain('Issue-tree generation');
    expect(option.textContent).toContain('In Progress');

    fireEvent.mouseDown(option);
    await act(async () => {});
    // The chip inserted this session draws from the picked row, with its status dot.
    const inserted = document.querySelector('[data-work-item-id="ck805"] a.wi-chip')!;
    expect(inserted.textContent).toBe('MOTIR-805Issue-tree generation');
    expect(inserted.querySelector('.wi-dot.s-inprogress')).not.toBeNull();
  });

  it('says the search failed when the route refuses it, and retries', async () => {
    const { editor } = await mount();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ code: 'INTERNAL' }, 500));
    await type(editor, ' @is');
    await settle();
    const picker = screen.getByRole('listbox', { name: 'Mention a work item' });
    expect(within(picker).getByRole('alert').textContent).toBe('Couldn’t search work items.');
    fetchMock.mockResolvedValueOnce(json([]));
    fireEvent.mouseDown(within(picker).getByRole('option', { name: 'Try again' }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No work items match “is”.')).toBeTruthy();
  });

  it('offers the toolbar door, in zh too', async () => {
    await mount({}, zhMessages);
    const button = screen.getByRole('button', { name: '提及工作项' });
    expect(button.textContent).toBe('工作项');
    expect(button.getAttribute('title')).toBe('提及工作项 — 或在正文中输入 @');
  });

  it('offers no door without a project, and none on a read-only page', async () => {
    await mount({ projectId: undefined });
    expect(screen.queryByRole('button', { name: 'Mention a work item' })).toBeNull();
    cleanup();
    await mount({ canEdit: false });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
