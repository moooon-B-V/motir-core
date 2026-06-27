// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';

import { MarkdownEditor, buildEditorExtensions } from '@/components/ui/MarkdownEditor';
import type {
  MentionWiring,
  WorkItemMentionCandidate,
} from '@/components/ui/markdownEditorMentions';
import { renderWithIntl } from '../helpers/renderWithIntl';

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
    renderWithIntl(<MarkdownEditor label="Description" value="hello" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Description')).toBeTruthy());
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.getByLabelText('Bold')).toBeTruthy();
  });

  it('full size exposes the rich toolbar; min size the compact one', async () => {
    const { unmount } = renderWithIntl(
      <MarkdownEditor label="d" size="full" value="" onChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Heading')).toBeTruthy());
    expect(screen.getByLabelText('Task list')).toBeTruthy();
    unmount();
    cleanup();

    renderWithIntl(<MarkdownEditor label="d" size="min" value="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Bold')).toBeTruthy());
    // The compact toolbar omits the block-level controls.
    expect(screen.queryByLabelText('Heading')).toBeNull();
    expect(screen.queryByLabelText('Task list')).toBeNull();
  });

  it('readOnly renders the rendered document with no toolbar', () => {
    renderWithIntl(<MarkdownEditor label="d" readOnly value="# hi" onChange={() => {}} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    // The read surface renders the heading text (via MarkdownView).
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('picking a file with NO upload handler surfaces a notice (never silent)', async () => {
    const onChange = vi.fn();
    const { container } = renderWithIntl(<MarkdownEditor label="d" value="" onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByRole('status').textContent).toMatch(/aren't enabled/i);
  });

  it('picking an allowed file WITH a handler calls the uploader', async () => {
    const onFileUpload = vi.fn().mockResolvedValue('https://blob.example/shot.png');
    const { container } = renderWithIntl(
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
    const { container } = renderWithIntl(
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

// ── Work-item mentions (Subtask 5.8.5) ──────────────────────────────────────
// The unified `@` picker offers People AND work items. A work-item pick inserts
// a `workItemMention` node serializing to `[<KEY>](motir:<workItemId>)` — the
// durable token, the parallel of the user `[@Name](mention:<userId>)`. Two
// storage invariants mirror the user-mention ones: (1) the `motir:` token
// round-trips load → edit → getMarkdown() unchanged; (2) WITHOUT `searchWorkItems`
// the schema is the pre-5.8.5 one, so the token degrades to plain text exactly
// like an existing consumer — and the people path is byte-identical.
const WORK_ITEM_WIRING: MentionWiring = {
  getCandidates: () => [],
  getAnchor: () => null,
  searchWorkItems: async () => [],
};

function roundTripWithWorkItems(markdown: string): string {
  const element = document.createElement('div');
  const editor = new Editor({
    element,
    extensions: buildEditorExtensions({ mentions: WORK_ITEM_WIRING }),
    content: markdown,
  });
  const storage = (editor.storage as unknown as Record<string, unknown>).markdown as {
    getMarkdown: () => string;
  };
  const out = storage.getMarkdown();
  editor.destroy();
  return out.trim();
}

describe('Work-item mention token round-trip (storage invariant, 5.8.5)', () => {
  it('preserves a work-item token through load → serialize', () => {
    const doc = 'Blocks [MOTIR-805](motir:cm9zabc123) — wire that first.';
    expect(roundTripWithWorkItems(doc)).toBe(doc);
  });

  it('is idempotent over a body with multiple work-item tokens', () => {
    const doc = 'See [MOTIR-805](motir:wi_a) and [MOTIR-1404](motir:wi_b).';
    const once = roundTripWithWorkItems(doc);
    const twice = roundTripWithWorkItems(once);
    expect(once).toBe(doc);
    expect(twice).toBe(once);
  });

  it('keeps the user-mention token byte-identical alongside a work-item token', () => {
    // The people path is unchanged: the user token round-trips exactly as before
    // (5.1.4) even with the work-item node registered in the same schema.
    const doc = 'cc [@Bo Philips](mention:user_bo) on [MOTIR-805](motir:wi_a)';
    expect(roundTripWithWorkItems(doc)).toBe(doc);
  });

  it('a malformed work-item token (empty id) degrades to plain text', () => {
    // The parseHTML rule rejects the empty id, so the anchor falls to the Link
    // mark — and `motir:` is not an allowed link scheme, leaving the bare label.
    const doc = 'ghost [MOTIR-9](motir:) here';
    expect(roundTripWithWorkItems(doc)).toBe('ghost MOTIR-9 here');
  });

  it('WITHOUT searchWorkItems the motir token degrades to plain text (existing-consumer fallback)', () => {
    // People-only wiring (no searchWorkItems) does NOT register the work-item
    // node, so a `motir:` token loaded there becomes plain text — exactly the
    // pre-5.8.5 schema, the same way a `mention:` token degrades without people.
    const doc = 'Blocks [MOTIR-805](motir:cm9zabc123) please';
    expect(roundTripWithMentions(doc)).toBe('Blocks MOTIR-805 please');
  });
});

describe('Unified @ picker — People + Work items (component, 5.8.5)', () => {
  const PEOPLE = [{ id: 'user_isaac', name: 'Isaac', email: 'isaac@motir.co' }];

  const WORK_ITEMS: WorkItemMentionCandidate[] = [
    {
      id: 'wi_805',
      identifier: 'MOTIR-805',
      title: 'Issue-tree generation',
      kind: 'story',
      status: { label: 'To Do', tone: 'planned' },
    },
    {
      id: 'wi_1404',
      identifier: 'MOTIR-1404',
      title: 'Render — live chip',
      kind: 'subtask',
      status: { label: 'Blocked', tone: 'warning' },
    },
  ];

  function UnifiedHarness({
    onReady,
    searchWorkItems,
  }: {
    onReady: (editor: Editor) => void;
    searchWorkItems?: (q: string) => Promise<WorkItemMentionCandidate[]>;
  }) {
    const anchorRef = useRef<HTMLDivElement>(null);
    const editor = useEditor({
      immediatelyRender: false,
      extensions: buildEditorExtensions({
        mentions: {
          getCandidates: () => PEOPLE,
          getAnchor: () => anchorRef.current,
          searchWorkItems,
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

  async function mount(searchWorkItems?: (q: string) => Promise<WorkItemMentionCandidate[]>) {
    let editor: Editor | null = null;
    render(<UnifiedHarness onReady={(e) => (editor = e)} searchWorkItems={searchWorkItems} />);
    await waitFor(() => expect(editor).toBeTruthy());
    return { editor: editor as unknown as Editor, anchor: screen.getByTestId('anchor') };
  }

  function markdownOf(editor: Editor): string {
    const storage = (editor.storage as unknown as Record<string, unknown>).markdown as {
      getMarkdown: () => string;
    };
    return storage.getMarkdown();
  }

  it('typing @ shows BOTH the People and Work items sections', async () => {
    const { editor, anchor } = await mount(async () => WORK_ITEMS);
    editor.commands.focus('end');
    editor.commands.insertContent('@');

    // Empty query: People shows all candidates; Work items shows the
    // "keep typing" prompt (below the search minimum) — both sections present.
    await waitFor(() => {
      const listbox = anchor.querySelector('[role="listbox"]');
      expect(listbox?.getAttribute('aria-label')).toBe('Mention a person or work item');
      expect(listbox?.textContent).toContain('People');
      expect(listbox?.textContent).toContain('Work items');
      expect(listbox?.textContent).toContain('Isaac');
      expect(listbox?.textContent).toContain('Keep typing to search work items');
    });
  });

  it('picking a work item inserts a node serializing to [KEY](motir:<id>)', async () => {
    const search = vi.fn(async () => WORK_ITEMS);
    const { editor, anchor } = await mount(search);
    editor.commands.focus('end');
    // "is" matches the person Isaac AND is past the work-item search minimum.
    editor.commands.insertContent('@is');

    // The debounced search resolves the Work items section.
    await waitFor(() => {
      const opts = anchor.querySelectorAll('[role="option"]');
      // 1 person (Isaac) + 2 work items.
      expect(opts.length).toBe(3);
    });
    expect(search).toHaveBeenCalledWith('is');
    const options = anchor.querySelectorAll('[role="option"]');
    expect(options[1]?.textContent).toContain('MOTIR-805');
    expect(options[1]?.textContent).toContain('Issue-tree generation');
    expect(options[1]?.textContent).toContain('To Do');

    // ↓ from the person into the first work item, then Enter commits the token.
    fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(anchor.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
        'MOTIR-805',
      ),
    );
    expect(anchor.querySelector('[role="listbox"]')?.getAttribute('aria-activedescendant')).toBe(
      'mention-option-1',
    );

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    await waitFor(() => expect(markdownOf(editor)).toContain('[MOTIR-805](motir:wi_805)'));
    expect(anchor.querySelector('[role="listbox"]')).toBeNull();
  });

  it('absent searchWorkItems → no Work items section (people-only fallback)', async () => {
    const { editor, anchor } = await mount(undefined);
    editor.commands.focus('end');
    editor.commands.insertContent('@');

    await waitFor(() => expect(anchor.querySelector('[role="listbox"]')).toBeTruthy());
    const listbox = anchor.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute('aria-label')).toBe('Mention a member');
    expect(listbox?.textContent).not.toContain('Work items');
    expect(listbox?.textContent).toContain('Isaac');
  });
});
