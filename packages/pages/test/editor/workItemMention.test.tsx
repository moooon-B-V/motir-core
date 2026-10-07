// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import type {
  AvailableWorkItemRefView,
  WorkItemCandidate,
  WorkItemRefView,
} from '../../src/editor/workItemMention';
import { MENTION_SEARCH_DEBOUNCE_MS } from '../../src/editor/workItemMention';
import { applyUpdate, stateToMarkdown } from '../../src';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// Mention a work item in the page editor (MOTIR-7574), against
// `design/pages/page--work-item-mention.mock.html`: the two doors (the toolbar's
// Work item button and `@`), every state of the picker (panel 3), the insert, and
// the chip's states (panels 4–5) — on a real Tiptap editor bound to a real Yjs
// doc, with the host's renderers injected as the props the app passes.

const CANDIDATES: WorkItemCandidate[] = [
  {
    id: 'ck805',
    identifier: 'MOTIR-805',
    title: 'Issue-tree generation',
    kind: 'story',
    status: { label: 'In Progress', category: 'in_progress' },
  },
  {
    id: 'ck1404',
    identifier: 'MOTIR-1404',
    title: 'Render — live chip',
    kind: 'subtask',
    status: { label: 'To Do', category: 'todo' },
  },
  {
    id: 'ck742',
    identifier: 'MOTIR-742',
    title: 'Issue list facet drift',
    kind: 'bug',
    status: null,
  },
];

const REFS: Record<string, WorkItemRefView> = {
  ckLive: {
    accessible: true,
    id: 'ckLive',
    identifier: 'MOTIR-1188',
    title: 'Page export to Markdown',
    kind: 'task',
    archived: false,
    status: { key: 'in_review', label: 'In Review', category: 'in_progress' },
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

const BODY =
  'See [](motir:ckLive), [](motir:ckOld), [](motir:ckHidden) and [](motir:ckGone).\n\n```sh\ncode\n```\n';

/** The host's chip, as a test double that shows what it was handed. */
const chip = (view: AvailableWorkItemRefView) => (
  <span data-testid="chip" data-id={view.id}>
    {[view.identifier, view.title, view.status?.label ?? '-', view.archived ? 'archived' : 'live']
      .filter(Boolean)
      .join(' | ')}
  </span>
);
const row = (candidate: WorkItemCandidate, active: boolean) => (
  <span data-active={active}>{candidate.identifier}</span>
);

interface Pending {
  query: string;
  resolve: (items: WorkItemCandidate[]) => void;
  reject: (err: unknown) => void;
}

async function mount(overrides: Partial<PageEditorProps> = {}) {
  const pending: Pending[] = [];
  const searchWorkItems = vi.fn(
    (query: string) =>
      new Promise<WorkItemCandidate[]>((resolve, reject) =>
        pending.push({ query, resolve, reject }),
      ),
  );
  const saveUpdate = vi.fn(async () => ({ revision: 2 }));
  const onOpenWorkItem = vi.fn();
  const initialState = stateFromMarkdown(BODY);
  const utils = render(
    <PageEditor
      initialState={initialState}
      editable
      saveUpdate={saveUpdate}
      uploadImage={vi.fn()}
      messages={MESSAGES}
      theme="light"
      searchWorkItems={searchWorkItems}
      workItemRefs={REFS}
      renderWorkItemChip={chip}
      renderPickerRow={row}
      onOpenWorkItem={onOpenWorkItem}
      {...overrides}
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  /** Flush the suggestion plugin's async view update. */
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  /** Type at the end of the first paragraph, as keystrokes would. */
  const type = async (text: string) => {
    act(() => {
      const end = editor.state.doc.child(0).nodeSize - 1;
      editor.chain().focus().setTextSelection(end).insertContent(text).run();
    });
    await flush();
  };
  const key = async (name: string) => {
    act(() => {
      fireEvent.keyDown(surface, { key: name });
    });
    await flush();
  };
  const debounce = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_SEARCH_DEBOUNCE_MS);
    });
  const answer = (items: WorkItemCandidate[] | Error) =>
    act(async () => {
      const next = pending.shift()!;
      if (items instanceof Error) next.reject(items);
      else next.resolve(items);
      await vi.advanceTimersByTimeAsync(0);
    });
  const picker = () => screen.queryByRole('listbox', { name: 'Mention a work item' });
  // The chips are React node views, which Tiptap mounts a microtask after the
  // editor renders.
  await flush();
  return {
    ...utils,
    initialState,
    surface,
    editor,
    searchWorkItems,
    saveUpdate,
    onOpenWorkItem,
    pending,
    flush,
    type,
    key,
    debounce,
    answer,
    picker,
  };
}

