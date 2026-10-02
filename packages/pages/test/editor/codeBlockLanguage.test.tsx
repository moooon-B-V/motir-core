// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageEditor } from '../../src/editor/PageEditor';
import { CODE_BLOCK_CLASS, CodeBlockLanguageView } from '../../src/editor/codeBlockLanguage';
import { pageSchema } from '../../src';
import type { EditorView } from '@tiptap/pm/view';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// The code block's Language field (MOTIR-7275), copied from the description
// editor's (MOTIR-5458) and supplied through a plugin's node view so the page's
// one extension list stays one list.

afterEach(cleanup);

function mount(editable: boolean) {
  render(
    <PageEditor
      initialState={stateFromMarkdown('Intro\n\n```sh\nls\n```\n')}
      editable={editable}
      saveUpdate={vi.fn(async () => ({ revision: 2 }))}
      uploadImage={vi.fn()}
      messages={MESSAGES}
      theme="light"
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  return { surface, editor };
}

const language = (editor: Editor) => {
  let found: unknown;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock') found = node.attrs.language;
  });
  return found;
};

describe('the Language field', () => {
  it('marks the block the caret is in, and writes the language typed', async () => {
    const { surface, editor } = mount(true);
    const block = surface.querySelector<HTMLElement>(`.${CODE_BLOCK_CLASS}`)!;
    const input = screen.getByRole('textbox', { name: 'Language' }) as HTMLInputElement;
    expect(input.value).toBe('sh');
    expect(block.querySelector('code')?.className).toBe('language-sh');

    expect(block.hasAttribute('data-focused')).toBe(false);
    act(() => {
      editor.commands.setTextSelection(9);
    });
    expect(block.hasAttribute('data-focused')).toBe(true);

    fireEvent.input(input, { target: { value: ' bash ' } });
    expect(language(editor)).toBe('bash');
    expect(block.querySelector('code')?.className).toBe('language-bash');
    // The same value again dispatches nothing.
    fireEvent.input(input, { target: { value: 'bash' } });
    expect(language(editor)).toBe('bash');
    fireEvent.input(input, { target: { value: '' } });
    expect(language(editor)).toBeNull();
    expect(block.querySelector('code')?.className).toBe('');

    // A change from elsewhere reaches the field while it is not focused.
    act(() => {
      editor.commands.updateAttributes('codeBlock', { language: 'ts' });
    });
    expect(input.value).toBe('ts');

    // ...but never over what is being typed in the field.
    input.focus();
    act(() => {
      editor.commands.updateAttributes('codeBlock', { language: 'py' });
    });
    expect(input.value).toBe('ts');
    expect(language(editor)).toBe('py');
    input.blur();

    // Events in the bar are the field's, not the document's: Enter in it
    // splits no code block.
    const before = editor.state.doc.toJSON();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(editor.state.doc.toJSON()).toEqual(before);

    // A mutation in the bar is the bar's; ProseMirror does not re-read it.
    await act(async () => {
      input.setAttribute('data-touched', '');
    });
    expect(editor.state.doc.toJSON()).toEqual(before);

    // Turning the block into a paragraph drops the view.
    act(() => {
      editor.commands.setParagraph();
    });
    expect(surface.querySelector(`.${CODE_BLOCK_CLASS}`)).toBeNull();
  });

  it('builds no field on a read-only page', () => {
    const { surface } = mount(false);
    expect(surface.querySelector(`.${CODE_BLOCK_CLASS}`)).toBeNull();
    expect(surface.querySelector('pre code')?.textContent).toBe('ls');
    expect(screen.queryByRole('textbox', { name: 'Language' })).toBeNull();
  });
});

describe('the node view on its own', () => {
  it('refuses a node of another type, and writes nothing once its block is gone', () => {
    const block = pageSchema.nodes.codeBlock!.create({ language: 'sh' });
    const dispatch = vi.fn();
    const view = { dispatch, state: {} } as unknown as EditorView;
    const nodeView = new CodeBlockLanguageView(block, view, () => undefined, 'Language');
    expect(nodeView.update(pageSchema.nodes.paragraph!.create())).toBe(false);
    const input = nodeView.dom.querySelector('input')!;
    input.value = 'ts';
    input.dispatchEvent(new Event('input'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(nodeView.ignoreMutation({ type: 'selection', target: nodeView.contentDOM })).toBe(false);
    expect(nodeView.ignoreMutation({ type: 'selection', target: input })).toBe(true);
  });
});
