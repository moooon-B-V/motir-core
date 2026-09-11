// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';

// MOTIR-5130 — the CLIENT half. `createWorkspaceAction` now ANSWERS a §4.4 cap
// refusal with `{ ok: false, error, entitlement }` instead of throwing, and this
// asserts both doors onto it tell the reader what the answer says.
//
// There are two, which is the part the card under-counted: the org menu's "New
// workspace" (OrgControl → NameModal) and the workspace switcher's "Create
// workspace" (WorkspaceSwitcher). Before this card the first had no error arm at
// all and the second answered every failure with the generic "Could not create
// workspace" — a sentence a reader cannot tell from an outage.

const { refresh, push, toastSpy, createWorkspaceAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  toastSpy: vi.fn(),
  createWorkspaceAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/(authed)/_actions', () => ({
  createWorkspaceAction,
  createOrganizationAction: vi.fn(async () => undefined),
  switchOrganizationAction: vi.fn(async () => undefined),
  switchWorkspaceAction: vi.fn(async () => undefined),
}));

const { OrgControl } = await import('@/app/(authed)/_components/OrgControl');
const { WorkspaceSwitcher } = await import('@/app/(authed)/_components/WorkspaceSwitcher');

const ACME: OrganizationDTO = {
  id: 'org_acme',
  name: 'Acme',
  slug: 'acme',
  acceptanceVideoEnabled: true,
};
const WS: WorkspaceSummaryDTO = { id: 'ws_1', name: 'Studio', slug: 'studio' };

// The message `EntitlementExceededError('workspaces', …)` actually carries — the
// one thing a 500 could never say.
const CAP_MESSAGE = "Your plan's workspaces limit has been reached.";
const REFUSAL = { ok: false as const, error: CAP_MESSAGE, entitlement: 'workspaces' as const };

// The generic strings the refusal must NOT be reported as.
const GENERIC_WS_ERROR = enMessages.shell.workspaceSwitcher.createError;
const GENERIC_ORG_ERROR = enMessages.orgAdmin.settings.saveError;

function renderOrgControl() {
  return render(
    <OrgControl
      activeOrg={{ id: ACME.id, name: ACME.name, role: 'owner' }}
      orgs={[ACME]}
      cloudBilling={false}
    />,
  );
}

async function openOrgMenuCreateWorkspace(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));
  fireEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
  const input = await screen.findByLabelText('Workspace name');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
}

async function openSwitcherCreateWorkspace(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create workspace' }));
  const input = await screen.findByLabelText('Workspace name');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

beforeEach(() => {
  createWorkspaceAction.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the org menu — New workspace', () => {
  it('surfaces the cap refusal MESSAGE, not a generic failure', async () => {
    createWorkspaceAction.mockResolvedValue(REFUSAL);
    renderOrgControl();

    await openOrgMenuCreateWorkspace('zyx');

    await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledWith('zyx'));
    // The arm this modal did not have. The title is the SERVER's message — the
    // organisation modal's `saveError` fallback stays for a genuine throw.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: CAP_MESSAGE }),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: GENERIC_ORG_ERROR }),
    );
    // Nothing was created, so nothing is re-read.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the modal open on a refusal, so the reader can rename or cancel', async () => {
    createWorkspaceAction.mockResolvedValue(REFUSAL);
    renderOrgControl();

    await openOrgMenuCreateWorkspace('zyx');

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    // The name survives: the dialog does not vanish without an account of itself.
    expect((await screen.findByLabelText('Workspace name')) as HTMLInputElement).toHaveProperty(
      'value',
      'zyx',
    );
  });

  it('falls back to the generic message when the action THROWS', async () => {
    // A genuine fault carries no message worth showing a reader — it keeps the
    // same copy the organisation modal beside it uses.
    createWorkspaceAction.mockRejectedValue(new Error('connection terminated'));
    renderOrgControl();

    await openOrgMenuCreateWorkspace('zyx');

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: GENERIC_ORG_ERROR }),
    );
  });

  it('still closes and refreshes on success', async () => {
    createWorkspaceAction.mockResolvedValue({ ok: true, workspace: WS });
    renderOrgControl();

    await openOrgMenuCreateWorkspace('Fresh');

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText('Workspace name')).toBeNull());
  });
});

describe('the workspace switcher — Create workspace', () => {
  it('surfaces the cap refusal MESSAGE rather than "Could not create workspace"', async () => {
    createWorkspaceAction.mockResolvedValue(REFUSAL);
    render(<WorkspaceSwitcher workspaces={[WS]} activeWorkspaceId={WS.id} />);

    await openSwitcherCreateWorkspace('zyx');

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: CAP_MESSAGE }),
    );
    // The exact substitution this card is about: the generic copy is what a
    // reader cannot act on, and it must not be what they get.
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: GENERIC_WS_ERROR }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the generic message for a genuine throw', async () => {
    createWorkspaceAction.mockRejectedValue(new Error('connection terminated'));
    render(<WorkspaceSwitcher workspaces={[WS]} activeWorkspaceId={WS.id} />);

    await openSwitcherCreateWorkspace('zyx');

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: GENERIC_WS_ERROR }),
    );
  });

  it('still toasts success and refreshes on the happy path', async () => {
    createWorkspaceAction.mockResolvedValue({ ok: true, workspace: WS });
    render(<WorkspaceSwitcher workspaces={[WS]} activeWorkspaceId={WS.id} />);

    await openSwitcherCreateWorkspace('Fresh');

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        variant: 'success',
        title: enMessages.shell.workspaceSwitcher.created,
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
