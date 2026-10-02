// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageEditor } from '../../src/editor/PageEditor';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// The toolbar (MOTIR-7275) against `design/pages/page.mock.html`: every control
// the drawing has, in its order, each one doing its job on a real editor.

/** The toolbar the mock draws, in order (state 7). */
const DRAWN = [
  'Bold',
  'Italic',
  'Strikethrough',
  'Heading',
  'Quote',
  'Code block',
  'Bulleted list',
  'Numbered list',
  'Task list',
  'Link',
  'Insert image',
  'Insert table',
];

/** The table group, shown while the caret is in a table. */
const TABLE_GROUP = [
  ['+ Row', 'Add row below'],
  ['+ Column', 'Add column to the right'],
  ['− Row', 'Delete row'],
  ['− Column', 'Delete column'],
  ['Delete table', 'Delete table'],
] as const;

function mount(markdown = 'Some words here\n') {
  render(
    <PageEditor
      initialState={stateFromMarkdown(markdown)}
      editable
      saveUpdate={vi.fn(async () => ({ revision: 2 }))}
      uploadImage={vi.fn()}
      messages={MESSAGES}
      theme="light"
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
  const press = (name: string) => fireEvent.click(within(toolbar).getByRole('button', { name }));
  /** Put the caret (or a selection) somewhere. */
  const select = (from: number, to = from) =>
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
  return { editor, toolbar, press, select, surface };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the strip', () => {
  it('draws every control of the mock, in order, labelled and titled from messages', () => {
    const { toolbar } = mount();
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(DRAWN);
    for (const button of buttons) {
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    }
    // The save indicator sits at the trailing end of the same strip.
    expect(within(toolbar).getByRole('status').textContent).toBe('Saved');
  });

  it('applies each mark and block', () => {
    const { editor, press, select } = mount();
    select(1, 5);
    press('Bold');
    expect(editor.isActive('bold')).toBe(true);
    press('Italic');
    expect(editor.isActive('italic')).toBe(true);
    press('Strikethrough');
    expect(editor.isActive('strike')).toBe(true);

    const blocks: Array<[string, string, Record<string, unknown>?]> = [
      ['Heading', 'heading', { level: 2 }],
      ['Quote', 'blockquote'],
      ['Code block', 'codeBlock'],
      ['Bulleted list', 'bulletList'],
      ['Numbered list', 'orderedList'],
      ['Task list', 'taskList'],
    ];
    for (const [label, name, attrs] of blocks) {
      select(2);
      press(label);
      expect(editor.isActive(name, attrs)).toBe(true);
      press(label); // and off again
      expect(editor.isActive(name, attrs)).toBe(false);
    }
  });

  it('sets, keeps and removes a link through the prompt', () => {
    const { editor, press, select } = mount();
    const prompt = vi.spyOn(window, 'prompt');
    select(1, 5);
    prompt.mockReturnValueOnce('https://motir.co');
    press('Link');
    expect(prompt).toHaveBeenLastCalledWith('Link URL', '');
    expect(editor.getAttributes('link').href).toBe('https://motir.co');

    select(2);
    prompt.mockReturnValueOnce(null); // cancelled: nothing changes
    press('Link');
    expect(prompt).toHaveBeenLastCalledWith('Link URL', 'https://motir.co');
    expect(editor.isActive('link')).toBe(true);

    prompt.mockReturnValueOnce(''); // emptied: the link goes
    press('Link');
    expect(editor.isActive('link')).toBe(false);
  });
});

describe('tables', () => {
  const shape = (editor: Editor) => {
    let rows = 0;
    let cells = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') rows += 1;
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') cells += 1;
    });
    return { rows, cols: rows === 0 ? 0 : cells / rows };
  };

  const posOf = (editor: Editor, test: (node: ProseMirrorNode) => boolean) => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found === -1 && test(node)) found = pos;
    });
    return found;
  };

  it('inserts a table, shows the table group only inside it, and runs each control', () => {
    const { editor, press, toolbar, select } = mount();
    expect(within(toolbar).queryByRole('button', { name: 'Add row below' })).toBeNull();

    press('Insert table');
    expect(shape(editor)).toEqual({ rows: 3, cols: 3 });
    for (const [text, label] of TABLE_GROUP) {
      expect(within(toolbar).getByRole('button', { name: label }).textContent).toBe(text);
    }

    press('Add row below');
    expect(shape(editor).rows).toBe(4);
    press('Add column to the right');
    expect(shape(editor).cols).toBe(4);
    press('Delete row');
    expect(shape(editor).rows).toBe(3);
    press('Delete column');
    expect(shape(editor).cols).toBe(3);

    // Caret out of the table — into the paragraph outside it: the group goes.
    const outside = posOf(editor, (n) => n.isTextblock && n.textContent === 'Some words here');
    select(outside + 1);
    expect(within(toolbar).queryByRole('button', { name: 'Delete table' })).toBeNull();

    // Back in, and delete it.
    const cellPos = posOf(editor, (n) => n.type.name === 'tableCell') + 2;
    select(cellPos);
    press('Delete table');
    expect(shape(editor)).toEqual({ rows: 0, cols: 0 });
    expect(within(toolbar).queryByRole('button', { name: 'Delete table' })).toBeNull();
  });
});
