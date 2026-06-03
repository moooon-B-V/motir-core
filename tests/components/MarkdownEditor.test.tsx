// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// The underlying @uiw/react-md-editor is heavy and DOM-bound (loaded via
// next/dynamic with ssr:false in the wrapper). We mock it with a lightweight
// stub that (a) captures the props the wrapper passes — so the toolbar/preview
// config contract is asserted deterministically — and (b) renders a real
// <textarea> wired to the same value/onChange/onPaste/onDrop handlers, so the
// image-paste contract is exercised through the actual handler path.
const hoisted = vi.hoisted(() => ({ state: { props: null as Record<string, unknown> | null } }));

vi.mock('@uiw/react-md-editor', async () => {
  const { createElement } = await import('react');
  const Editor = (props: Record<string, unknown>) => {
    hoisted.state.props = props;
    const textareaProps = (props.textareaProps ?? {}) as Record<string, unknown>;
    return createElement('textarea', {
      'data-testid': 'md-textarea',
      'aria-label': textareaProps['aria-label'],
      readOnly: textareaProps.readOnly,
      value: (props.value as string) ?? '',
      onChange: (e: { target: { value: string } }) =>
        (props.onChange as (v: string) => void)?.(e.target.value),
      onPaste: textareaProps.onPaste,
      onDrop: textareaProps.onDrop,
    });
  };
  return { default: Editor };
});

// next/dynamic returns the (mocked) editor directly, skipping the lazy boundary.
vi.mock('next/dynamic', async () => {
  const mod = await import('@uiw/react-md-editor');
  return { default: () => (mod as { default: unknown }).default };
});

import { MarkdownEditor, editorConfigFor } from '@/components/ui/MarkdownEditor';

afterEach(() => {
  cleanup();
  hoisted.state.props = null;
});

function lastProps() {
  if (!hoisted.state.props) throw new Error('editor did not render');
  return hoisted.state.props;
}

describe('editorConfigFor (pure toolbar/preview contract)', () => {
  it('full → live preview, full toolbar, tab toggle', () => {
    const c = editorConfigFor('full', false);
    expect(c.preview).toBe('live');
    expect(c.hideToolbar).toBe(false);
    expect(c.commands.length).toBeGreaterThan(8);
    expect(c.extraCommands.map((x) => x.name)).toEqual(['edit', 'preview']);
  });

  it('min → edit-first preview, compact toolbar (bold/italic/code/link)', () => {
    const c = editorConfigFor('min', false);
    expect(c.preview).toBe('edit');
    expect(c.hideToolbar).toBe(false);
    expect(c.commands.map((x) => x.name)).toEqual(['bold', 'italic', 'code', 'link']);
  });

  it('readOnly → no toolbar, no tabs, preview-only', () => {
    const c = editorConfigFor('full', true);
    expect(c.hideToolbar).toBe(true);
    expect(c.preview).toBe('preview');
    expect(c.commands).toEqual([]);
    expect(c.extraCommands).toEqual([]);
  });
});

describe('MarkdownEditor', () => {
  it('is a controlled value/onChange passthrough', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor label="Description" value="hello" onChange={onChange} />);
    expect(lastProps().value).toBe('hello');

    fireEvent.change(screen.getByTestId('md-textarea'), { target: { value: 'world' } });
    expect(onChange).toHaveBeenCalledWith('world');
  });

  it('labels the editing surface from the required label prop', () => {
    render(<MarkdownEditor label="Issue description" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Issue description')).toBeTruthy();
  });

  it('passes the full-size toolbar set by default', () => {
    render(<MarkdownEditor label="d" value="" onChange={() => {}} />);
    const props = lastProps();
    expect(props.preview).toBe('live');
    expect((props.commands as unknown[]).length).toBeGreaterThan(8);
  });

  it('passes the compact toolbar for size="min"', () => {
    render(<MarkdownEditor label="d" size="min" value="" onChange={() => {}} />);
    const props = lastProps();
    expect(props.preview).toBe('edit');
    expect((props.commands as { name: string }[]).map((c) => c.name)).toEqual([
      'bold',
      'italic',
      'code',
      'link',
    ]);
  });

  it('readOnly hides the toolbar + tabs and marks the textarea read-only', () => {
    render(<MarkdownEditor label="d" readOnly value="# hi" onChange={() => {}} />);
    const props = lastProps();
    expect(props.hideToolbar).toBe(true);
    expect(props.preview).toBe('preview');
    expect((props.textareaProps as { readOnly: boolean }).readOnly).toBe(true);
  });

  it('pasting an image WITHOUT an upload handler surfaces a notice and does not insert', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor label="d" value="before" onChange={onChange} />);

    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const onPaste = lastProps().textareaProps as { onPaste: (e: unknown) => void };
    act(() => {
      onPaste.onPaste({
        clipboardData: { files: [file] },
        preventDefault: () => {},
        currentTarget: screen.getByTestId('md-textarea'),
      });
    });

    expect(screen.getByRole('status').textContent).toMatch(/aren't enabled/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pasting an image WITH a handler inserts an uploading placeholder then the final URL', async () => {
    let captured = 'start';
    const onChange = vi.fn((next: string) => {
      captured = next;
    });
    const onImageUpload = vi.fn().mockResolvedValue('https://blob.example/shot.png');

    function Host() {
      return (
        <MarkdownEditor
          label="d"
          value={captured}
          onChange={onChange}
          onImageUpload={onImageUpload}
        />
      );
    }
    render(<Host />);

    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const textarea = screen.getByTestId('md-textarea') as HTMLTextAreaElement;
    textarea.selectionStart = textarea.selectionEnd = captured.length;
    const onPaste = lastProps().textareaProps as { onPaste: (e: unknown) => void };

    act(() => {
      onPaste.onPaste({
        clipboardData: { files: [file] },
        preventDefault: () => {},
        currentTarget: textarea,
      });
    });

    // First synchronous onChange inserts the uploading placeholder.
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('![Uploading shot.png…]'));

    // After the upload resolves, the placeholder is replaced with the final URL.
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.stringContaining('![shot.png](https://blob.example/shot.png)'),
      );
    });
    expect(onImageUpload).toHaveBeenCalledWith(file);
  });

  it('a non-image paste is ignored (normal editor paste proceeds)', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor label="d" value="" onChange={onChange} />);
    const onPaste = lastProps().textareaProps as { onPaste: (e: unknown) => void };
    const preventDefault = vi.fn();
    onPaste.onPaste({
      clipboardData: { files: [] },
      preventDefault,
      currentTarget: screen.getByTestId('md-textarea'),
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
