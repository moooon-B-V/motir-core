// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { renderWithIntl } from '../helpers/renderWithIntl';

// A `[<title>](motir-page:<id>)` token in a body renders the live page chip from
// `pageRefs` (Story MOTIR-7694 · MOTIR-7698). The token's STORED label is never
// rendered: it is the title at insert, which a reader who may not see the page,
// or a page since renamed, must not show.

afterEach(cleanup);

const BODY = 'See [Old title](motir-page:pg_1) and [Secret plan](motir-page:pg_2).';

describe('MarkdownView — page tags', () => {
  it('renders the CURRENT title from pageRefs, linking to the page', () => {
    const { container } = renderWithIntl(
      <MarkdownView
        value={BODY}
        pageRefs={{
          pg_1: { state: 'available', id: 'pg_1', title: 'Roadmap Q4' },
          pg_2: { state: 'unavailable', id: 'pg_2' },
        }}
      />,
    );
    const link = container.querySelector('a.page-chip');
    expect(link?.getAttribute('href')).toBe('/pages/pg_1');
    expect(link?.textContent).toBe('Roadmap Q4');
    expect(container.querySelector('.page-chip.is-unavailable')?.textContent).toBe(
      'Page unavailable',
    );
    expect(container.innerHTML).not.toContain('Old title');
    expect(container.innerHTML).not.toContain('Secret plan');
  });

  it('without pageRefs every page token is unavailable and no stored label leaks', () => {
    const { container } = renderWithIntl(<MarkdownView value={BODY} />);
    expect(container.querySelectorAll('.page-chip.is-unavailable')).toHaveLength(2);
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('Old title');
    expect(container.innerHTML).not.toContain('Secret plan');
  });

  it('a malformed page token is plain text, not a chip', () => {
    const { container } = renderWithIntl(<MarkdownView value="ghost [Roadmap](motir-page:) x" />);
    expect(container.querySelector('.page-chip')).toBeNull();
    expect(container.textContent).toContain('ghost Roadmap x');
  });

  it('leaves work-item and person tokens as they were', () => {
    const { container } = renderWithIntl(
      <MarkdownView value="cc [@Bo](mention:user_bo) on [Roadmap](motir-page:pg_1)" />,
    );
    expect(container.querySelector('.mention-chip')?.textContent).toBe('@Bo');
    expect(container.querySelector('.page-chip')).toBeTruthy();
  });
});
