// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';

import { MarkdownEditor, buildEditorExtensions } from '@/components/ui/MarkdownEditor';

afterEach(cleanup);

// ── The library-choice gate ────────────────────────────────────────────────
// 2.3.10 swaps the split source/preview editor for a true WYSIWYG one, but the
// storage invariant (Story 1.4) is unchanged: `descriptionMd` is Markdown TEXT.
// The editor is only acceptable if it round-trips Markdown losslessly over our
// supported feature set — parse it into the document, serialize it back, and the
// Markdown must survive. We exercise the SAME extension schema the UI uses
// (`buildEditorExtensions`) via a headless editor so this is a pure data test.
function roundTrip(markdown: string): string {
  const element = document.createElement('div');
  const editor = new Editor({ element, extensions: buildEditorExtensions(), content: markdown });
  const storage = (editor.storage as unknown as Record<string, unknown>).markdown as {
    getMarkdown: () => string;
  };
  const out = storage.getMarkdown();
  editor.destroy();
  return out.trim();
}

describe('Markdown round-trip fidelity (storage invariant)', () => {
  const cases: Array<[name: string, input: string, expected: string]> = [
    ['heading', '# Title', '# Title'],
    ['h2', '## Section', '## Section'],
    ['bold', '**bold**', '**bold**'],
    ['italic', '*italic*', '*italic*'],
    ['strikethrough', '~~struck~~', '~~struck~~'],
    ['inline code', 'a `snippet` here', 'a `snippet` here'],
    ['link', '[docs](https://example.com)', '[docs](https://example.com)'],
    ['blockquote', '> quoted', '> quoted'],
  ];

  it.each(cases)('preserves %s', (_name, input, expected) => {
    expect(roundTrip(input)).toContain(expected);
  });

  it('preserves an unordered list', () => {
    const out = roundTrip('- one\n- two');
    expect(out).toContain('- one');
    expect(out).toContain('- two');
  });

  it('preserves an ordered list', () => {
    const out = roundTrip('1. first\n2. second');
    expect(out).toContain('1. first');
    expect(out).toContain('second');
  });

  it('preserves a GFM task list (checked + unchecked)', () => {
    const out = roundTrip('- [ ] todo\n- [x] done');
    expect(out).toContain('[ ]');
    expect(out).toContain('[x]');
  });

  it('preserves a fenced code block', () => {
    const out = roundTrip('```\nconst x = 1;\n```');
    expect(out).toContain('```');
    expect(out).toContain('const x = 1;');
  });

  it('is idempotent over a mixed document (serialize∘parse is stable)', () => {
    const doc = [
      '# Heading',
      '',
      'Some **bold** and *italic* and a [link](https://example.com).',
      '',
      '- bullet one',
      '- bullet two',
      '',
      '1. step one',
      '2. step two',
      '',
      '- [ ] open task',
      '- [x] closed task',
      '',
      '> a quote',
      '',
      '`inline code`',
    ].join('\n');
    const once = roundTrip(doc);
    const twice = roundTrip(once);
    expect(twice).toBe(once);
  });

  it('keeps raw HTML inert (no injection through the editor)', () => {
    const out = roundTrip('<script>alert(1)</script> safe');
    expect(out).not.toContain('<script>');
    expect(out).toContain('safe');
  });
});

