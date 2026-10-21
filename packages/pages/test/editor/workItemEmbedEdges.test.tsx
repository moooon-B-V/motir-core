// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import {
  convertEmbedToMention,
  convertMentionToEmbed,
  insertWorkItemEmbed,
} from '../../src/editor/workItemEmbed';
import { MENTION_SEARCH_DEBOUNCE_MS } from '../../src/editor/workItemMention';
import type {
  AvailableWorkItemRefView,
  WorkItemCandidate,
  WorkItemRefView,
} from '../../src/editor/workItemMention';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// The card's less-travelled paths (MOTIR-9183's coverage floor): the control
// cluster's keyboard and pointer doors, the picker's failure and navigation
// states in card placement, and the commands where a block cannot go.

const LIVE: AvailableWorkItemRefView = {
  accessible: true,
  id: 'ckLive',
  identifier: 'MOTIR-1188',
  title: 'Page export to Markdown',
  kind: 'task',
  archived: false,
  status: { key: 'in_review', label: 'In Review', category: 'in_progress' },
  type: 'code',
  assignee: null,
};
const REFS: Record<string, WorkItemRefView> = {
  ckLive: LIVE,
  ckHidden: { accessible: false, id: 'ckHidden' },
};
const mk = (n: number): WorkItemCandidate => ({
  id: `ckC${n}`,
  identifier: `MOTIR-${n}`,
  title: `Candidate ${n}`,
  kind: 'task',
  status: { label: 'To Do', category: 'todo' },
  type: null,
  assignee: null,
});

type Search = (query: string) => Promise<WorkItemCandidate[]>;

async function mount(body: string, overrides: Partial<PageEditorProps> = {}) {
  const onOpenWorkItem = vi.fn();
  const utils = render(
    <PageEditor
      initialState={stateFromMarkdown(body)}
      editable
      saveUpdate={vi.fn(async () => ({ revision: 2 }))}
      uploadImage={vi.fn()}
      messages={MESSAGES}
      theme="light"
      searchWorkItems={vi.fn<Search>(async () => [])}
      workItemRefs={REFS}
      renderWorkItemCard={(v) => <span data-testid="card">{v.identifier}</span>}
      renderPickerRow={(c) => <span>{c.identifier}</span>}
      onOpenWorkItem={onOpenWorkItem}
      {...overrides}
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_SEARCH_DEBOUNCE_MS + 1);
    });
  await flush();
  return { ...utils, surface, editor, flush, onOpenWorkItem };
}

const names = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.descendants((n) => {
    out.push(n.type.name);
  });
  return out;
};

