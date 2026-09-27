// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectMembersSettings } from '@/app/(authed)/settings/project/members/_components/ProjectMembersSettings';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';

// ProjectMembersSettings — the project's Access & members page (Subtask 6.4.5;
// the three ACCESS MODES since Story MOTIR-6169 · MOTIR-6550 and
// `design/projects/access-members--access-modes.mock.html`). Drives the REST API
// through a stubbed global fetch and asserts the mode control (with the
// Members-only preview-and-confirm), the people list with its chips, the split
// read-only states, and the build-in-public arm.

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

// A project membership carries no role since roles moved to the workspace
// (Story MOTIR-6168 · MOTIR-6464): a row is a person added to the project.
const members: ProjectMemberDTO[] = [
  { userId: SELF, name: 'Zhu Yue', email: 'zhuyue@motir.co' },
  { userId: 'u-bob', name: 'Bo Philips', email: 'bophilips@motir.co' },
  { userId: 'u-odie', name: 'Odie', email: 'odie@motir.co' },
];

const wm = (
  userId: string,
  name: string,
  over: Partial<WorkspaceMemberWithAccessDTO> = {},
): WorkspaceMemberWithAccessDTO => ({
  userId,
  name,
  email: `${name.toLowerCase().split(' ')[0]}@motir.co`,
  workspaceRole: 'member',
  customRole: null,
  accessScope: 'full',
  addedProjectCount: 1,
  ...over,
});

const workspaceMembers: WorkspaceMemberWithAccessDTO[] = [
  wm(SELF, 'Zhu Yue', { email: 'zhuyue@motir.co', workspaceRole: 'manager' }),
  wm('u-bob', 'Bo Philips', { email: 'bophilips@motir.co', accessScope: 'limited' }),
  wm('u-odie', 'Odie', { customRole: { id: 'r1', name: 'Reviewer' } }),
  wm('u-julian', 'Julian', { addedProjectCount: 0 }),
  wm('u-mia', 'Mia', { workspaceRole: 'manager', addedProjectCount: 0 }),
];

const fetchMock = vi.fn();
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });
const refused = (code = 'FORBIDDEN', status = 403) => ({
  ok: false,
  status,
  json: async () => ({ code }),
});
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const accessPatches = () =>
  fetchMock.mock.calls.filter(
    (c) =>
      c[0] === '/api/projects/PROD/access' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );

beforeEach(() => {
  fetchMock.mockReset();
  refreshSpy.mockReset();
  // Default: a generic OK; specific tests override per call.
  fetchMock.mockResolvedValue(ok());
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
        accessMode="workspace"
        members={members}
        workspaceMembers={workspaceMembers}
        currentUserId={SELF}
        canManageAccess
        canManageMembers
        // The cloud arm by default (MOTIR-4035); the self-hosted arm is its own case.
        publicAccessAvailable
        // The PUBLIC SITE's address for this project, resolved on the server
        // page by `publicProjectUrl()` (MOTIR-4242). A literal here on purpose.
        publicPageUrl={PUBLIC_PAGE_URL}
        {...overrides}
      />
    </ToastProvider>,
  );
}

// `hidden: true`: while a confirm is open, Radix hides the page behind it from
// the accessibility tree, and these assertions are about the control beneath.
const radio = (name: RegExp) =>
  screen.getByRole('radio', { name, hidden: true }) as HTMLButtonElement;

