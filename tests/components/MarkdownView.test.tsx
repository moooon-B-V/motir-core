// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { renderWithIntl } from '../helpers/renderWithIntl';

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

  // THE OPT-IN PROPOSAL LINK (MOTIR-7998). `motir-ref:planItem:<id>` names a
  // proposal with no key yet; it passes both scrub layers ONLY for a render that
  // hands in `renderProposalRef`, and every other surface is unchanged.
  describe('motir-ref proposal links (opt-in)', () => {
    const md = 'See [Billing exports](motir-ref:planItem:abc123) for why.';
    const draw = (id: string, label: React.ReactNode) => (
      <span data-testid="proposal" data-id={id}>
        {label}
      </span>
    );

    it('hands a well-formed link to the callback with its id and label', () => {
      render(<MarkdownView value={md} renderProposalRef={draw} />);
      const node = screen.getByTestId('proposal');
      expect(node.getAttribute('data-id')).toBe('abc123');
      expect(node.textContent).toBe('Billing exports');
      expect(document.querySelector('a')).toBeNull();
    });

    it('renders a malformed link as its label, with no anchor and no empty href', () => {
      const { container } = render(
        <MarkdownView
          value="[Oops](motir-ref:planItem:a b) and [Nope](motir-ref:other:1)"
          renderProposalRef={draw}
        />,
      );
      expect(screen.queryByTestId('proposal')).toBeNull();
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('Oops');
      expect(container.textContent).toContain('Nope');
    });

    it('WITHOUT the option renders exactly as on main (scrubbed href, no callback)', () => {
      const { container } = render(<MarkdownView value={md} />);
      expect(screen.queryByTestId('proposal')).toBeNull();
      const a = container.querySelector('a');
      expect(a?.getAttribute('href') ?? '').not.toContain('motir-ref');
    });

    it('leaves motir: and motir-page: chips unaffected when the option is on', () => {
      const { container } = renderWithIntl(
        <MarkdownView
          value="[MOTIR-1](motir:abc) and [Page](motir-page:def)"
          renderProposalRef={draw}
        />,
      );
      expect(screen.queryByTestId('proposal')).toBeNull();
      expect(container.querySelector('a[href^="motir"]')).toBeNull();
      expect(container.textContent).toContain('MOTIR-1');
    });

    it('still scrubs a javascript: href when the option is on', () => {
      const { container } = render(
        <MarkdownView value="[x](javascript:alert(1))" renderProposalRef={draw} />,
      );
      expect(container.innerHTML).not.toContain('javascript:');
    });
  });
});
