// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectMembersSettings } from '@/app/(authed)/settings/project/members/_components/ProjectMembersSettings';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// ProjectMembersSettings (Subtask 6.4.5) — the project-settings Members +
// Access UI. Drives the 6.4.4 REST API via global fetch (stubbed) and asserts
// the optimistic add/remove/role/access flows + the read-only (non-admin) view.

const SELF = 'u-self';

const members: ProjectMemberDTO[] = [
  { userId: SELF, name: 'Zhu Yue', email: 'zhuyue@prodect.co', role: 'admin' },
  { userId: 'u-bob', name: 'Bo Philips', email: 'bophilips@prodect.co', role: 'member' },
  { userId: 'u-odie', name: 'Odie', email: 'odie@prodect.co', role: 'viewer' },
];

const workspaceMembers: WorkspaceMemberDTO[] = [
  ...members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: 'member' })),
  { userId: 'u-julian', name: 'Julian', email: 'julian@prodect.co', role: 'member' },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Default: echo a generic OK so the optimistic path resolves; specific tests
  // override per-call.
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAdmin(overrides: Partial<React.ComponentProps<typeof ProjectMembersSettings>> = {}) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectMembersSettings
        projectKey="PROD"
        projectName="prodect"
        workspaceName="moooon"
        accessLevel="private"
        members={members}
        workspaceMembers={workspaceMembers}
        currentUserId={SELF}
        canManage
        {...overrides}
      />
    </ToastProvider>,
  );
}

describe('ProjectMembersSettings (6.4.5)', () => {
  it('renders the access radios (current level checked) + member rows with edit affordances', () => {
    renderAdmin();
    // Three access levels, Private is the selected radio.
    expect(screen.getByRole('radio', { name: /Open/ })).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: /Private/ }) as HTMLElement).getAttribute('aria-checked'),
    ).toBe('true');
    // Members are listed; the add-member picker + a per-row role select render.
    expect(screen.getByText('Bo Philips')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Add a project member' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Role for Bo Philips' })).toBeTruthy();
    // The current user's own row is not editable (role chip, no select/Remove).
    expect(screen.queryByRole('combobox', { name: 'Role for Zhu Yue' })).toBeNull();
  });

  it('adding a member POSTs and optimistically appends the row', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        member: { userId: 'u-julian', name: 'Julian', email: 'julian@prodect.co', role: 'member' },
      }),
    });
    renderAdmin({ accessLevel: 'open', members });

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a project member' }));
    fireEvent.click(await screen.findByRole('option', { name: /Julian/ }));

    await waitFor(() => expect(screen.getByText('Julian')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/PROD/members',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ userId: 'u-julian', role: 'member' });
  });

  it('removing a member DELETEs and optimistically drops the row', async () => {
    renderAdmin();
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    // The first Remove belongs to Bo Philips (self has none).
    fireEvent.click(removeButtons[0]!);
    await waitFor(() => expect(screen.queryByText('Bo Philips')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/PROD/members/u-bob',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('changing a role PATCHes the member sub-resource', async () => {
    renderAdmin();
    fireEvent.click(screen.getByRole('combobox', { name: 'Role for Odie' }));
    fireEvent.click(await screen.findByRole('option', { name: /Admin/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/members/u-odie',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ role: 'admin' });
  });

  it('selecting Private PATCHes access and seeds workspace members locally', async () => {
    renderAdmin({ accessLevel: 'open', members: [members[0]!] });
    // Only the admin is on the project to start.
    expect(screen.queryByText('Julian')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Private/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/access',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ accessLevel: 'private' });
    // The go-private note + the seeded members render.
    expect(screen.getByText('Julian')).toBeTruthy();
    expect(screen.getByText('Bo Philips')).toBeTruthy();
  });

  it('restores the row and surfaces the last-admin message when a remove is rejected', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'LAST_PROJECT_ADMIN' }),
    });
    // A project with two admins so both have a Remove button; reject the call.
    const twoAdmins: ProjectMemberDTO[] = [
      members[0]!,
      { userId: 'u-bob', name: 'Bo Philips', email: 'bophilips@prodect.co', role: 'admin' },
    ];
    renderAdmin({ members: twoAdmins });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    // Optimistically removed, then restored on the rejection.
    await waitFor(() => expect(screen.getByText('Bo Philips')).toBeTruthy());
    expect(
      screen.getByText('This is the only project admin — assign another admin first.'),
    ).toBeTruthy();
  });

  it('non-admins get a read-only view (no edit affordances, role chips only)', () => {
    renderAdmin({ canManage: false });
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText('Only project admins can add members or change access.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add a project member' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Role for Bo Philips' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    // The access radios are present but disabled.
    expect((screen.getByRole('radio', { name: /Open/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
