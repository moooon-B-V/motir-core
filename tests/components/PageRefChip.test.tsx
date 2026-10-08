// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { PageRefChip } from '@/components/markdown/PageRefChip';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The live page chip (Story MOTIR-7694 · MOTIR-7698,
// `design/work-items/internal-links--page-tag.mock.html` panels 6–7).

afterEach(cleanup);

describe('PageRefChip', () => {
  it('an available page is a link to the page with its CURRENT title', () => {
    const { container } = renderWithIntl(
      <PageRefChip summary={{ state: 'available', id: 'pg_1', title: 'Roadmap Q4' }} />,
    );
    const link = container.querySelector('a.page-chip');
    expect(link?.getAttribute('href')).toBe('/pages/pg_1');
    expect(link?.textContent).toBe('Roadmap Q4');
    expect(link?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('an untitled page reads "Untitled"', () => {
    const { container } = renderWithIntl(
      <PageRefChip summary={{ state: 'available', id: 'pg_1', title: '' }} />,
    );
    expect(container.textContent).toBe('Untitled');
  });

  it('unavailable is a span saying "Page unavailable", with no link and no title anywhere', () => {
    const { container } = renderWithIntl(
      <PageRefChip summary={{ state: 'unavailable', id: 'pg_secret' }} />,
    );
    expect(container.querySelector('a')).toBeNull();
    const chip = container.querySelector('span.page-chip.is-unavailable');
    expect(chip?.textContent).toBe('Page unavailable');
    expect(chip?.getAttribute('title')).toBeNull();
    expect(container.innerHTML).not.toContain('pg_secret');
  });

  it('a missing summary renders as unavailable', () => {
    const { container } = renderWithIntl(<PageRefChip summary={undefined} />);
    expect(container.textContent).toBe('Page unavailable');
  });

  it('renders the zh string', () => {
    const { container } = renderWithIntl(<PageRefChip summary={undefined} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(container.textContent).toBe('页面不可用');
  });
});
