// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import { MENTION_SEARCH_DEBOUNCE_MS } from '../../src/editor/workItemMention';
import type {
  AvailableWorkItemRefView,
  WorkItemCandidate,
  WorkItemRefView,
} from '../../src/editor/workItemMention';
import { defaultEmbedCard } from '../../src/editor/workItemEmbed';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// The embedded work-item card in the page editor (MOTIR-9182), against
// `design/pages/page--work-item-embed.mock.html`: the card's states, the picker's
// insert-as band, the toolbar door, and the two conversions — on a real Tiptap
// editor bound to a real Yjs doc, with the host's renderers injected.

const LIVE: AvailableWorkItemRefView = {
  accessible: true,
  id: 'ckLive',
  identifier: 'MOTIR-1188',
  title: 'Page export to Markdown',
  kind: 'task',
  archived: false,
  status: { key: 'in_review', label: 'In Review', category: 'in_progress' },
  type: 'code',
  assignee: { id: 'u1', name: 'Dana Whitfield', image: null },
};

const REFS: Record<string, WorkItemRefView> = {
  ckLive: LIVE,
  ckOld: { ...LIVE, id: 'ckOld', identifier: 'MOTIR-919', title: 'Old outline', archived: true },
  ckHidden: { accessible: false, id: 'ckHidden' },
};

const CANDIDATE: WorkItemCandidate = {
  id: 'ckNew',
  identifier: 'MOTIR-2001',
  title: 'A freshly picked item',
  kind: 'story',
  status: { label: 'To Do', category: 'todo' },
  type: null,
  assignee: null,
};

/** The host's card, as a test double that shows what it was handed. */
const card = (view: AvailableWorkItemRefView) => (
  <span data-testid="card" data-archived={view.archived}>
    {[
      view.identifier,
      view.title,
      view.type,
      view.status?.label,
      view.assignee?.name,
      view.archived ? 'archived' : 'live',
    ].join(' | ')}
  </span>
);

const BODY = 'Before [](motir:ckLive) after.\n\nSecond paragraph.\n';

async function mount(overrides: Partial<PageEditorProps> = {}, body = BODY) {
  let resolveSearch: ((items: WorkItemCandidate[]) => void) | null = null;
  const searchWorkItems = vi.fn(
    () =>
      new Promise<WorkItemCandidate[]>((resolve) => {
        resolveSearch = resolve;
      }),
  );
  const onOpenWorkItem = vi.fn();
  const utils = render(
    <PageEditor
      initialState={stateFromMarkdown(body)}
      editable
      saveUpdate={vi.fn(async () => ({ revision: 2 }))}
      uploadImage={vi.fn()}
      messages={MESSAGES}
      theme="light"
      searchWorkItems={searchWorkItems}
      workItemRefs={REFS}
      renderWorkItemCard={card}
      renderPickerRow={(c) => <span>{c.identifier}</span>}
      onOpenWorkItem={onOpenWorkItem}
      {...overrides}
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await flush();
  return {
    ...utils,
    surface,
    editor,
    onOpenWorkItem,
    searchWorkItems,
    flush,
    answer: (items: WorkItemCandidate[]) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(MENTION_SEARCH_DEBOUNCE_MS);
        resolveSearch?.(items);
        await vi.advanceTimersByTimeAsync(0);
      }),
  };
}

/** The document's top-level node types, in order. */
function shape(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.type.name));
  return out;
}

function count(editor: Editor, type: string): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === type) n += 1;
  });
  return n;
}

function selectFirst(editor: Editor, type: string) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === type) at = pos;
  });
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  });
}

