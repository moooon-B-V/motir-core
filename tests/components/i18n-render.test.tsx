// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';

// End-to-end check that a translated component resolves real catalog values
// through NextIntlClientProvider in BOTH shipped locales — complements the
// key-parity guard in tests/i18n-catalog.test.ts (which only compares shapes).
// A tiny probe component exercises the same `useTranslations` path every real
// component uses.
function Probe() {
  const t = useTranslations('shell.nav');
  const tc = useTranslations('common');
  return (
    <div>
      <span data-testid="nav-issues">{t('issues')}</span>
      <span data-testid="common-save">{tc('save')}</span>
    </div>
  );
}

afterEach(cleanup);

describe('i18n rendering', () => {
  it('renders the default (en) catalog values', () => {
    renderWithIntl(<Probe />);
    expect(screen.getByTestId('nav-issues').textContent).toBe('Issues');
    expect(screen.getByTestId('common-save').textContent).toBe('Save');
  });

  it('renders native zh catalog values when the locale is zh', () => {
    renderWithIntl(<Probe />, { locale: 'zh', messages: zhMessages });
    expect(screen.getByTestId('nav-issues').textContent).toBe('问题');
    expect(screen.getByTestId('common-save').textContent).toBe('保存');
  });
});
