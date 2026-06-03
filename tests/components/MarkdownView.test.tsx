// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownView } from '@/components/ui/MarkdownView';

afterEach(() => cleanup());

describe('MarkdownView', () => {
  it('renders GFM Markdown to semantic HTML through the shared render path', () => {
    render(<MarkdownView value={'# Title\n\nSome **bold** text.\n\n- a\n- b'} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('round-trips a stored Markdown value identically (snapshot)', () => {
    // The editor stores raw Markdown (identity); reading it back through
    // MarkdownView must render deterministically.
    const stored = '## Heading\n\nA [link](https://example.com) and `code`.';
    const { container } = render(<MarkdownView value={stored} />);
    expect(container.querySelector('.wmde-markdown')?.innerHTML).toMatchSnapshot();
  });

  it('forwards an accessible label to the rendered region', () => {
    render(<MarkdownView value="hi" aria-label="Rendered description" />);
    expect(screen.getByLabelText('Rendered description')).toBeTruthy();
  });
});