const CARD_BODY = 'Intro.\n\n![](motir:ckLive)\n\nOutro.\n';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the card node view', () => {
  it('hands the host all five facts, and keeps the id as the only stored attribute', async () => {
    const { editor } = await mount({}, CARD_BODY);
    expect(screen.getByTestId('card').textContent).toBe(
      'MOTIR-1188 | Page export to Markdown | code | In Review | Dana Whitfield | live',
    );
    let attrs: Record<string, unknown> | null = null;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'workItemEmbed') attrs = { ...n.attrs };
    });
    expect(attrs).toEqual({ id: 'ckLive', label: null });
  });

  it('names the edit card by its key and is not a link', async () => {
    await mount({}, CARD_BODY);
    expect(screen.getByRole('group', { name: 'Work item MOTIR-1188' })).toBeTruthy();
    expect(document.querySelector('.motir-wi-embed a')).toBeNull();
  });

  it('draws an archived-but-readable item through the host, flagged, with its facts', async () => {
    await mount({}, '![](motir:ckOld)\n');
    const drawn = screen.getByTestId('card');
    expect(drawn.getAttribute('data-archived')).toBe('true');
    expect(drawn.textContent).toContain('MOTIR-919');
    expect(drawn.textContent).toContain('Old outline');
  });

  it('draws the same unavailable card for an unreadable item and for an absent id', async () => {
    await mount({}, '![](motir:ckHidden)\n\n![](motir:ckGone)\n');
    const unavailable = Array.from(document.querySelectorAll('.wi-card.is-unavailable'));
    expect(unavailable).toHaveLength(2);
    expect(unavailable[0]!.outerHTML).toBe(
      unavailable[1]!.outerHTML.replace(/ckGone/g, 'ckHidden'),
    );
    for (const el of unavailable) {
      expect(el.getAttribute('title')).toBe(MESSAGES.embed.unavailableTitle);
      expect(el.textContent).toBe(MESSAGES.embed.unavailable);
    }
    const wrappers = document.querySelectorAll('.motir-wi-embed');
    for (const wrapper of Array.from(wrappers)) {
      // The id sits on the wrapper only as the node's own handle; no fact leaks inside.
      expect(wrapper.querySelector('.wi-card')!.textContent).not.toMatch(/ck|MOTIR|Type/);
    }
  });

  it('falls back to key, title and status when the host passes no card renderer', async () => {
    await mount({ renderWorkItemCard: undefined }, CARD_BODY);
    const drawn = document.querySelector('.wi-card')!;
    expect(drawn.textContent).toBe('MOTIR-1188Page export to MarkdownIn Review');
    expect(defaultEmbedCard({ ...LIVE, status: null })).toBeTruthy();
  });

  it('selects on a click in the editor and never follows it', async () => {
    const { onOpenWorkItem } = await mount({}, CARD_BODY);
    fireEvent.click(screen.getByTestId('card'));
    expect(onOpenWorkItem).not.toHaveBeenCalled();
  });

  it('renders one anchor in the read-only page, and a plain click opens the item', async () => {
    const { onOpenWorkItem } = await mount(
      { editable: false, workItemHref: (v) => `/items/${v.identifier}` },
      CARD_BODY,
    );
    const frame = document.querySelector('.motir-wi-embed')!;
    const anchors = frame.querySelectorAll('a, button, input, [tabindex]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('/items/MOTIR-1188');
    fireEvent.click(screen.getByTestId('card'));
    expect(onOpenWorkItem).toHaveBeenCalledWith('ckLive');
  });

  it('removes the card from its menu, restoring the pre-insert document', async () => {
    const { editor, flush } = await mount({}, '');
    const before = JSON.stringify(editor.getJSON());
    const { insertWorkItemEmbed } = await import('../../src/editor/workItemEmbed');
    act(() => {
      insertWorkItemEmbed(editor, { from: 1, to: 1 }, CANDIDATE);
    });
    await flush();
    expect(shape(editor)).toEqual(['workItemEmbed']);
    fireEvent.click(screen.getByRole('button', { name: 'Card options', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove card', hidden: true }));
    await flush();
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });
});

describe('the conversions', () => {
  it('turns a chip into one card between two paragraphs of its own text', async () => {
    const { editor } = await mount();
    selectFirst(editor, 'workItemMention');
    let changed = false;
    act(() => {
      changed = editor.commands.convertMentionToEmbed();
    });
    expect(changed).toBe(true);
    expect(shape(editor)).toEqual(['paragraph', 'workItemEmbed', 'paragraph', 'paragraph']);
    expect(count(editor, 'workItemMention')).toBe(0);
    expect(count(editor, 'workItemEmbed')).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe('Before ');
    expect(editor.state.doc.child(2).textContent).toBe(' after.');
    expect(editor.state.doc.child(3).textContent).toBe('Second paragraph.');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('workItemEmbed');
  });

  it('turns a card into one chip in a paragraph that merges nothing', async () => {
    const { editor } = await mount({}, CARD_BODY);
    selectFirst(editor, 'workItemEmbed');
    act(() => {
      expect(editor.commands.convertEmbedToMention()).toBe(true);
    });
    expect(shape(editor)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(editor.state.doc.child(0).textContent).toBe('Intro.');
    expect(editor.state.doc.child(1).childCount).toBe(1);
    expect(editor.state.doc.child(1).firstChild!.type.name).toBe('workItemMention');
    expect(editor.state.doc.child(2).textContent).toBe('Outro.');
    expect(count(editor, 'workItemEmbed')).toBe(0);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('workItemMention');
  });

  it('is a no-op, leaving the JSON equal, off a single node of the source kind', async () => {
    const { editor } = await mount();
    const before = editor.getJSON();
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 12 }); // text spanning a chip
    });
    let a = true;
    let b = true;
    act(() => {
      a = editor.commands.convertMentionToEmbed();
      b = editor.commands.convertEmbedToMention();
    });
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('binds Mod-Enter to the conversion and lets it fall through on plain text', async () => {
    const { editor, surface } = await mount();
    const before = editor.getJSON();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    act(() => {
      fireEvent.keyDown(surface, { key: 'Enter', ctrlKey: true });
    });
    // Nothing converts, and the key falls through to the hard break's own binding.
    expect(count(editor, 'workItemEmbed')).toBe(0);
    expect(count(editor, 'workItemMention')).toBe(1);
    expect(before).toBeTruthy();
    selectFirst(editor, 'workItemMention');
    act(() => {
      fireEvent.keyDown(surface, { key: 'Enter', ctrlKey: true });
    });
    expect(count(editor, 'workItemEmbed')).toBe(1);
  });

  it('is one transaction, so one undo restores the chip', async () => {
    const { editor, flush } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // past the undo manager's capture window
    });
    const before = editor.getJSON();
    selectFirst(editor, 'workItemMention');
    let transactions = 0;
    editor.on('transaction', () => (transactions += 1));
    act(() => {
      editor.commands.convertMentionToEmbed();
    });
    await flush();
    expect(transactions).toBe(1);
    act(() => {
      editor.commands.undo();
    });
    await flush();
    expect(editor.getJSON()).toEqual(before);
  });

  it('draws a Show as card control beside the chip, never inside it', async () => {
    const { editor } = await mount({
      renderWorkItemChip: () => <span data-testid="chip">chip</span>,
    });
    const chip = screen.getByTestId('chip');
    const control = document.querySelector<HTMLElement>('[data-embed-convert]')!;
    expect(control.getAttribute('aria-label')).toBe('Show as card');
    expect(chip.contains(control)).toBe(false);
    fireEvent.click(control);
    expect(count(editor, 'workItemEmbed')).toBe(1);
  });
});

