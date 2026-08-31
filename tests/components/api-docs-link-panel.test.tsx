// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiDocsLinkPanel } from '@/app/(authed)/settings/account/_components/ApiDocsLinkPanel';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

describe('the in-app API documentation door', () => {
  it('links a reader who just minted a token to the reference and the guide', async () => {
    render(await ApiDocsLinkPanel());

    expect(screen.getByText('doorHeading')).toBeTruthy();
    expect(screen.getByText('doorReferenceCta').closest('a')?.getAttribute('href')).toBe(
      '/docs/api',
    );
    expect(screen.getByText('navGettingStarted').closest('a')?.getAttribute('href')).toBe(
      '/docs/api/getting-started',
    );
  });
});
