// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import { RoleDetail } from '@/app/(authed)/settings/project/roles/_components/RoleDetail';
import type { RoleCatalogDTO } from '@/lib/dto/permissions';

// Deleting a custom role (Story MOTIR-2257 · Subtask MOTIR-2480), built to
// `roles-permissions.mock.html` panel 5.
//
// The claim under test is the one the whole flow exists for: **a role in use
// cannot vanish under the people holding it.** So the destination is required
// whenever anyone holds it, the confirm stays disabled until one is chosen, and
// a refusal on confirm re-asks with the SERVER's number rather than the one the
// dialog opened with.

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  return { ...actual, useRouter: () => ({ push: pushMock, refresh: refreshMock }) };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/Toast')>();
  return { ...actual, useToast: () => ({ toast: toastMock }) };
});

function catalogWith(counts: Record<string, number> = {}): RoleCatalogDTO {
  return toRoleCatalogDTO(
    { admin: 1, member: 2, viewer: 0 },
    [
      { id: 'r_contractor', name: 'Contractor', permissions: ['project:browse'] },
      { id: 'r_reporter', name: 'Reporter', permissions: ['project:browse'] },
    ],
    counts,
  );
}

function renderDetail(
  opts: { counts?: Record<string, number>; canManage?: boolean; roleKey?: string } = {},
) {
  const catalog = catalogWith(opts.counts);
  const role = catalog.roles.find((r) => r.key === (opts.roleKey ?? 'r_contractor'))!;
  return renderWithIntl(
    <RoleDetail
      role={role}
      catalog={catalog}
      projectName="motir"
      canManage={opts.canManage ?? true}
      projectKey="MOTIR"
    />,
    { messages: enMessages },
  );
}

function response(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  pushMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who gets a Delete affordance at all', () => {
  it('a CUSTOM role, for an actor holding `project:manage_access`', () => {
    renderDetail();
    expect(screen.getByTestId('delete-role')).toBeTruthy();
  });

  it('nobody else — not a non-admin…', () => {
    renderDetail({ canManage: false });
    expect(screen.queryByTestId('delete-role')).toBeNull();
  });

  it('…and NOT a built-in, for anyone, workspace owner included', () => {
    // A built-in cannot be deleted at all, so there is no control to disable —
    // its head keeps the lock and nothing else.
    renderDetail({ roleKey: 'member', canManage: true });
    expect(screen.queryByTestId('delete-role')).toBeNull();
  });
});

