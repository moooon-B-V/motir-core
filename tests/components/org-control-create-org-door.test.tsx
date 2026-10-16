// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import type { OrganizationDTO } from '@/lib/dto/organizations';

// MOTIR-8779 — the org menu's "Create organization" door. It used to sit inside
// the "Switch organization" section, which renders only at ≥2 orgs, so an
// account with ONE org — every invited Member, who owns none and is owed their
// first one free — could never reach it, and a Member's org control was a bare
// label with no menu at all. The door now follows the server's §4.5 answer
// (`canCreateOrganization`), at any org count, and a refusal at the quota is
// RETURNED by the action and told to the reader rather than thrown as a 500.

const { refresh, toastSpy, createOrganizationAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSpy: vi.fn(),
  createOrganizationAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/(authed)/_actions', () => ({
  createOrganizationAction,
  createWorkspaceAction: vi.fn(async () => ({ ok: true })),
  switchOrganizationAction: vi.fn(async () => undefined),
  switchWorkspaceAction: vi.fn(async () => undefined),
}));

const { OrgControl } = await import('@/app/(authed)/_components/OrgControl');

const ACME: OrganizationDTO = { id: 'org_acme', name: 'Acme', slug: 'acme', contentLanguage: 'en' };
const BEACON: OrganizationDTO = {
  id: 'org_beacon',
  name: 'Beacon',
  slug: 'beacon',
  contentLanguage: 'en',
};

function renderOrgControl({
  role,
  orgs = [ACME],
  revealed = true,
  canCreateOrganization,
}: {
  role: string;
  orgs?: OrganizationDTO[];
  revealed?: boolean;
  canCreateOrganization?: boolean;
}) {
  return render(
    <OrgControl
      activeOrg={{ id: ACME.id, name: ACME.name, role }}
      orgs={orgs}
      cloudBilling
      workspaceTierRevealed={revealed}
      canCreateOrganization={canCreateOrganization}
    />,
  );
}

const orgMenu = () => screen.queryByRole('button', { name: 'Organization menu' });
const createOrgRow = () => screen.queryByRole('button', { name: 'Create organization' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgControl — the "Create organization" door (MOTIR-8779)', () => {
  it('a MEMBER of one org who may create one gets a menu holding the door, not a label', () => {
    // Panel 3b's shape: a Member above the workspace reveal has no org row of
    // their own. Before the fix this rendered the bare name and nothing else.
    renderOrgControl({ role: 'member', canCreateOrganization: true });
    fireEvent.click(orgMenu()!);
    expect(createOrgRow()).toBeTruthy();
    // No org-tier row appears with it: the create door is the only thing a
    // Member is offered here.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(enMessages.orgAdmin.menu.switchOrg)).toBeNull();
  });

  it('the same Member at the quota keeps the plain label', () => {
    renderOrgControl({ role: 'member', canCreateOrganization: false });
    expect(orgMenu()).toBeNull();
    expect(screen.getByText('Acme')).toBeTruthy();
  });

  it('an OWNER of one org gets the door below the org rows when under quota, and not at it', () => {
    renderOrgControl({ role: 'owner', canCreateOrganization: true });
    fireEvent.click(orgMenu()!);
    expect(createOrgRow()).toBeTruthy();
    cleanup();

    renderOrgControl({ role: 'owner', canCreateOrganization: false });
    fireEvent.click(orgMenu()!);
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy();
    expect(createOrgRow()).toBeNull();
  });

  it('an account in TWO orgs gets the door only while under quota — the count no longer decides', () => {
    renderOrgControl({ role: 'owner', orgs: [ACME, BEACON], canCreateOrganization: false });
    fireEvent.click(orgMenu()!);
    expect(screen.getByRole('button', { name: /Beacon/ })).toBeTruthy();
    expect(createOrgRow()).toBeNull();
    cleanup();

    renderOrgControl({ role: 'owner', orgs: [ACME, BEACON], canCreateOrganization: true });
    fireEvent.click(orgMenu()!);
    expect(createOrgRow()).toBeTruthy();
  });

  it('creates the org and refreshes on success', async () => {
    createOrganizationAction.mockResolvedValueOnce({ ok: true, organization: BEACON });
    renderOrgControl({ role: 'member', canCreateOrganization: true });
    fireEvent.click(orgMenu()!);
    fireEvent.click(createOrgRow()!);
    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Beacon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(createOrganizationAction).toHaveBeenCalledWith('Beacon');
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a refusal at the quota is told to the reader in the catalogue sentence, and the modal stays open', async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      error: 'SERVER-SIDE ENGLISH — must never reach a reader',
      entitlement: 'organizations',
    });
    renderOrgControl({ role: 'member', canCreateOrganization: true });
    fireEvent.click(orgMenu()!);
    fireEvent.click(createOrgRow()!);
    const input = await screen.findByLabelText('Organization name');
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        variant: 'error',
        title: enMessages.errors.entitlementExceeded.organizations,
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Organization name')).toHaveProperty('value', 'Second');
  });
});