describe('the mode control (design A1)', () => {
  it('offers the three modes, the current one checked, and names it in the header pill', () => {
    renderAdmin({ accessMode: 'members' });
    expect(screen.getByRole('radiogroup', { name: 'Project access mode' })).toBeTruthy();
    expect(radio(/^Open to the workspace/).getAttribute('aria-checked')).toBe('false');
    expect(radio(/^Members only/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/^Public/).getAttribute('aria-checked')).toBe('false');
    // No level words anywhere a person can see.
    expect(screen.queryByText('Private')).toBeNull();
    expect(screen.queryByText('Building in public')).toBeNull();
  });

  it('Open to the workspace applies at once — it only ever admits more people', async () => {
    renderAdmin({ accessMode: 'members' });
    fireEvent.click(radio(/^Open to the workspace/));
    await waitFor(() => expect(accessPatches()).toHaveLength(1));
    expect(bodyOf(accessPatches()[0]!)).toEqual({ accessMode: 'workspace' });
    await waitFor(() =>
      expect(radio(/^Open to the workspace/).getAttribute('aria-checked')).toBe('true'),
    );
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('save failed: the selection stays put and the toast names the mode the project is STILL in (A8)', async () => {
    fetchMock.mockResolvedValue(refused());
    renderAdmin({ accessMode: 'members' });
    fireEvent.click(radio(/^Open to the workspace/));
    expect(await screen.findByText('motir is still Members only. Please try again.')).toBeTruthy();
    expect(radio(/^Members only/).getAttribute('aria-checked')).toBe('true');
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('the Members-only confirm (design A2 / A3)', () => {
  const losing = [
    {
      userId: 'u-julian',
      name: 'Julian',
      email: 'julian@motir.co',
      workspaceRole: 'member' as const,
      customRoleName: null,
    },
    {
      userId: 'u-ann',
      name: 'Ann',
      email: 'ann@motir.co',
      workspaceRole: 'member' as const,
      customRoleName: 'Reviewer',
    },
  ];

  it('reads the preview FIRST, lists who loses access, and PATCHes members only on confirm', async () => {
    fetchMock.mockResolvedValueOnce(ok({ losing }));
    renderAdmin();

    fireEvent.click(radio(/^Members only/));
    const dialog = await screen.findByRole('dialog', { name: 'Make motir members only?' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/PROD/access/preview?mode=members');
    // The radio does not flip, and nothing was written, until the confirm.
    expect(radio(/^Members only/).getAttribute('aria-checked')).toBe('false');
    expect(accessPatches()).toHaveLength(0);
    expect(within(dialog).getByText('2 people')).toBeTruthy();
    expect(within(dialog).getByText('Julian')).toBeTruthy();
    expect(within(dialog).getByText('ann@motir.co')).toBeTruthy();
    // Each row names the role — a custom role by its own name — and the scope.
    expect(within(dialog).getByText('Reviewer')).toBeTruthy();
    expect(within(dialog).getAllByText('Full')).toHaveLength(2);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Make members only' }));
    await waitFor(() => expect(accessPatches()).toHaveLength(1));
    expect(bodyOf(accessPatches()[0]!)).toEqual({ accessMode: 'members' });
    await waitFor(() => expect(radio(/^Members only/).getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with nobody losing access, still confirms — one sentence in place of the list', async () => {
    fetchMock.mockResolvedValueOnce(ok({ losing: [] }));
    renderAdmin();
    fireEvent.click(radio(/^Members only/));
    const dialog = await screen.findByRole('dialog', { name: 'Make motir members only?' });
    expect(
      within(dialog).getByText(
        'Nobody loses access — everyone who can open motir today was added to it or is a Manager.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('list')).toBeNull();
  });

  it('Cancel writes nothing and leaves the mode as it was', async () => {
    fetchMock.mockResolvedValueOnce(ok({ losing }));
    renderAdmin();
    fireEvent.click(radio(/^Members only/));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(accessPatches()).toHaveLength(0);
    expect(radio(/^Open to the workspace/).getAttribute('aria-checked')).toBe('true');
  });

  it('a failed preview opens no confirm, writes nothing, and says the mode is unchanged', async () => {
    fetchMock.mockResolvedValueOnce(refused('PROJECT_NOT_FOUND', 404));
    renderAdmin();
    fireEvent.click(radio(/^Members only/));
    expect(
      await screen.findByText('motir is still Open to the workspace. Please try again.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(accessPatches()).toHaveLength(0);
  });
});

describe('Public (design A10)', () => {
  it('opens the build-in-public confirm and PATCHes public only on confirm', async () => {
    renderAdmin();
    fireEvent.click(radio(/^Public/));
    expect(screen.getByRole('button', { name: 'Start building in public' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));
    await waitFor(() => expect(accessPatches()).toHaveLength(1));
    expect(bodyOf(accessPatches()[0]!)).toEqual({ accessMode: 'public' });
  });

  it('self-hosted: Public is DRAWN disabled, with the reason in text', () => {
    renderAdmin({ publicAccessAvailable: false });
    const pub = radio(/^Public/);
    expect(pub.disabled).toBe(true);
    expect(pub.getAttribute('aria-disabled')).toBe('true');
    expect(
      within(pub).getByText(
        'Publishing runs on Motir Cloud — this self-hosted install has no public site to publish to.',
      ),
    ).toBeTruthy();
    fireEvent.click(pub);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the people list (design A1 / A4 / A5)', () => {
  it('each row carries the role chip and — except for a Manager — the scope chip', () => {
    renderAdmin();
    const rowOf = (name: string) => screen.getByText(name).closest('li')!;
    // The Manager: a role chip and NO scope chip.
    expect(within(rowOf('Zhu Yue')).getByText('Manager')).toBeTruthy();
    expect(within(rowOf('Zhu Yue')).queryByText('Full')).toBeNull();
    // A Limited Member.
    expect(within(rowOf('Bo Philips')).getByText('Member')).toBeTruthy();
    expect(within(rowOf('Bo Philips')).getByText('Limited')).toBeTruthy();
    // A custom role is shown by its own name.
    expect(within(rowOf('Odie')).getByText('Reviewer')).toBeTruthy();
    expect(within(rowOf('Odie')).getByText('Full')).toBeTruthy();
  });

  it('Add people offers only workspace members not yet added — email · role · scope, and a Manager marked "always enters"', async () => {
    renderAdmin();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a project member' }));
    const julian = await screen.findByRole('option', { name: /Julian/ });
    expect(julian.textContent).toContain('julian@motir.co · Member · Full');
    expect(screen.getByRole('option', { name: /Mia/ }).textContent).toContain(
      'mia@motir.co · Manager · always enters',
    );
    expect(screen.queryByRole('option', { name: /Bo Philips/ })).toBeNull();
  });

  it('adding a person POSTs and appends the row, and never changes the mode', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        member: { userId: 'u-julian', name: 'Julian', email: 'julian@motir.co' },
      }),
    });
    renderAdmin({ accessMode: 'members' });

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a project member' }));
    fireEvent.click(await screen.findByRole('option', { name: /Julian/ }));

    await waitFor(() => expect(screen.getByText('Julian')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/PROD/members',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(bodyOf(fetchMock.mock.calls.at(-1)!)).toEqual({ userId: 'u-julian' });
    expect(accessPatches()).toHaveLength(0);
    expect(radio(/^Members only/).getAttribute('aria-checked')).toBe('true');
  });

  it('removing a person DELETEs and drops the row; a rejected remove restores it', async () => {
    renderAdmin();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(screen.queryByText('Bo Philips')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/PROD/members/u-bob',
      expect.objectContaining({ method: 'DELETE' }),
    );

    cleanup();
    fetchMock.mockResolvedValue(refused('NOT_A_PROJECT_MEMBER', 404));
    renderAdmin();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(screen.getByText('Bo Philips')).toBeTruthy());
  });

  it('a failed add takes the row back out', async () => {
    fetchMock.mockResolvedValue(refused());
    renderAdmin();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a project member' }));
    fireEvent.click(await screen.findByRole('option', { name: /Julian/ }));
    expect(await screen.findByText('Could not add member')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('julian@motir.co')).toBeNull());
  });

  it('Members only with nobody added says only Managers can open it (A4)', () => {
    renderAdmin({ accessMode: 'members', members: [] });
    expect(screen.getByText('Only Managers can open this project')).toBeTruthy();
    expect(
      screen.getByText(
        'It is members only and nobody has been added yet. Add people to let them in.',
      ),
    ).toBeTruthy();
  });
});

describe('read-only, split by key (design A6 / A7)', () => {
  it('member:manage without project:manage_access — people controls on, the mode shown as text', () => {
    renderAdmin({ canManageAccess: false, accessMode: 'members' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getAllByText('Members only').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Only a workspace Manager can change who can open this project.'),
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Add a project member' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0);
  });

  it('project:manage_access without member:manage — the mode live, the list read-only', () => {
    renderAdmin({ canManageMembers: false });
    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(radio(/^Members only/).disabled).toBe(false);
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add a project member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});

describe('the build-in-public arm (6.17 · MOTIR-4242)', () => {
  it('public + admin: shows the building-in-public status badge + manage row, and Stop confirms a revert to open (6.17.4)', async () => {
    renderAdmin({ accessMode: 'public', members: [members[0]!] });
    // The status/manage row renders the live public link + a Stop action.
    expect(screen.getByRole('link', { name: 'View public page' })).toBeTruthy();
    const stop = screen.getByRole('button', { name: 'Stop' });

    // Stop opens the reverse confirm; it must NOT write access on the bare click.
    fireEvent.click(stop);
    expect(screen.getByRole('button', { name: 'Stop building in public' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirming reverts to Workspace (the `open` level) via the access PATCH.
    fireEvent.click(screen.getByRole('button', { name: 'Stop building in public' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/access',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ accessMode: 'workspace' });
    // The revert must ALSO refresh the server-rendered shell header slot so the
    // "Building in public" indicator swaps back to the CTA without a hard reload
    // (Subtask 6.17.7 — the stopping case that was previously stale).
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  });

  it('public + non-admin: shows the badge + View public page read-only, with no Stop action (6.17.4)', () => {
    renderAdmin({
      accessMode: 'public',
      canManageAccess: false,
      canManageMembers: false,
      members: [members[0]!],
    });
    expect(screen.getByRole('link', { name: 'View public page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('public + admin: the Hero & overview entry opens the Public page ROOM, with no embedded editor (MOTIR-4242)', () => {
    renderAdmin({ accessMode: 'public', members: [members[0]!] });
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
    renderAdmin({
      accessMode: 'public',
      canManageAccess: false,
      canManageMembers: false,
      members: [members[0]!],
    });
    expect(screen.queryByRole('link', { name: /Edit the public page/ })).toBeNull();
  });

  // ── MOTIR-4242 — the three addresses this room hands out ──────────────────
  //
  // All three used to be built from the APPLICATION host, and `app/(public)/p/`
  // was deleted by MOTIR-3951, so all three 404'd. The third is the one the
  // bug's own predecessor could not see: MOTIR-4171's criteria counted two
  // LINKS and its sweep reads `href`s, and the copied value is neither.

  it('public: View public page links to the PUBLIC site, and the mono path shows its host', () => {
    renderAdmin({ accessMode: 'public', members: [members[0]!] });
    const link = screen.getByRole('link', { name: 'View public page' });
    expect(link.getAttribute('href')).toBe(PUBLIC_PAGE_URL);
    // The scheme is dropped in the displayed path, per Panel A frame 3 — the
    // reader sees WHICH SITE the link goes to.
    expect(screen.getByText('motir.co/p/PROD')).toBeTruthy();
  });

  it('public: the share field SHOWS the public site’s absolute URL', () => {
    renderAdmin({ accessMode: 'public', members: [members[0]!] });
    expect(screen.getByText(PUBLIC_PAGE_URL)).toBeTruthy();
  });

  it('public: Copy WRITES the public site’s URL — asserted on the copied value, not the markup', async () => {
    // The assertion the href sweep structurally cannot make. Before MOTIR-4242
    // this wrote `window.location.origin + /p/PROD`; in happy-dom that is
    // `http://localhost:3000/p/PROD`, and in production `https://app.motir.co/p/PROD`
    // — the URL a customer pastes into a tweet, and a 404 either way.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    renderAdmin({ accessMode: 'public', members: [members[0]!] });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLIC_PAGE_URL));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toContain('localhost');
    expect(copied).not.toContain('app.motir.co');
  });
});
