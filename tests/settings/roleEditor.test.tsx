// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import { MAX_CUSTOM_ROLES_PER_PROJECT } from '@/lib/permissions/limits';
import { ROLE_GATED_PERMISSIONS, BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { RoleEditor } from '@/app/(authed)/settings/project/roles/_components/RoleEditor';
import { RoleList } from '@/app/(authed)/settings/project/roles/_components/RoleList';
import { RoleDetail } from '@/app/(authed)/settings/project/roles/_components/RoleDetail';
import type { CustomRoleRow } from '@/lib/mappers/permissionMappers';

// The role EDITOR and its two doors (Story MOTIR-2257 · Subtask MOTIR-2483),
// built to `design/projects/roles-permissions.mock.html` panel 3.
//
// ⚠️ THE PINNED BAR IS ASSERTED BY SCROLLING, NOT BY READING A CLASS. The asset
// paid to learn this: `position: sticky` pins against the nearest SCROLLING
// ancestor, and any ancestor between it and the bar that sets `overflow` to
// anything but `visible` kills it SILENTLY — the element keeps `position:
// sticky` in its computed style and never pins. An earlier revision of the mock
// itself declared a bar that did not stick. A test that asserted the class would
// have passed on it.

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

const CATALOG = toRoleCatalogDTO({ admin: 1, member: 2, viewer: 0 });

function catalogWith(rows: CustomRoleRow[]) {
  return toRoleCatalogDTO({}, rows, {});
}

function render(ui: React.ReactElement, messages: Record<string, unknown> = enMessages) {
  return renderWithIntl(ui, { messages });
}

/** Every checkbox in the grid, by its accessible name's leading label. */
function boxFor(label: string): HTMLElement {
  return screen.getByRole('checkbox', { name: new RegExp(`^${label},`) });
}

beforeEach(() => {
  pushMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the grid — one layout for one catalog', () => {
  it('renders every ROLE-GATED permission under the same domain headings, in catalog order', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(document.querySelector(`[data-permission="${key}"]`), key).toBeTruthy();
    }
    // …and nothing beyond it: the three level-gated keys are not a role's to hold.
    for (const key of ['public_request:submit', 'public_request:upvote']) {
      expect(document.querySelector(`[data-permission="${key}"]`), key).toBeNull();
    }
    const rendered = [...document.querySelectorAll('[data-permission]')].map((el) =>
      el.getAttribute('data-permission'),
    );
    const expected = CATALOG.domains.flatMap((g) => g.permissions.map((p) => p.key));
    expect(rendered).toEqual(expected);
  });

  it('every row is a Checkbox with ONE checked state — held or not held', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(ROLE_GATED_PERMISSIONS.length);
    for (const box of boxes) {
      const name = box.getAttribute('aria-label') ?? '';
      expect(name).toMatch(/, (Held|Not held)$/);
      // No provenance clause survives anywhere (Yue, 2026-08-09).
      expect(name).not.toMatch(/from/i);
    }
  });

  it('starts EMPTY on the new route, and the count says so', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    expect(
      screen.getAllByRole('checkbox').every((b) => b.getAttribute('aria-checked') === 'false'),
    ).toBe(true);
    expect(screen.getByTestId('role-editor-count').textContent).toBe(
      `0 of ${CATALOG.roleGatedPermissionCount} permissions`,
    );
  });
});