/** Every mention node in the document, in order. */
function mentions(editor: Editor): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'workItemMention') found.push({ ...node.attrs });
  });
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the toolbar door', () => {
  it('draws Work item after Insert image and Insert table, with its label and tooltip', async () => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const labels = within(toolbar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(-3)).toEqual(['Insert image', 'Insert table', 'Mention a work item']);
    const button = within(toolbar).getByRole('button', { name: 'Mention a work item' });
    expect(button.textContent).toBe('Work item');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('title')).toBe('Mention a work item — or type @ in the text');
  });

  it('writes an @ at the caret and opens the same picker, asking for more', async () => {
    const h = await mount();
    act(() => {
      h.editor.commands.setTextSelection(4); // after "See"
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mention a work item' }));
    await h.flush();
    // After a word the @ takes a space, so the suggestion can open.
    expect(h.editor.state.doc.child(0).textContent.startsWith('See @')).toBe(true);
    const picker = h.picker()!;
    expect(within(picker).getByText('Work items')).toBeTruthy();
    expect(within(picker).getByText('Keep typing to search work items…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mention a work item' }).ariaExpanded).toBe('true');
    expect(h.searchWorkItems).not.toHaveBeenCalled();
  });

  it('writes a bare @ at the start of a block or after a space', async () => {
    const h = await mount();
    act(() => {
      h.editor.commands.setTextSelection(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mention a work item' }));
    await h.flush();
    expect(h.editor.state.doc.child(0).textContent.startsWith('@See')).toBe(true);
    expect(h.picker()).not.toBeNull();
  });

  it('is disabled in a code block, saying why, and @ there opens nothing', async () => {
    const h = await mount();
    let codeEnd = 0;
    h.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') codeEnd = pos + node.nodeSize - 1;
    });
    act(() => {
      h.editor.chain().focus().setTextSelection(codeEnd).insertContent(' @ab').run();
    });
    await h.flush();
    const button = screen.getByRole('button', { name: 'Mention a work item' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Work items can’t be mentioned inside a code block');
    expect(h.picker()).toBeNull();
  });
});

describe('the picker — every state', () => {
  it('loads after two characters, then lists the results with the first row active', async () => {
    const h = await mount();
    await h.type(' @a');
    expect(within(h.picker()!).getByText('Keep typing to search work items…')).toBeTruthy();
    await h.type('b');
    const loading = within(h.picker()!).getByRole('status');
    expect(loading.textContent).toBe('Searching…');
    expect(h.searchWorkItems).not.toHaveBeenCalled();
    await h.debounce();
    expect(h.searchWorkItems).toHaveBeenCalledWith('ab');
    await h.answer(CANDIDATES);
    const options = within(h.picker()!).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['MOTIR-805', 'MOTIR-1404', 'MOTIR-742']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(h.picker()!.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    // The row content is the host's, told which row is active.
    expect(options[0]!.querySelector('[data-active="true"]')).not.toBeNull();
  });

  it('says so when nothing matches', async () => {
    const h = await mount();
    await h.type(' @zzqq');
    await h.debounce();
    await h.answer([]);
    expect(within(h.picker()!).getByText('No work items match “zzqq”.')).toBeTruthy();
    expect(within(h.picker()!).queryAllByRole('option')).toHaveLength(0);
    // Enter with nothing to pick is still the picker's.
    await h.key('Enter');
    expect(mentions(h.editor)).toHaveLength(4);
  });

  it('shows a failed search, and Try again retries — by Enter and by click', async () => {
    const h = await mount();
    await h.type(' @ab');
    await h.debounce();
    await h.answer(new Error('offline'));
    const picker = h.picker()!;
    expect(within(picker).getByRole('alert').textContent).toBe('Couldn’t search work items.');
    const retry = within(picker).getByRole('option', { name: 'Try again' });
    expect(retry.getAttribute('aria-selected')).toBe('true');
    expect(picker.getAttribute('aria-activedescendant')).toBe(retry.id);
    // The arrows have nowhere to go; the one option stays active.
    await h.key('ArrowDown');
    expect(within(h.picker()!).getByRole('option', { name: 'Try again' })).toBeTruthy();

    await h.key('Enter');
    expect(within(h.picker()!).getByRole('status').textContent).toBe('Searching…');
    await h.debounce();
    expect(h.searchWorkItems).toHaveBeenCalledTimes(2);
    await h.answer(new Error('still offline'));

    fireEvent.mouseDown(within(h.picker()!).getByRole('option', { name: 'Try again' }));
    await h.debounce();
    expect(h.searchWorkItems).toHaveBeenCalledTimes(3);
    await h.answer(CANDIDATES);
    expect(within(h.picker()!).getAllByRole('option')).toHaveLength(3);
  });

  it('ignores an answer that arrives after the query moved on', async () => {
    const h = await mount();
    await h.type(' @ab');
    await h.debounce();
    await h.type('c');
    // The old request settles late; the picker is still loading the new one.
    await h.answer(CANDIDATES);
    expect(within(h.picker()!).getByRole('status')).toBeTruthy();
    await h.debounce();
    expect(h.pending[0]!.query).toBe('abc');
  });

  it('moves the active row with the arrows, wrapping, and Enter inserts it', async () => {
    const h = await mount();
    await h.type(' @is');
    await h.debounce();
    await h.answer(CANDIDATES);
    const selected = () =>
      within(h.picker()!)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-selected') === 'true');
    await h.key('ArrowDown');
    await h.key('ArrowDown');
    expect(selected()).toEqual([false, false, true]);
    await h.key('ArrowDown');
    expect(selected()).toEqual([true, false, false]);
    await h.key('ArrowUp');
    expect(selected()).toEqual([false, false, true]);
    // A key the picker does not use goes to the editor.
    await h.key('a');
    await h.key('Enter');

    expect(h.picker()).toBeNull();
    // The node stores the id ONLY, and the @query is gone.
    expect(mentions(h.editor).at(-1)).toEqual({ id: 'ck742', label: null });
    expect(h.editor.state.doc.child(0).textContent).not.toContain('@is');
    // The new chip draws from the picked candidate (no status → no dot).
    const chips = screen.getAllByTestId('chip');
    expect(chips.at(-1)!.textContent).toBe('MOTIR-742 | Issue list facet drift | - | live');
  });

  it('picks with the mouse, and the chip shows the key, title and status', async () => {
    const h = await mount();
    await h.type(' @is');
    await h.debounce();
    await h.answer(CANDIDATES);
    const options = within(h.picker()!).getAllByRole('option');
    fireEvent.mouseEnter(options[1]!);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    act(() => {
      fireEvent.mouseDown(options[1]!);
    });
    await h.flush();
    expect(h.picker()).toBeNull();
    expect(mentions(h.editor).at(-1)).toEqual({ id: 'ck1404', label: null });
    const chips = screen.getAllByTestId('chip');
    expect(chips.at(-1)!.textContent).toBe('MOTIR-1404 | Render — live chip | To Do | live');
  });

  it('is persisted by the ordinary autosave, as an id-only token', async () => {
    const h = await mount();
    await h.type(' @is');
    await h.debounce();
    await h.answer(CANDIDATES);
    await h.key('Enter');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    const saved = (h.saveUpdate.mock.calls[0] as unknown as [Uint8Array])[0];
    const markdown = stateToMarkdown(applyUpdate(h.initialState, saved));
    expect(markdown).toContain('[](motir:ck805)');
    expect(markdown).not.toContain('MOTIR-805');
  });

  it('closes on Escape, leaving the typed text', async () => {
    const h = await mount();
    await h.type(' @ab');
    expect(h.picker()).not.toBeNull();
    await h.key('Escape');
    expect(h.picker()).toBeNull();
    expect(h.editor.state.doc.child(0).textContent).toContain('@ab');
  });

  it('positions itself under the caret when the caret can be measured', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return (
        this.classList.contains('suggestion')
          ? { left: 40, bottom: 20, top: 0 }
          : { left: 0, bottom: 0, top: 0 }
      ) as DOMRect;
    });
    const h = await mount();
    await h.type(' @ab');
    const frame = h.picker()!.parentElement!;
    expect(frame.style.left).toBe('40px');
    expect(frame.style.top).toBe('24px');
    rect.mockRestore();
  });

  it('still opens, unplaced, when the caret cannot be measured', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('suggestion')) throw new Error('no layout');
      return { left: 0, bottom: 0, top: 0 } as DOMRect;
    });
    const h = await mount();
    await h.type(' @ab');
    expect(h.picker()!.parentElement!.style.left).toBe('');
    rect.mockRestore();
  });

  it('draws key and title rows and chips when the host passes no renderers', async () => {
    const h = await mount({ renderPickerRow: undefined, renderWorkItemChip: undefined });
    const live = h.surface.querySelector('[data-work-item-id="ckLive"] .wi-chip')!;
    expect(live.className).toBe('wi-chip');
    expect(live.textContent).toBe('MOTIR-1188Page export to Markdown');
    expect(h.surface.querySelector('[data-work-item-id="ckOld"] .wi-chip')!.className).toBe(
      'wi-chip is-archived',
    );
    await h.type(' @is');
    await h.debounce();
    await h.answer(CANDIDATES);
    expect(within(h.picker()!).getAllByRole('option')[0]!.textContent).toBe(
      'MOTIR-805Issue-tree generation',
    );
  });
});

