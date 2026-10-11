// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { LanguageCard } from '@/app/(authed)/settings/account/_components/LanguageCard';

// The account Language pane's read-only Content language row (Story MOTIR-7731 ·
// MOTIR-8095 · `design/org-admin/org-admin--content-language.mock.html` panel 2).
// A plain member has no door to the org General card, so this is where they read
// the active organisation's content language: the value as text, no control; an
// owner or admin also gets a link to the control. No active organisation, no row.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));

afterEach(cleanup);

describe('LanguageCard — Content language row', () => {
  it('shows a member the value as text, with no control and no link', () => {
    render(
      <LanguageCard contentLanguage={{ orgName: 'Acme', language: 'zh', canChange: false }} />,
    );
    expect(screen.getByText('Content language · Acme')).toBeTruthy();
    expect(screen.getByText('中文').getAttribute('lang')).toBe('zh');
    // The one combobox is the Display language control.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Change in Organization settings' })).toBeNull();
  });

  it('gives an owner or admin a link to the control', () => {
    render(<LanguageCard contentLanguage={{ orgName: 'Acme', language: 'ja', canChange: true }} />);
    const link = screen.getByRole('link', { name: 'Change in Organization settings' });
    expect(link.getAttribute('href')).toBe('/settings/organization');
  });

  it('draws no row without an active organisation', () => {
    render(<LanguageCard contentLanguage={null} />);
    expect(screen.queryByText(/Content language/)).toBeNull();
  });
});