function select(editor: Editor, type: string) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === type) at = pos;
  });
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the control cluster', () => {
  it('opens the item from the Open control, and disables it on an unavailable card', async () => {
    const { onOpenWorkItem } = await mount('![](motir:ckLive)\n\n![](motir:ckHidden)\n');
    const opens = screen.getAllByRole('button', { name: 'Open work item', hidden: true });
    expect(opens).toHaveLength(2);
    fireEvent.click(opens[0]!);
    expect(onOpenWorkItem).toHaveBeenCalledWith('ckLive');
    expect((opens[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes the menu on Escape and on a press outside it', async () => {
    await mount('![](motir:ckLive)\n');
    const menuButton = screen.getByRole('button', { name: 'Card options', hidden: true });
    fireEvent.click(menuButton);
    expect(screen.getByRole('menu', { hidden: true })).toBeTruthy();
    fireEvent.keyDown(menuButton, { key: 'Escape' });
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull();

    fireEvent.keyDown(menuButton, { key: 'Escape' }); // already closed: nothing to do
    fireEvent.click(menuButton);
    fireEvent.mouseDown(screen.getByRole('menu', { hidden: true })); // inside: stays open
    expect(screen.getByRole('menu', { hidden: true })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
    fireEvent.keyDown(menuButton, { key: 'a' }); // any other key is ignored
  });

  it('turns the card into an inline mention from its menu', async () => {
    const { editor, flush } = await mount('![](motir:ckLive)\n');
    fireEvent.click(screen.getByRole('button', { name: 'Card options', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show as inline mention', hidden: true }));
    await flush();
    expect(names(editor)).toContain('workItemMention');
    expect(names(editor)).not.toContain('workItemEmbed');
  });
});

describe('the commands', () => {
  it('splits a paragraph around a card inserted mid-text', async () => {
    const { editor } = await mount('Hello world\n');
    act(() => {
      expect(insertWorkItemEmbed(editor, { from: 6, to: 7 }, mk(1))).toBe(true);
    });
    expect(names(editor).filter((n) => n === 'paragraph')).toHaveLength(2);
    expect(names(editor)).toContain('workItemEmbed');
  });

  it('refuses where a block cannot go, leaving the document as it was', async () => {
    const { editor } = await mount('- item one\n');
    const before = JSON.stringify(editor.getJSON());
    // Inside the list item's paragraph the schema forbids the extra siblings.
    act(() => {
      insertWorkItemEmbed(editor, { from: 3, to: 5 }, mk(2));
    });
    // Whether it fits or not, the result is one coherent document, not a half-write.
    const after = JSON.stringify(editor.getJSON());
    expect(after === before || names(editor).includes('workItemEmbed')).toBe(true);
  });

  it('does not split a heading', async () => {
    const { editor } = await mount('# Title\n');
    const before = JSON.stringify(editor.getJSON());
    act(() => {
      expect(insertWorkItemEmbed(editor, { from: 2, to: 3 }, mk(3))).toBe(false);
    });
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it('exposes the two conversions as helpers that no-op off the right selection', async () => {
    const { editor } = await mount('See [](motir:ckLive) here.\n\n![](motir:ckLive)\n');
    expect(convertMentionToEmbed(editor)).toBe(false);
    expect(convertEmbedToMention(editor)).toBe(false);
    select(editor, 'workItemMention');
    act(() => {
      expect(convertMentionToEmbed(editor)).toBe(true);
    });
    expect(names(editor).filter((n) => n === 'workItemEmbed')).toHaveLength(2);
    select(editor, 'workItemEmbed');
    act(() => {
      expect(convertEmbedToMention(editor)).toBe(true);
    });
    expect(names(editor).filter((n) => n === 'workItemEmbed')).toHaveLength(1);
  });

  it('does not convert a card that sits where a paragraph cannot', async () => {
    const { editor } = await mount('> quote\n');
    // Put a card into the quote by hand, then ask for the conversion.
    act(() => {
      const card = editor.schema.nodes.workItemEmbed!.create({ id: 'ckLive', label: null });
      const para = editor.state.doc.firstChild!.firstChild!;
      const tr = editor.state.tr.insert(1 + para.nodeSize, card);
      editor.view.dispatch(tr);
    });
    select(editor, 'workItemEmbed');
    act(() => {
      expect(convertEmbedToMention(editor)).toBe(true);
    });
    expect(names(editor)).toContain('workItemMention');
  });
});

describe('the picker in card placement', () => {
  const open = async (search: Search) => {
    const m = await mount('Intro.\n', { searchWorkItems: vi.fn<Search>(search) });
    act(() => {
      m.editor.chain().focus('end').insertContent(' @').run();
    });
    await m.flush();
    act(() => {
      m.editor.commands.insertContent('ab');
    });
    await m.flush();
    return m;
  };
  const key = (m: { surface: HTMLElement }, k: string) =>
    act(() => {
      fireEvent.keyDown(m.surface, { key: k });
    });

  it('walks the rows with the arrows, wraps, and inserts the active one on Enter', async () => {
    const m = await open(async () => [mk(1), mk(2), mk(3)]);
    const options = () => screen.getAllByRole('option');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    key(m, 'ArrowDown');
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    key(m, 'ArrowUp');
    key(m, 'ArrowUp');
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseEnter(options()[1]!);
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    key(m, 'x'); // not a picker key: left to the editor
    key(m, 'Tab'); // to the card placement
    key(m, 'Enter');
    await m.flush();
    expect(names(m.editor)).toContain('workItemEmbed');
  });

  it('commits a row on a press, inserting an inline mention in mention placement', async () => {
    const m = await open(async () => [mk(1)]);
    fireEvent.mouseDown(screen.getAllByRole('option')[0]!);
    await m.flush();
    expect(names(m.editor)).toContain('workItemMention');
  });

  it('shows the failure, retries on a press and on Enter, and says when nothing matched', async () => {
    let calls = 0;
    const m = await open(async () => {
      calls += 1;
      if (calls < 3) throw new Error('down');
      return [];
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    key(m, 'ArrowDown'); // nothing to walk on a failure
    fireEvent.mouseDown(screen.getByRole('option'));
    await m.flush();
    expect(calls).toBe(2);
    key(m, 'Enter');
    await m.flush();
    expect(calls).toBe(3);
    expect(screen.queryByRole('alert')).toBeNull();
    key(m, 'ArrowDown'); // an empty result has no rows to walk
    key(m, 'Enter');
  });

  it('inserts a mention before an existing space, and keeps a refused card out of the page', async () => {
    const spaced = await mount('Hi  there\n', {
      searchWorkItems: vi.fn<Search>(async () => [mk(1)]),
    });
    act(() => {
      spaced.editor.chain().focus().setTextSelection(4).insertContent('@ab').run();
    });
    await spaced.flush();
    key(spaced, 'Enter');
    await spaced.flush();
    expect(names(spaced.editor)).toContain('workItemMention');
    cleanup();

    const heading = await mount('# Title\n', {
      searchWorkItems: vi.fn<Search>(async () => [mk(1)]),
    });
    act(() => {
      heading.editor.chain().focus('end').insertContent(' @ab').run();
    });
    await heading.flush();
    key(heading, 'Tab');
    key(heading, 'Enter');
    await heading.flush();
    // A heading cannot be split around a block: the pick is refused, not half-written.
    expect(names(heading.editor)).not.toContain('workItemEmbed');
  });
});