describe('the chip', () => {
  it('draws the live and archived summaries through the host, and the unavailable chip itself', async () => {
    const h = await mount();
    const view = (id: string) => h.surface.querySelector(`[data-work-item-id="${id}"]`)!;
    expect(view('ckLive').textContent).toBe(
      'MOTIR-1188 | Page export to Markdown | In Review | live',
    );
    expect(view('ckOld').textContent).toBe('MOTIR-919 | Old outline approach | - | archived');
    // Hidden and deleted are drawn the same: neither key nor title.
    for (const id of ['ckHidden', 'ckGone']) {
      const unavailable = view(id).querySelector('.wi-chip')!;
      expect(unavailable.className).toBe('wi-chip is-unavailable');
      expect(unavailable.textContent).toBe('Unavailable work item');
      expect(unavailable.getAttribute('title')).toBe(
        'This work item was deleted, or you can’t see it.',
      );
    }
  });

  it('selects in the editor on click, never following the chip', async () => {
    const followed = vi.fn();
    const h = await mount({
      renderWorkItemChip: (v) => (
        <a href={`/items/${v.identifier}`} onClick={followed} data-testid="link">
          {v.identifier}
        </a>
      ),
    });
    const link = screen.getAllByTestId('link')[0]!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(followed).not.toHaveBeenCalled();
    expect(h.onOpenWorkItem).not.toHaveBeenCalled();
  });

  describe('in the read-only page', () => {
    it('has no toolbar, and @ is a plain character', async () => {
      const h = await mount({ editable: false });
      expect(screen.queryByRole('toolbar')).toBeNull();
      act(() => {
        const end = h.editor.state.doc.child(0).nodeSize - 1;
        h.editor.chain().setTextSelection(end).insertContent(' @ab').run();
      });
      await h.flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MENTION_SEARCH_DEBOUNCE_MS);
      });
      expect(h.picker()).toBeNull();
      expect(h.searchWorkItems).not.toHaveBeenCalled();
    });

    it('opens a live chip on a plain click, and leaves the rest alone', async () => {
      const h = await mount({ editable: false });
      const chipOf = (id: string) => h.surface.querySelector(`[data-work-item-id="${id}"]`)!;
      fireEvent.click(chipOf('ckLive').firstElementChild!);
      expect(h.onOpenWorkItem).toHaveBeenCalledWith('ckLive');
      fireEvent.click(chipOf('ckLive').firstElementChild!, { metaKey: true });
      fireEvent.click(chipOf('ckLive').firstElementChild!, { button: 1 });
      fireEvent.click(chipOf('ckGone').firstElementChild!);
      fireEvent.click(chipOf('ckHidden').firstElementChild!);
      expect(h.onOpenWorkItem).toHaveBeenCalledTimes(1);
    });

    it('lets a chip that opens the item itself do so, once', async () => {
      const h = await mount({
        editable: false,
        renderWorkItemChip: (v) => (
          <a href={`/items/${v.identifier}`} onClick={(e) => e.preventDefault()}>
            {v.identifier}
          </a>
        ),
      });
      fireEvent.click(h.surface.querySelector('[data-work-item-id="ckLive"] a')!);
      expect(h.onOpenWorkItem).not.toHaveBeenCalled();
    });

    it('draws without a search wired, and without an open handler', async () => {
      const h = await mount({
        editable: false,
        searchWorkItems: undefined,
        onOpenWorkItem: undefined,
      });
      fireEvent.click(h.surface.querySelector('[data-work-item-id="ckLive"]')!.firstElementChild!);
      expect(screen.getAllByTestId('chip')).toHaveLength(2);
    });
  });

  it('draws every mention unavailable when the host passes no summaries', async () => {
    const h = await mount({ workItemRefs: undefined });
    expect(h.surface.querySelectorAll('.wi-chip.is-unavailable')).toHaveLength(4);
  });
});