describe('the two doors and the insert-as band', () => {
  it('opens in card placement from the toolbar, inserting a block with the id only', async () => {
    const { editor, answer, flush } = await mount({}, 'Intro.\n');
    const embed = screen.getByRole('button', { name: 'Embed a work item as a card' });
    expect(embed.getAttribute('aria-haspopup')).toBe('listbox');
    act(() => {
      editor.commands.focus('end');
    });
    fireEvent.click(embed);
    await flush();
    const picker = screen.getByRole('listbox', { name: 'Mention a work item' });
    expect(
      within(document.body).getByRole('radio', { name: 'Card' }).getAttribute('aria-checked'),
    ).toBe('true');
    act(() => {
      editor.commands.insertContent('ab');
    });
    await flush();
    await answer([CANDIDATE]);
    expect(picker.textContent).toContain('MOTIR-2001');
    act(() => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Page body' }), { key: 'Enter' });
    });
    await flush();
    let attrs: Record<string, unknown> | null = null;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'workItemEmbed') attrs = { ...n.attrs };
    });
    expect(attrs).toEqual({ id: 'ckNew', label: null });
    expect(screen.getByTestId('card').textContent).toContain('MOTIR-2001');
  });

  it('opens in mention placement from @, and Tab switches the band', async () => {
    const { editor, flush, surface } = await mount({}, 'Intro.\n');
    act(() => {
      editor.chain().focus('end').insertContent(' @').run();
    });
    await flush();
    const mention = screen.getByRole('radio', { name: 'Inline mention' });
    expect(mention.getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.keyDown(surface, { key: 'Tab' });
    });
    await flush();
    expect(screen.getByRole('radio', { name: 'Card' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.mouseDown(mention);
    expect(mention.getAttribute('aria-checked')).toBe('true');
  });

  it('draws no embed control, no band and no picker without a search', async () => {
    await mount({ searchWorkItems: undefined });
    expect(screen.queryByRole('button', { name: 'Embed a work item as a card' })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('leaves the shipped Work item button as it is', async () => {
    await mount();
    const button = screen.getByRole('button', { name: 'Mention a work item' });
    expect(button.textContent).toBe('Work item');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
  });
});

describe('the copy', () => {
  const read = (file: string) =>
    JSON.parse(readFileSync(resolve(process.cwd(), '../../messages', file), 'utf8')) as {
      pages: { embed: Record<string, string>; editor: { toolbar: Record<string, string> } };
    };

  it('carries every embed key in both locales', () => {
    const embedKeys = [
      'unavailable',
      'unavailableTitle',
      'noStatus',
      'unassigned',
      'archived',
      'typeLabel',
      'cardLabel',
      'open',
      'menu',
      'toMention',
      'toCard',
      'remove',
      'insertAs',
      'insertMention',
      'insertCard',
      'insertHint',
    ];
    const toolbarKeys = [
      'embedWorkItem',
      'embedWorkItemLabel',
      'embedWorkItemTip',
      'embedWorkItemInCode',
    ];
    for (const file of ['en.json', 'zh.json']) {
      const catalogue = read(file);
      for (const key of embedKeys) {
        expect(catalogue.pages.embed[key], `${file} pages.embed.${key}`).toBeTruthy();
      }
      for (const key of toolbarKeys) {
        expect(catalogue.pages.editor.toolbar[key], `${file} toolbar.${key}`).toBeTruthy();
      }
    }
  });
});
