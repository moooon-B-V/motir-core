// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { DeleteOrganizationControl } from '@/app/(authed)/settings/organization/_components/DeleteOrganizationDialog';
import { CancelOrganizationDeletionControl } from '@/app/(authed)/settings/organization/_components/CancelOrganizationDeletionControl';
import { TransferOwnershipControl } from '@/app/(authed)/settings/organization/_components/TransferOwnershipControl';
import type { OrganizationDeletionConsequencesDTO } from '@/lib/dto/organizationDeletion';

// The Owner's Delete organization dialog, its Cancel deletion confirm, and
// Transfer while closing (Story MOTIR-6306 · MOTIR-6402, design MOTIR-6390 panels
// 1–4 and 7). The HTTP calls are the components' boundary, so `fetch` is stubbed;
// the server half — the name, the step-up, the lock — is MOTIR-6399's.
//
// Page state after each mutation is a `router.refresh()` (CLAUDE.md case 2: the
// Danger zone and the closing bar are server-rendered), asserted below.

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }));
const signOut = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/auth/client', () => ({ signOut }));

const ORG = 'acme';

function consequences(
  over: Partial<OrganizationDeletionConsequencesDTO> = {},
): OrganizationDeletionConsequencesDTO {
  return {
    workspaceNames: ['Engineering', 'Sales'],
    projectCount: 12,
    memberCount: 14,
    hostedRepos: [
      { id: 'r1', fullName: 'motir-hosted/web' },
      { id: 'r2', fullName: 'motir-hosted/api' },
    ],
    erasureDueAt: '2026-10-26T12:00:00.000Z',
    hasPassword: true,
    signedInRecently: false,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
function installFetch(status: number, body: unknown = {}) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
}

function renderDialog(c = consequences()) {
  return render(
    <ToastProvider>
      <DeleteOrganizationControl orgId="org1" orgName={ORG} consequences={c} initialOpen={false} />
    </ToastProvider>,
  );
}

function openStep2() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete organization…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

const scheduleButton = () => screen.getByRole('button', { name: 'Schedule deletion' });

beforeEach(() => {
  refresh.mockReset();
  replace.mockReset();
  signOut.mockClear();
  installFetch(200, {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('step 1 — what will be deleted (panel 2)', () => {
  it('lists the server-read counts, the hosted repositories with Take over, and the date', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete organization…' }));

    const list = screen.getByTestId('org-deletion-consequences');
    expect(list.textContent).toContain('2 workspaces, 12 projects');
    expect(list.textContent).toContain('Engineering · Sales');
    expect(list.textContent).toContain('14 members');
    expect(list.textContent).toContain('2 repositories Motir hosts');
    expect(list.textContent).toContain('motir-hosted/web');
    expect(screen.getAllByRole('link', { name: 'Take over' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Download your data' }).getAttribute('href')).toBe(
      '/settings/account/data',
    );
    expect(screen.getByText(/Everything is erased on Oct 26, 2026\./)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits the hosted-repositories row when Motir hosts none', () => {
    renderDialog(consequences({ hostedRepos: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete organization…' }));
    expect(screen.queryByText(/repositories Motir hosts/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Take over' })).toBeNull();
  });
});

describe('step 2 — confirm it’s you (panel 3)', () => {
  it('keeps Schedule deletion disabled until the exact name AND the password are given (3a–3c)', () => {
    renderDialog();
    openStep2();
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: 'acm' } });
    expect(screen.getByText('That isn’t this organization’s name.')).toBeTruthy();
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('schedules with the name and password, closes, and re-reads the page from the server', async () => {
    renderDialog();
    openStep2();
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(scheduleButton());

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/organizations/org1/deletion');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      confirmName: ORG,
      password: 'pw',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a wrong password shows the step-up error and schedules nothing (3d)', async () => {
    installFetch(403, { code: 'STEP_UP_FAILED', reason: 'wrong_password' });
    renderDialog();
    openStep2();
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'nope' } });
    fireEvent.click(scheduleButton());

    expect((await screen.findByRole('alert')).textContent).toContain(
      'That password isn’t right. Nothing was scheduled — try again.',
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('an already-scheduled refusal says so', async () => {
    installFetch(409, { code: 'ORGANIZATION_DELETION_ALREADY_SCHEDULED' });
    renderDialog();
    openStep2();
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(scheduleButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'A deletion is already scheduled for acme.',
    );
  });

  it('a passwordless account signed in long ago is asked to sign in again (3e)', async () => {
    renderDialog(consequences({ hasPassword: false, signedInRecently: false }));
    openStep2();
    expect(screen.queryByLabelText('Your password')).toBeNull();
    expect(screen.getByTestId('org-deletion-reauth').textContent).toContain(
      'Sign in again to confirm.',
    );
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(true);

    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]![0]).toBe(
      `/sign-in?next=${encodeURIComponent('/settings/organization?dialog=delete-organization')}`,
    );
  });

  it('a passwordless account signed in recently is gated by the name alone', () => {
    renderDialog(consequences({ hasPassword: false, signedInRecently: true }));
    openStep2();
    expect(screen.queryByTestId('org-deletion-reauth')).toBeNull();
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: ORG } });
    expect((scheduleButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('Back returns to step 1', () => {
    renderDialog();
    openStep2();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('org-deletion-consequences')).toBeTruthy();
  });
});

describe('Cancel deletion (panels 4b and 7)', () => {
  function renderCancel() {
    return render(
      <ToastProvider>
        <CancelOrganizationDeletionControl orgId="org1" orgName={ORG} />
      </ToastProvider>,
    );
  }

  it('confirms, DELETEs, toasts and re-reads the page from the server', async () => {
    renderCancel();
    fireEvent.click(screen.getByTestId('org-deletion-cancel'));
    expect(screen.getByRole('dialog', { name: 'Cancel the deletion of acme?' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Cancel deletion',
      )!,
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/organizations/org1/deletion');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    expect(
      await screen.findByText(
        'Deletion cancelled. acme is back to normal, and everyone has been told.',
      ),
    ).toBeTruthy();
  });

  it('Keep it scheduled closes without a call', () => {
    renderCancel();
    fireEvent.click(screen.getByTestId('org-deletion-cancel'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it scheduled' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Transfer while closing (panel 4)', () => {
  it('renders disabled with its reason, and cannot open', () => {
    render(
      <ToastProvider>
        <TransferOwnershipControl
          orgId="org1"
          orgName={ORG}
          initialOpen
          disabledReason="Cancel the deletion to transfer ownership."
        />
      </ToastProvider>,
    );
    expect(
      (screen.getByRole('button', { name: 'Transfer ownership…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Cancel the deletion to transfer ownership.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
