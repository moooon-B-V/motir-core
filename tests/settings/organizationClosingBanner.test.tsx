// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { OrganizationDeletionRequestDTO } from '@/lib/dto/organizationDeletion';

// THE APP-WIDE CLOSING BAR and the read-only header note (Story MOTIR-6306 ·
// MOTIR-6403, design MOTIR-6390 panels 5, 6 and 8). Both are SERVER components
// over `organizationDeletionService`, which is the seam stubbed here; the read
// itself — any member may make it, the date from the stored row — is MOTIR-6399's
// and tested against the database there.
//
//   - the Owner's bar carries Cancel deletion; an Admin's or Member's names who
//     scheduled it and links Download your data, and carries NO Cancel;
//   - an organization that is not closing renders NOTHING (no element, so no
//     layout shift);
//   - the note says "Read-only while {org} closes", and is absent for an open org.

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const getOrganizationDeletion = vi.hoisted(() => vi.fn());
const getClosingOrganizationName = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/organizationDeletionService', () => ({
  organizationDeletionService: { getOrganizationDeletion, getClosingOrganizationName },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getLocale: async () => 'en',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

import { OrganizationClosingBanner } from '@/app/(authed)/_components/OrganizationClosingBanner';
import { OrganizationReadOnlyNote } from '@/app/(authed)/_components/OrganizationReadOnlyNote';
import { ToastProvider } from '@/components/ui/Toast';

function scheduled(): OrganizationDeletionRequestDTO {
  return {
    id: 'odr_1',
    organizationId: 'org1',
    status: 'scheduled',
    requestedByUserId: 'owner',
    requestedAt: '2026-09-25T10:00:00.000Z',
    erasureDueAt: '2026-10-25T10:00:00.000Z',
    cancelledAt: null,
    cancelledByUserId: null,
    erasedAt: null,
  };
}

async function renderBanner(isOwner: boolean) {
  const node = await OrganizationClosingBanner({
    userId: 'u1',
    organizationId: 'org1',
    orgName: 'moooon',
    isOwner,
  });
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ToastProvider>{node}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  getOrganizationDeletion.mockReset();
  getClosingOrganizationName.mockReset();
});
afterEach(() => cleanup());

describe('the closing bar', () => {
  it('the Owner’s names the stored date and carries Cancel deletion, not the export link', async () => {
    getOrganizationDeletion.mockResolvedValue({ request: scheduled(), scheduledByName: 'Yue Zhu' });
    await renderBanner(true);

    const bar = screen.getByTestId('organization-closing-banner');
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.textContent).toContain(
      'moooon is scheduled for deletion on Oct 25, 2026. It is read-only until then.',
    );
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download your data/ })).toBeNull();
    expect(getOrganizationDeletion).toHaveBeenCalledWith('org1', 'u1');
  });

  it('an Admin’s or Member’s names who scheduled it and links the export — and has NO Cancel', async () => {
    getOrganizationDeletion.mockResolvedValue({ request: scheduled(), scheduledByName: 'Yue Zhu' });
    await renderBanner(false);

    expect(screen.getByTestId('organization-closing-banner').textContent).toContain(
      'Yue Zhu scheduled moooon for deletion on Oct 25, 2026. The organization is read-only.',
    );
    expect(screen.getByRole('link', { name: /Download your data/ }).getAttribute('href')).toBe(
      '/settings/account/data',
    );
    expect(screen.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
  });

  it('renders nothing at all for an organization that is not closing', async () => {
    getOrganizationDeletion.mockResolvedValue({ request: null, scheduledByName: null });
    const node = await OrganizationClosingBanner({
      userId: 'u1',
      organizationId: 'org1',
      orgName: 'moooon',
      isOwner: true,
    });
    expect(node).toBeNull();
  });
});

describe('the read-only header note', () => {
  it('says the organization is closing', async () => {
    getClosingOrganizationName.mockResolvedValue('moooon');
    render(<>{await OrganizationReadOnlyNote({ workspaceId: 'ws1' })}</>);
    expect(screen.getByTestId('organization-read-only-note').textContent).toBe(
      'Read-only while moooon closes',
    );
    expect(getClosingOrganizationName).toHaveBeenCalledWith('ws1');
  });

  it('renders nothing for an open organization', async () => {
    getClosingOrganizationName.mockResolvedValue(null);
    expect(await OrganizationReadOnlyNote({ workspaceId: 'ws1' })).toBeNull();
  });
});