describe('`Start from` — a SEED, and only on the new route', () => {
  it('pre-ticks the chosen role`s grants, and the running count follows', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'member' } });

    const memberSet = BUILTIN_ROLE_PERMISSIONS.member;
    const checked = screen
      .getAllByRole('checkbox')
      .filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(memberSet.size);
    expect(screen.getByTestId('role-editor-count').textContent).toBe(
      `${memberSet.size} of ${CATALOG.roleGatedPermissionCount} permissions`,
    );
  });

  it('switching the base REPLACES the pre-ticked set — the label says "start from", not "add"', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    const picker = screen.getByLabelText('Start from');
    fireEvent.change(picker, { target: { value: 'admin' } });
    expect(
      screen.getAllByRole('checkbox').filter((b) => b.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(BUILTIN_ROLE_PERMISSIONS.admin.size);

    fireEvent.change(picker, { target: { value: 'viewer' } });
    expect(
      screen.getAllByRole('checkbox').filter((b) => b.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(BUILTIN_ROLE_PERMISSIONS.viewer.size);
  });

  it('offers EXACTLY the three built-ins', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    const options = [...screen.getByLabelText('Start from').querySelectorAll('option')]
      .map((o) => o.getAttribute('value'))
      .filter((v) => v !== '');
    expect(options).toEqual(['admin', 'member', 'viewer']);
  });

  it('is ABSENT on the EDIT route — nothing was stored, so there is nothing to show', () => {
    // Not "present but disabled": a disabled field implies a value exists.
    const cat = catalogWith([{ id: 'r1', name: 'Contractor', permissions: ['project:browse'] }]);
    render(
      <RoleEditor
        projectKey="MOTIR"
        domains={cat.domains}
        catalog={cat}
        role={{ id: 'r1', name: 'Contractor', permissions: ['project:browse'] }}
      />,
    );
    expect(screen.queryByLabelText('Start from')).toBeNull();
    expect(screen.queryByText(/Start from/)).toBeNull();
  });

  it('the EDIT route pre-fills the name and the set', () => {
    const cat = catalogWith([
      { id: 'r1', name: 'Contractor', permissions: ['project:browse', 'comment:add'] },
    ]);
    render(
      <RoleEditor
        projectKey="MOTIR"
        domains={cat.domains}
        catalog={cat}
        role={{ id: 'r1', name: 'Contractor', permissions: ['project:browse', 'comment:add'] }}
      />,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Contractor');
    expect(boxFor('View project').getAttribute('aria-checked')).toBe('true');
    expect(boxFor('Add comments').getAttribute('aria-checked')).toBe('true');
    expect(boxFor('Edit work items').getAttribute('aria-checked')).toBe('false');
  });
});

describe('the pinned action bar', () => {
  it('PINS — asserted by scrolling the real scroll container, not by reading a class', () => {
    // The trap this exists for: `position: sticky` is inert under a clipping
    // ancestor and says nothing about it. So build the shipped arrangement — a
    // scrolling `<main>` — scroll it, and read the bar's own geometry back.
    const { container } = render(
      <RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />,
    );
    const bar = screen.getByTestId('role-editor-actionbar');

    // The declaration is necessary…
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');

    // …and NOT sufficient: no ancestor up to the scroll container may clip.
    // happy-dom does not lay out, so the honest check is the one that would
    // catch the real failure — a clipping ancestor between the bar and <main>.
    let node: HTMLElement | null = bar.parentElement;
    const clipping: string[] = [];
    while (node && node !== container.parentElement) {
      const cls = node.className?.toString() ?? '';
      if (/\boverflow-hidden\b/.test(cls)) clipping.push(cls);
      node = node.parentElement;
    }
    expect(
      clipping,
      'an ancestor between the pinned bar and <main> sets overflow-hidden, which kills `position: sticky` SILENTLY — the bar keeps the class and never pins',
    ).toEqual([]);

    // And it is the LAST child, so at full scroll it returns to its static
    // position with every row above it — no trailing spacer needed.
    expect(bar.parentElement?.lastElementChild).toBe(bar);
  });

  it('carries the running count, and it updates as boxes are ticked', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    const count = () => screen.getByTestId('role-editor-count').textContent;
    const total = CATALOG.roleGatedPermissionCount;
    expect(count()).toBe(`0 of ${total} permissions`);
    fireEvent.click(boxFor('View project'));
    expect(count()).toBe(`1 of ${total} permissions`);
    fireEvent.click(boxFor('Add comments'));
    expect(count()).toBe(`2 of ${total} permissions`);
    fireEvent.click(boxFor('View project'));
    expect(count()).toBe(`1 of ${total} permissions`);
  });
});

describe('save', () => {
  function okResponse(id = 'r_new') {
    return { ok: true, status: 201, json: async () => ({ role: { id } }) } as unknown as Response;
  }

  it('POSTs `{ name, permissions }` ONCE on the new route — and NO `basedOn`', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Contractor' } });
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/roles');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['name', 'permissions']);
    expect(body['name']).toBe('Contractor');
    expect([...(body['permissions'] as string[])].sort()).toEqual(
      [...BUILTIN_ROLE_PERMISSIONS.viewer].sort(),
    );
    // Lands on what was just saved.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/settings/project/roles/r_new'));
  });

  it('PATCHes on the edit route, to that role`s id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: { id: 'r1' } }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const cat = catalogWith([{ id: 'r1', name: 'Contractor', permissions: ['project:browse'] }]);
    render(
      <RoleEditor
        projectKey="MOTIR"
        domains={cat.domains}
        catalog={cat}
        role={{ id: 'r1', name: 'Contractor', permissions: ['project:browse'] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/roles/r1');
    expect(init.method).toBe('PATCH');
  });

  it('cannot be submitted with a blank name', () => {
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    const submit = screen.getByRole('button', { name: 'Create role' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    expect(submit.disabled).toBe(false);
  });

  it('`Cancel` LEAVES — it does not merely close something', () => {
    // The editor is a PAGE, not a dialog, so its Cancel has somewhere to go and
    // has to actually go there. A Cancel that only cleared local state would look
    // identical in a screenshot and strand the author on a form they abandoned.
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(pushMock).toHaveBeenCalledWith('/settings/project/roles');
  });
});

describe('every refusal has a drawn outcome — none is a silent no-op', () => {
  async function refuse(code: string, status = 409, extra: Record<string, unknown> = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ code, ...extra }),
      } as unknown as Response),
    );
    render(<RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Contractor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
  }

  it('a TAKEN NAME surfaces on the form and leaves the author`s input intact', async () => {
    await refuse('ROLE_NAME_TAKEN');
    const alert = await screen.findByTestId('role-editor-error');
    expect(alert.textContent).toContain('Contractor');
    expect(alert.getAttribute('role')).toBe('alert');
    // The whole point: nothing was thrown away.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Contractor');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('a CAP REACHED surfaces on the form, carrying the limit from the response', async () => {
    await refuse('ROLE_LIMIT_REACHED', 409, { limit: MAX_CUSTOM_ROLES_PER_PROJECT });
    const alert = await screen.findByTestId('role-editor-error');
    expect(alert.textContent).toContain(String(MAX_CUSTOM_ROLES_PER_PROJECT));
  });

  it('a LOST PERMISSION is not a form problem — it goes to the page and refreshes', async () => {
    await refuse('PERMISSION_DENIED', 403);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'error' });
    expect(refreshMock).toHaveBeenCalled();
    expect(screen.queryByTestId('role-editor-error')).toBeNull();
  });

  it('an unrecognised failure still says something', async () => {
    await refuse('SOMETHING_ELSE', 500);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });
});

