// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectMembersSettings } from '@/app/(authed)/settings/project/members/_components/ProjectMembersSettings';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { RoleDTO } from '@/lib/dto/permissions';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// ProjectMembersSettings (Subtask 6.4.5) — the project-settings Members +
// Access UI. Drives the 6.4.4 REST API via global fetch (stubbed) and asserts
// the optimistic add/remove/role/access flows + the read-only (non-admin) view.

// The access write also refreshes the server-rendered shell header build-in-public
// slot (Subtask 6.17.7) via router.refresh() — mock next/navigation so the
// component's useRouter() resolves in happy-dom, and so the refresh is assertable.
const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

const SELF = 'u-self';

// What `publicProjectUrl('PROD')` answers once `MOTIR_PUBLIC_SITE_URL` is
// configured — the value the server page threads in (MOTIR-4242).
const PUBLIC_PAGE_URL = 'https://motir.co/p/PROD';

const members: ProjectMemberDTO[] = [
  { userId: SELF, name: 'Zhu Yue', email: 'zhuyue@motir.co', role: 'admin', roleDefinition: null },
  {
    userId: 'u-bob',
    name: 'Bo Philips',
    email: 'bophilips@motir.co',
    role: 'member',
    roleDefinition: null,
  },
  { userId: 'u-odie', name: 'Odie', email: 'odie@motir.co', role: 'viewer', roleDefinition: null },
];

// The role catalog the page passes down (MOTIR-2485). `builtIn` roles carry a
// labelKey and no name; a custom role is the mirror image — which is exactly the
// split the picker and the chip have to get right.
function builtInRole(role: 'admin' | 'member' | 'viewer'): RoleDTO {
  return {
    key: role,
    builtInRole: role,
    labelKey: `settings.roles.${role}.name`,
    descriptionKey: `settings.roles.${role}.description`,
    name: null,
    description: null,
    builtIn: true,
    permissions: [],
    memberCount: 0,
  };
}
function customRole(id: string, name: string): RoleDTO {
  return {
    key: id,
    builtInRole: null,
    labelKey: null,
    descriptionKey: null,
    name,
    description: null,
    builtIn: false,
    permissions: [],
    memberCount: 0,
  };
}
const BUILT_IN_ROLES: RoleDTO[] = [
  builtInRole('admin'),
  builtInRole('member'),
  builtInRole('viewer'),
];
const CONTRACTOR = customRole('role-contractor', 'Contractor');

