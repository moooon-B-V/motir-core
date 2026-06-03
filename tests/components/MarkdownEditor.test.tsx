// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';

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
