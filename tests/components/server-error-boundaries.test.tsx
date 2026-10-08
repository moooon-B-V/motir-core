// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { locales } from '@/lib/i18n/locales';

// MOTIR-6855 (Bug MOTIR-6776 · design MOTIR-6854) — the three error boundaries.
//
// What is asserted, per boundary: the drawn copy renders; Retry calls
// `unstable_retry` (not `reset`, which would re-render the failed server segment
// from the same client state); the caught error is reported to Sentry EXACTLY
// ONCE per error instance, tagged with its digest; the reference line shows the
// digest and disappears when there is none; only the shell-less states offer
// "Go to Motir". Plus the two seams state 3 needs because it has no `next-intl`
// provider: its static copy equals the catalogs, and it picks its locale from
// `NEXT_LOCALE`.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

import AuthedError from '@/app/(authed)/error';
import AppError from '@/app/error';
import { GlobalErrorContent, useGlobalErrorLocale } from '@/components/errors/GlobalErrorContent';
import { GLOBAL_ERROR_COPY } from '@/components/errors/serverErrorCopy';
import { ErrorReference } from '@/components/errors/ErrorReference';
import { ErrorState } from '@motir/design-system';

function digestError(digest?: string): Error & { digest?: string } {
  const error = new Error('An error occurred in the Server Components render.') as Error & {
    digest?: string;
  };
  if (digest) error.digest = digest;
  return error;
}

beforeEach(() => {
  captureException.mockReset();
});
afterEach(() => {
  cleanup();
  document.cookie = 'NEXT_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('app/(authed)/error.tsx — state 1, a page failed inside the shell', () => {
  it('renders the page copy, retries through unstable_retry, and draws no second door', () => {
    const unstable_retry = vi.fn();
    renderWithIntl(<AuthedError error={digestError('3a91f0c2')} unstable_retry={unstable_retry} />);

    expect(screen.getByRole('alert').textContent).toMatch(enMessages.errors.serverError.pageTitle);
    expect(screen.queryByRole('link', { name: enMessages.errors.notFound.homeAction })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: enMessages.common.retry }));
    expect(unstable_retry).toHaveBeenCalledTimes(1);
  });

  it('reports the caught error to Sentry once, tagged with its digest, across re-renders', () => {
    const error = digestError('3a91f0c2');
    const { rerender } = renderWithIntl(<AuthedError error={error} unstable_retry={vi.fn()} />);
    rerender(<AuthedError error={error} unstable_retry={vi.fn()} />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { boundary: 'error-boundary:authed-page', digest: '3a91f0c2' },
    });
  });

  it('reports a retry that failed again as a NEW failure with its new reference', () => {
    const { rerender } = renderWithIntl(
      <AuthedError error={digestError('3a91f0c2')} unstable_retry={vi.fn()} />,
    );
    rerender(<AuthedError error={digestError('b07e4d19')} unstable_retry={vi.fn()} />);

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(screen.getByText('b07e4d19')).toBeTruthy();
    expect(screen.queryByText('3a91f0c2')).toBeNull();
  });

  it('shows no reference line for an error that carries no digest', () => {
    renderWithIntl(<AuthedError error={digestError()} unstable_retry={vi.fn()} />);
    expect(screen.queryByText(enMessages.errors.serverError.reference)).toBeNull();
  });
});

describe('app/error.tsx — state 2, the signed-in shell failed', () => {
  it('renders the app copy, the digest, and Go to Motir as a document link to /', () => {
    const unstable_retry = vi.fn();
    renderWithIntl(<AppError error={digestError('3a91f0c2')} unstable_retry={unstable_retry} />);

    expect(screen.getByRole('alert').textContent).toMatch(enMessages.errors.serverError.appTitle);
    expect(
      screen
        .getByRole('link', { name: enMessages.errors.notFound.homeAction })
        .getAttribute('href'),
    ).toBe('/');
    expect(screen.getByText('3a91f0c2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: enMessages.common.retry }));
    expect(unstable_retry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { boundary: 'error-boundary:app', digest: '3a91f0c2' },
    });
  });

  it('renders in zh from the zh catalog', () => {
    renderWithIntl(<AppError error={digestError('3a91f0c2')} unstable_retry={vi.fn()} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByRole('alert').textContent).toMatch(zhMessages.errors.serverError.appTitle);
    expect(screen.getByRole('button', { name: zhMessages.common.retry })).toBeTruthy();
  });
});

describe('app/global-error.tsx — state 3, the root failed (no next-intl provider)', () => {
  it('renders with NO intl provider, reports once, and offers Go to Motir', () => {
    const unstable_retry = vi.fn();
    render(
      <GlobalErrorContent
        error={digestError('3a91f0c2')}
        unstable_retry={unstable_retry}
        locale="en"
      />,
    );

    expect(screen.getByRole('alert').textContent).toMatch(GLOBAL_ERROR_COPY.en.title);
    expect(screen.getByRole('link', { name: GLOBAL_ERROR_COPY.en.home }).getAttribute('href')).toBe(
      '/',
    );
    fireEvent.click(screen.getByRole('button', { name: GLOBAL_ERROR_COPY.en.retry }));
    expect(unstable_retry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { boundary: 'error-boundary:global', digest: '3a91f0c2' },
    });
  });

  it('picks zh from the NEXT_LOCALE cookie and en otherwise', () => {
    function Probe() {
      return <span data-testid="locale">{useGlobalErrorLocale()}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('locale').textContent).toMatch(/^(en|zh)$/);
    unmount();

    document.cookie = 'NEXT_LOCALE=zh';
    render(<Probe />);
    expect(screen.getByTestId('locale').textContent).toMatch('zh');
  });

  // MOTIR-7757: with no cookie the browser's WHOLE preference list is matched the
  // way the server's step 3 matches Accept-Language, so a regional variant lands
  // on its base language instead of falling through to English.
  it('matches the browser preference list when there is no cookie (pt-BR → pt)', () => {
    const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR', 'en']);
    try {
      function Probe() {
        return <span data-testid="locale">{useGlobalErrorLocale()}</span>;
      }
      render(<Probe />);
      expect(screen.getByTestId('locale').textContent).toBe('pt');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps its static copy equal to the catalogs, key for key, in every locale', () => {
    for (const locale of locales) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
      ) as {
        common: { retry: string };
        errors: {
          notFound: { homeAction: string };
          serverError: Record<
            'appTitle' | 'appBody' | 'retrying' | 'reference' | 'copyReference' | 'copied',
            string
          >;
        };
      };
      const s = messages.errors.serverError;
      expect(GLOBAL_ERROR_COPY[locale]).toEqual({
        title: s.appTitle,
        body: s.appBody,
        retry: messages.common.retry,
        retrying: s.retrying,
        home: messages.errors.notFound.homeAction,
        reference: s.reference,
        copyReference: s.copyReference,
        copied: s.copied,
      });
    }
  });
});

describe('the pieces the boundaries compose', () => {
  it('ErrorState retryPending puts the retry button in its loading state with the pending label', () => {
    render(
      <ErrorState
        title="t"
        retry={vi.fn()}
        retryLabel="Try again"
        retryPending
        retryPendingLabel="Trying again…"
      />,
    );
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('ErrorReference copies the digest and confirms with a status', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <ErrorReference
        digest="3a91f0c2"
        label="Reference"
        copyLabel="Copy reference"
        copiedLabel="Copied"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    });
    expect(writeText).toHaveBeenCalledWith('3a91f0c2');
    expect(screen.getByRole('status').textContent).toMatch('Copied');
  });
});