const workspaceMembers: WorkspaceMemberDTO[] = [
  ...members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: 'member' })),
  { userId: 'u-julian', name: 'Julian', email: 'julian@motir.co', role: 'member' },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refreshSpy.mockReset();
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
        projectName="motir"
        workspaceName="moooon"
        accessLevel="private"
        members={members}
        roles={BUILT_IN_ROLES}
        workspaceMembers={workspaceMembers}
        currentUserId={SELF}
        canManage
        // The cloud arm by default (MOTIR-4035) — this file's subject is the
        // 6.4.5 control, and the build gate is `cloud-gate-selector.test.tsx`'s.
        publicAccessAvailable
        // The PUBLIC SITE's address for this project, resolved on the server
        // page by `publicProjectUrl()` (MOTIR-4242). A literal here on purpose:
        // this file asserts what the room DOES with the value, and what the
        // value IS is `tests/hosting/appUrlSeam.test.ts`'s subject.
        publicPageUrl={PUBLIC_PAGE_URL}
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
        member: { userId: 'u-julian', name: 'Julian', email: 'julian@motir.co', role: 'member' },
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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: { ...members[2]!, role: 'admin' } }),
    });
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

  // ── Custom roles (Story MOTIR-2257 · Subtask MOTIR-2485) ──────────────────
  //
  // The picker's shape does not change when a project authors a role — it GROWS.
  // Both cases are asserted, because "a project with no custom roles renders
  // exactly the picker that ships today" is an acceptance criterion, not an
  // incidental property.

  it('with no custom roles the picker is the three built-ins under one heading', async () => {
    renderAdmin();
    fireEvent.click(screen.getByRole('combobox', { name: 'Role for Odie' }));
    expect(await screen.findByRole('option', { name: /Admin/ })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('Built-in')).toBeTruthy();
    expect(screen.queryByText('Custom roles')).toBeNull();
  });

  it('lists the project’s custom roles BENEATH the built-ins, each named as custom', async () => {
    renderAdmin({
      roles: [...BUILT_IN_ROLES, CONTRACTOR, customRole('role-reporter', 'Reporter')],
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Role for Odie' }));
    const options = await screen.findAllByRole('option');
    // Order is the catalog's — built-ins first, then the project's own roles.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Admin'),
      expect.stringContaining('Member'),
      expect.stringContaining('Viewer'),
      expect.stringContaining('Contractor'),
      expect.stringContaining('Reporter'),
    ]);
    // The KIND is stated in words at the point of choice, never left to a tint.
    expect(screen.getByText('Custom roles')).toBeTruthy();
    expect(options.at(-1)!.textContent).toContain('Custom role');
  });

  it('choosing a custom role PATCHes its DEFINITION ID and the row wears its name', async () => {
    const assigned: ProjectMemberDTO = {
      ...members[2]!,
      // The server pairs the columns: the tier goes to CUSTOM_ROLE_TIER and the
      // pointer names the role. The row must read the POINTER, not the tier —
      // reading the tier would draw this member as "Member".
      role: 'member',
      roleDefinition: { id: CONTRACTOR.key, name: 'Contractor' },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: assigned }),
    });
    renderAdmin({ roles: [...BUILT_IN_ROLES, CONTRACTOR] });

    fireEvent.click(screen.getByRole('combobox', { name: 'Role for Odie' }));
    fireEvent.click(await screen.findByRole('option', { name: /Contractor/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/members/u-odie',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ role: 'role-contractor' });
    // The picker now SHOWS the custom role — its `value` is the definition id,
    // so a component that keyed off `member.role` would show "Member" here.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Role for Odie' }).textContent).toContain(
        'Contractor',
      ),
    );
  });

  it('a member on a custom role wears its NAME in the read-only chip, kind in words', () => {
    renderAdmin({
      canManage: false,
      roles: [...BUILT_IN_ROLES, CONTRACTOR],
      members: [
        members[0]!,
        {
          ...members[1]!,
          role: 'member',
          roleDefinition: { id: CONTRACTOR.key, name: 'Contractor' },
        },
      ],
    });
    const chip = screen.getByRole('img', { name: 'Contractor — a custom role' });
    expect(chip.textContent).toBe('Contractor');
    // Built-in rows are untouched beside it.
    expect(screen.getByText('Admin')).toBeTruthy();
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

  it('selecting "Building in public" opens the confirm dialog and PATCHes public only on confirm', async () => {
    renderAdmin({ accessLevel: 'open', members: [members[0]!] });

    // Selecting the reframed `public` level opens the explainer/confirm (6.17.2)
    // — it must NOT write access on the bare radio click.
    fireEvent.click(screen.getByRole('radio', { name: /Building in public/ }));
    expect(screen.getByRole('button', { name: 'Start building in public' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirming fires the shipped access PATCH with the `public` enum value.
    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/access',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ accessLevel: 'public' });
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
      {
        userId: 'u-bob',
        name: 'Bo Philips',
        email: 'bophilips@motir.co',
        role: 'admin',
        roleDefinition: null,
      },
    ];
    renderAdmin({ members: twoAdmins });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    // Optimistically removed, then restored on the rejection.
    await waitFor(() => expect(screen.getByText('Bo Philips')).toBeTruthy());
    expect(
      screen.getByText('This is the only project admin — assign another admin first.'),
    ).toBeTruthy();
  });

  it('public + admin: shows the building-in-public status badge + manage row, and Stop confirms a revert to open (6.17.4)', async () => {
    renderAdmin({ accessLevel: 'public', members: [members[0]!] });
    // The status/manage row renders the live public link + a Stop action.
    expect(screen.getByRole('link', { name: 'View public page' })).toBeTruthy();
    const stop = screen.getByRole('button', { name: 'Stop' });

    // Stop opens the reverse confirm; it must NOT write access on the bare click.
    fireEvent.click(stop);
    expect(screen.getByRole('button', { name: 'Stop building in public' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirming reverts to the `open` level via the shipped access PATCH.
    fireEvent.click(screen.getByRole('button', { name: 'Stop building in public' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/access',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ accessLevel: 'open' });
    // The revert must ALSO refresh the server-rendered shell header slot so the
    // "Building in public" indicator swaps back to the CTA without a hard reload
    // (Subtask 6.17.7 — the stopping case that was previously stale).
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  });

  it('public + non-admin: shows the badge + View public page read-only, with no Stop action (6.17.4)', () => {
    renderAdmin({ accessLevel: 'public', canManage: false, members: [members[0]!] });
    expect(screen.getByRole('link', { name: 'View public page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('public + admin: the Hero & overview entry opens the Public page ROOM, with no embedded editor (MOTIR-4242)', () => {
    renderAdmin({ accessLevel: 'public', members: [members[0]!] });
    // The in-settings split editor is GONE — there is a single editing surface,
    // and since MOTIR-4171 it is the Public page room rather than the public
    // page, which motir-core no longer serves (MOTIR-3951).
    expect(screen.queryByRole('button', { name: 'Edit overview' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Project overview Markdown' })).toBeNull();
    // The entry point is an in-app link to the room. Its old target was
    // `/p/PROD?edit=1` — a 404 on this host once the public pages were deleted.
    const link = screen.getByRole('link', { name: /Edit the public page/ });
    expect(link.getAttribute('href')).toBe('/settings/project/public');
  });

  it('public + non-admin: the Hero & overview entry hides the edit link (6.16.6)', () => {
    renderAdmin({ accessLevel: 'public', canManage: false, members: [members[0]!] });
    expect(screen.queryByRole('link', { name: /Edit the public page/ })).toBeNull();
  });

  // ── MOTIR-4242 — the three addresses this room hands out ──────────────────
  //
  // All three used to be built from the APPLICATION host, and `app/(public)/p/`
  // was deleted by MOTIR-3951, so all three 404'd. The third is the one the
  // bug's own predecessor could not see: MOTIR-4171's criteria counted two
  // LINKS and its sweep reads `href`s, and the copied value is neither.

  it('public: View public page links to the PUBLIC site, and the mono path shows its host', () => {
    renderAdmin({ accessLevel: 'public', members: [members[0]!] });
    const link = screen.getByRole('link', { name: 'View public page' });
    expect(link.getAttribute('href')).toBe(PUBLIC_PAGE_URL);
    // The scheme is dropped in the displayed path, per Panel A frame 3 — the
    // reader sees WHICH SITE the link goes to.
    expect(screen.getByText('motir.co/p/PROD')).toBeTruthy();
  });

  it('public: the share field SHOWS the public site’s absolute URL', () => {
    renderAdmin({ accessLevel: 'public', members: [members[0]!] });
    expect(screen.getByText(PUBLIC_PAGE_URL)).toBeTruthy();
  });

  it('public: Copy WRITES the public site’s URL — asserted on the copied value, not the markup', async () => {
    // The assertion the href sweep structurally cannot make. Before MOTIR-4242
    // this wrote `window.location.origin + /p/PROD`; in happy-dom that is
    // `http://localhost:3000/p/PROD`, and in production `https://app.motir.co/p/PROD`
    // — the URL a customer pastes into a tweet, and a 404 either way.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    renderAdmin({ accessLevel: 'public', members: [members[0]!] });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLIC_PAGE_URL));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toContain('localhost');
    expect(copied).not.toContain('app.motir.co');
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