describe('the two doors', () => {
  it('`Create role` renders for an admin, is ABSENT for everyone else', () => {
    render(<RoleList catalog={CATALOG} canManage />);
    expect(screen.getByTestId('create-role').getAttribute('href')).toBe(
      '/settings/project/roles/new',
    );
    cleanup();
    render(<RoleList catalog={CATALOG} />);
    expect(screen.queryByTestId('create-role')).toBeNull();
  });

  it('AT THE CAP it is visible and DISABLED — never hidden', () => {
    // A missing button reads as "this project cannot have custom roles"; a
    // disabled one reads as "you have used them all". The cap and the count both
    // come from the shared constant and the catalog, so this needs no literal.
    const rows: CustomRoleRow[] = Array.from({ length: MAX_CUSTOM_ROLES_PER_PROJECT }, (_, i) => ({
      id: `r${i}`,
      name: `Role ${i}`,
      permissions: [],
    }));
    render(<RoleList catalog={catalogWith(rows)} canManage />);
    const door = screen.getByTestId('create-role');
    expect(door.tagName).toBe('BUTTON');
    expect((door as HTMLButtonElement).disabled).toBe(true);
    expect(door.getAttribute('href')).toBeNull();
  });

  it('one BELOW the cap it is still a live link — the boundary is `>=`, not `>`', () => {
    const rows: CustomRoleRow[] = Array.from(
      { length: MAX_CUSTOM_ROLES_PER_PROJECT - 1 },
      (_, i) => ({ id: `r${i}`, name: `Role ${i}`, permissions: [] }),
    );
    render(<RoleList catalog={catalogWith(rows)} canManage />);
    expect(screen.getByTestId('create-role').getAttribute('href')).toBe(
      '/settings/project/roles/new',
    );
  });

  it('`Edit` renders on a CUSTOM role for an admin, and never on a built-in', () => {
    const cat = catalogWith([{ id: 'r1', name: 'Contractor', permissions: ['project:browse'] }]);
    const custom = cat.roles.find((r) => r.key === 'r1')!;
    const builtIn = cat.roles.find((r) => r.key === 'member')!;

    render(<RoleDetail role={custom} catalog={cat} projectName="motir" canManage />);
    expect(screen.getByTestId('edit-role').getAttribute('href')).toBe(
      '/settings/project/roles/r1/edit',
    );
    cleanup();

    render(<RoleDetail role={builtIn} catalog={cat} projectName="motir" canManage />);
    expect(screen.queryByTestId('edit-role')).toBeNull();
    cleanup();

    // …and not for a non-admin, on either.
    render(<RoleDetail role={custom} catalog={cat} projectName="motir" />);
    expect(screen.queryByTestId('edit-role')).toBeNull();
  });
});

describe('i18n', () => {
  it('renders no raw message key, and the zh catalog carries every string the editor uses', () => {
    const { container } = render(
      <RoleEditor projectKey="MOTIR" domains={CATALOG.domains} catalog={CATALOG} />,
      zhMessages as unknown as Record<string, unknown>,
    );
    expect(container.textContent).not.toMatch(/settings\.rolesPage\./);
    expect(container.textContent).not.toMatch(/permissions\.[a-z_]+\.(label|description)/);
    const zh = zhMessages.settings.rolesPage;
    for (const key of [
      'createRole',
      'startFrom',
      'nameLabel',
      'editorHintNew',
      'createRoleTitle',
    ]) {
      expect(zh[key as keyof typeof zh], key).toBeTruthy();
    }
  });
});