// ── Component wiring ────────────────────────────────────────────────────────
describe('MarkdownEditor (component)', () => {
  it('renders a labelled, editable textbox with a formatting toolbar', async () => {
    render(<MarkdownEditor label="Description" value="hello" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Description')).toBeTruthy());
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.getByLabelText('Bold')).toBeTruthy();
  });

  it('full size exposes the rich toolbar; min size the compact one', async () => {
    const { unmount } = render(
      <MarkdownEditor label="d" size="full" value="" onChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Heading')).toBeTruthy());
    expect(screen.getByLabelText('Task list')).toBeTruthy();
    unmount();
    cleanup();

    render(<MarkdownEditor label="d" size="min" value="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Bold')).toBeTruthy());
    // The compact toolbar omits the block-level controls.
    expect(screen.queryByLabelText('Heading')).toBeNull();
    expect(screen.queryByLabelText('Task list')).toBeNull();
  });

  it('readOnly renders the rendered document with no toolbar', () => {
    render(<MarkdownEditor label="d" readOnly value="# hi" onChange={() => {}} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    // The read surface renders the heading text (via MarkdownView).
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('picking a file with NO upload handler surfaces a notice (never silent)', async () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor label="d" value="" onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByRole('status').textContent).toMatch(/aren't enabled/i);
  });

  it('picking an allowed file WITH a handler calls the uploader', async () => {
    const onFileUpload = vi.fn().mockResolvedValue('https://blob.example/shot.png');
    const { container } = render(
      <MarkdownEditor label="d" value="" onChange={() => {}} onFileUpload={onFileUpload} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Attach file')).toBeTruthy());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onFileUpload).toHaveBeenCalledWith(file));
  });
});

// ── Mentions (Subtask 5.1.4) ────────────────────────────────────────────────
// The mention capability is opt-in via `mentionCandidates` / the `mentions`
// option on buildEditorExtensions. Two storage invariants: (1) the token
// `[@Display Name](mention:<userId>)` round-trips load → edit → getMarkdown()
// unchanged; (2) WITHOUT the option the schema is exactly the pre-5.1.4 one,
// so existing consumers stay byte-identical (the token stays a plain link).
const MENTION_WIRING = { getCandidates: () => [], getAnchor: () => null };

function roundTripWithMentions(markdown: string): string {
  const element = document.createElement('div');
  const editor = new Editor({
    element,
    extensions: buildEditorExtensions({ mentions: MENTION_WIRING }),
    content: markdown,
  });
  const storage = (editor.storage as unknown as Record<string, unknown>).markdown as {
    getMarkdown: () => string;
  };
  const out = storage.getMarkdown();
  editor.destroy();
  return out.trim();
}

describe('Mention token round-trip (storage invariant, 5.1.4)', () => {
  it('preserves a mention token through load → serialize', () => {
    const doc = 'Ping [@Bo Philips](mention:cm9zabc123) about the fix.';
    expect(roundTripWithMentions(doc)).toBe(doc);
  });

  it('is idempotent over a body with multiple mentions', () => {
    const doc =
      'Handing to [@Bo Philips](mention:user_bo) — cc [@Zhu Yue](mention:user_yue) for review.';
    const once = roundTripWithMentions(doc);
    const twice = roundTripWithMentions(once);
    expect(once).toBe(doc);
    expect(twice).toBe(once);
  });

  it('preserves a mention inside surrounding formatting', () => {
    const doc = '**bold** then [@Mo](mention:abc-123_X) then `code`';
    expect(roundTripWithMentions(doc)).toBe(doc);
  });

  it('a malformed token (empty id) is NOT parsed as a mention — it degrades to plain text', () => {
    // The mention parseHTML rule rejects the empty id, so the anchor falls to
    // the Link mark — and tiptap v3's Link strips non-allowlisted protocols
    // (`mention:` isn't in its scheme allowlist), leaving the display text.
    // Same degradation the render side applies (never a broken link).
    const doc = 'ghost [@Ghost](mention:) here';
    expect(roundTripWithMentions(doc)).toBe('ghost @Ghost here');
  });

  it('WITHOUT the mentions option the schema is the pre-5.1.4 one (token degrades exactly as before)', () => {
    // Pre-5.1.4 behaviour, pinned: the v3 Link mark drops the `mention:` href
    // (protocol allowlist), so a token loaded into a NON-mention-enabled editor
    // becomes plain text. Mention-bearing surfaces must pass
    // `mentionCandidates` (5.1.5 wires them) — this assertion documents that
    // the no-prop schema is byte-identical to today.
    const doc = 'Ping [@Bo Philips](mention:cm9zabc123) please';
    expect(roundTrip(doc)).toBe('Ping @Bo Philips please');
  });
});

describe('Mention picker (component, 5.1.4)', () => {
  const CANDIDATES = [
    { id: 'user_bo', name: 'Bo Philips', email: 'bophilips@motir.co' },
    { id: 'user_eikooc', name: 'Eikooc', email: 'eikooc@motir.co' },
    { id: 'user_julian', name: 'Julian', email: 'julian@motir.co' },
  ];

  // The popup renders through ReactRenderer, which mounts via the editor's
  // React contentComponent portal — so the picker is exercised over a
  // React-mounted editor (EditorContent), exactly how the app hosts it. The
  // harness exposes the editor instance to drive typing programmatically
  // (ProseMirror ignores synthetic text-input events in happy-dom).
  function PickerHarness({ onReady }: { onReady: (editor: Editor) => void }) {
    const anchorRef = useRef<HTMLDivElement>(null);
    const editor = useEditor({
      immediatelyRender: false,
      extensions: buildEditorExtensions({
        mentions: {
          getCandidates: () => CANDIDATES,
          getAnchor: () => anchorRef.current,
        },
      }),
      content: '',
    });
    useEffect(() => {
      if (editor) onReady(editor);
    }, [editor, onReady]);
    return (
      <div ref={anchorRef} data-testid="anchor" className="relative">
        {editor && <EditorContent editor={editor} />}
      </div>
    );
  }

  async function mountPicker() {
    let editor: Editor | null = null;
    render(<PickerHarness onReady={(e) => (editor = e)} />);
    await waitFor(() => expect(editor).toBeTruthy());
    const anchor = screen.getByTestId('anchor');
    return { editor: editor as unknown as Editor, anchor };
  }

  function markdownOf(editor: Editor): string {
    const storage = (editor.storage as unknown as Record<string, unknown>).markdown as {
      getMarkdown: () => string;
    };
    return storage.getMarkdown();
  }

  it('typing @ opens the member listbox; ↓ + Enter inserts the picked mention as a token', async () => {
    const { editor, anchor } = await mountPicker();
    editor.commands.focus('end');
    editor.commands.insertContent('@');

    await waitFor(() => expect(anchor.querySelector('[role="listbox"]')).toBeTruthy());
    const options = anchor.querySelectorAll('[role="option"]');
    expect(options.length).toBe(3);
    expect(options[0]?.textContent).toContain('Bo Philips');
    expect(options[0]?.textContent).toContain('bophilips@motir.co');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    // ↓ moves the active row (aria-activedescendant + aria-selected follow)…
    fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(anchor.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
        'Eikooc',
      ),
    );
    expect(anchor.querySelector('[role="listbox"]')?.getAttribute('aria-activedescendant')).toBe(
      'mention-option-1',
    );

    // …and Enter commits it as the durable Markdown token.
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    await waitFor(() => expect(markdownOf(editor)).toContain('[@Eikooc](mention:user_eikooc)'));
    expect(anchor.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters as you type (name OR email substring) and Escape dismisses', async () => {
    const { editor, anchor } = await mountPicker();
    editor.commands.focus('end');
    editor.commands.insertContent('@juli');

    await waitFor(() => {
      const options = anchor.querySelectorAll('[role="option"]');
      expect(options.length).toBe(1);
      expect(options[0]?.textContent).toContain('Julian');
    });

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });
    await waitFor(() => expect(anchor.querySelector('[role="listbox"]')).toBeNull());
  });

  it('the MarkdownEditor component wires mentionCandidates through (no popup until @)', async () => {
    const { container } = render(
      <MarkdownEditor
        label="Comment"
        value=""
        onChange={() => {}}
        mentionCandidates={CANDIDATES}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Comment')).toBeTruthy());
    expect(container.querySelector('[role="listbox"]')).toBeNull(); // closed until @
  });
});