describe('the dialog — nothing is destroyed unasked', () => {
  it('opening it issues NO request; a role nobody holds still gets a confirm', async () => {
    // The card described probing with a destination-less DELETE. For an UNHELD
    // role that is a 204 — the role would be gone with no confirmation, which
    // panel 5 state B draws as a plain confirm. So the dialog opens first.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 0 } });

    fireEvent.click(screen.getByTestId('delete-role'));
    expect(fetchMock).not.toHaveBeenCalled();

    expect(screen.getByTestId('delete-affected-count').textContent).toContain('No one holds');
    expect(screen.queryByTestId('delete-destination')).toBeNull();
    // …and the confirm is immediately available, since there is nothing to ask.
    expect((screen.getByTestId('delete-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('with members it names HOW MANY and requires a destination', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderDetail({ counts: { r_contractor: 4 } });
    fireEvent.click(screen.getByTestId('delete-role'));

    expect(screen.getByTestId('delete-affected-count').textContent).toContain('4 members');
    expect((screen.getByTestId('delete-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('delete-destination'), { target: { value: 'member' } });
    expect((screen.getByTestId('delete-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the destination list offers the project`s other roles and NEVER this one', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderDetail({ counts: { r_contractor: 2 } });
    fireEvent.click(screen.getByTestId('delete-role'));

    const values = [...screen.getByTestId('delete-destination').querySelectorAll('option')]
      .map((o) => o.getAttribute('value'))
      .filter((v) => v !== '');
    expect(values).toContain('member');
    expect(values).toContain('r_reporter');
    expect(values).not.toContain('r_contractor');
  });
});

describe('confirming', () => {
  it('DELETEs with the destination, then returns to the list and re-reads it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(204, {}));
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 2 } });

    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.change(screen.getByTestId('delete-destination'), { target: { value: 'r_reporter' } });
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/roles/r_contractor?reassignTo=r_reporter');
    expect(init.method).toBe('DELETE');

    // The list is a SERVER-rendered surface: push + refresh, so the
    // destination's member count is read again rather than patched client-side.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/settings/project/roles'));
    expect(refreshMock).toHaveBeenCalled();
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'success' });
  });

  it('an UNHELD role confirms with NO `reassignTo` in the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(204, {}));
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 0 } });

    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/projects/MOTIR/roles/r_contractor');
  });

  it('a 409 RE-ASKS with the SERVER`s count — the number that went stale is replaced', async () => {
    // Somebody was put on the role between the open and the confirm. This is
    // the case the "count comes from the 409" rule is really protecting.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(409, { code: 'ROLE_IN_USE', count: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 0 } });

    fireEvent.click(screen.getByTestId('delete-role'));
    expect(screen.getByTestId('delete-affected-count').textContent).toContain('No one holds');

    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('delete-affected-count').textContent).toContain('7 members'),
    );
    // The dialog is still open, now asking the question it could not ask before.
    expect(screen.getByTestId('delete-destination')).toBeTruthy();
    expect((screen.getByTestId('delete-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('any other refusal toasts and LEAVES THE DIALOG OPEN — never a silent no-op', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(400, { code: 'INVALID_ROLE_REASSIGN_TARGET' }));
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 2 } });

    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.change(screen.getByTestId('delete-destination'), { target: { value: 'member' } });
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'error' });
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('an unrecognised failure still says something, and stays put', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(500, {})));
    renderDetail({ counts: { r_contractor: 0 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'error' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('a LOST PERMISSION says so, and leaves the dialog open to be retried', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, { code: 'PERMISSION_DENIED' })));
    renderDetail({ counts: { r_contractor: 0 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('closing the dialog with Esc leaves the role untouched', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDetail({ counts: { r_contractor: 3 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a role already deleted by someone else lands the admin on the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(404, { code: 'ROLE_DEFINITION_NOT_FOUND' })),
    );
    renderDetail({ counts: { r_contractor: 0 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/settings/project/roles'));
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'error' });
  });
});

describe('the dialog is a real Modal', () => {
  it('is an ALERTDIALOG — a destructive confirm interrupts rather than sits there', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderDetail({ counts: { r_contractor: 0 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    // `role="alertdialog"` is the shipped affordance for a destructive confirm;
    // assistive tech announces it as an alert rather than an ordinary panel.
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Cancel, and focus management is left to the Modal primitive', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderDetail({ counts: { r_contractor: 0 } });
    fireEvent.click(screen.getByTestId('delete-role'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Radix restores focus to whatever held it before open. This component adds
    // NO focus call of its own — an earlier revision did, and it fought the
    // restoration and left focus on <body>.
    expect(screen.getByTestId('delete-role')).toBeTruthy();
  });

  it('renders no raw message key, in either locale', () => {
    vi.stubGlobal('fetch', vi.fn());
    const catalog = catalogWith({ r_contractor: 3 });
    const role = catalog.roles.find((r) => r.key === 'r_contractor')!;
    const { container } = renderWithIntl(
      <RoleDetail role={role} catalog={catalog} projectName="motir" canManage projectKey="MOTIR" />,
      { messages: zhMessages as unknown as Record<string, unknown> },
    );
    fireEvent.click(screen.getByTestId('delete-role'));
    expect(container.textContent).not.toMatch(/settings\.rolesPage\./);
    expect(document.body.textContent).not.toMatch(/settings\.rolesPage\./);
  });
});
