// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { CreateTokenModal } from '@/app/(authed)/settings/account/_components/CreateTokenModal';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';

// The create-token modal (Story MOTIR-2572 · Subtasks MOTIR-2580 + MOTIR-2606),
// the surface the whole story exists to fix.
//
// Two properties are load-bearing here and neither is provable one layer down:
//
//   1. THE OFFER IS PER PROJECT. The picker may only offer what this actor can
//      confer in the project the token binds to, and it must show the rest
//      DISABLED with the reason — never hide it. A hidden row reads as a missing
//      feature; a locked one teaches the rule.
//   2. WHAT IS SUBMITTED MATCHES WHAT IS SHOWN. The POST body is asserted
//      against the real `fetch`, through the real `apiTokensClient`, so a key
//      renamed on either side of that seam fails here rather than in a browser.
//
// `fetch` is stubbed; nothing else is. The copy assertions read `en.json`
// rather than repeating strings, because the point of MOTIR-2579 is that this
// screen authors NO copy of its own.

const LABEL = (key: PermissionKey) =>
  (enMessages.permissions as unknown as Record<string, { label: string }>)[permissionSlug(key)]!
    .label;

// Two projects in one workspace with DIFFERENT offers — the shape that makes
// "the offer is per project" observable at all.
const ORGS: TokenScopeOrgDTO[] = [
  {
    id: 'org-1',
    name: 'Acme',
    workspaces: [
      {
        id: 'ws-1',
        name: 'Default',
        projects: [
          {
            id: 'p-lead',
            key: 'ACME',
            name: 'Acme Core',
            grantable: [...GRANTABLE_PERMISSIONS],
          },
          {
            // Where the actor is a mere member: they can browse and comment,
            // and nothing else.
            id: 'p-guest',
            key: 'GUEST',
            name: 'Guest Space',
            grantable: ['project:browse', 'comment:add'],
          },
        ],
      },
    ],
  },
];

const fetchMock = vi.fn();

function open(props: Partial<Parameters<typeof CreateTokenModal>[0]> = {}) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  renderWithIntl(
    <ToastProvider>
      <CreateTokenModal
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        scopeOrgs={ORGS}
        activeWorkspaceId="ws-1"
        {...props}
      />
    </ToastProvider>,
  );
  return { onCreated, onOpenChange };
}

function switchFor(key: PermissionKey): HTMLButtonElement {
  return screen.getByRole('switch', { name: LABEL(key) }) as HTMLButtonElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: enMessages.settings.apiTokens.createModal.submit,
  }) as HTMLButtonElement;
}

function typeLabel(value: string) {
  fireEvent.change(
    screen.getByLabelText(enMessages.settings.apiTokens.createModal.labelField, {
      exact: false,
    }),
    { target: { value } },
  );
}

function pickProject(name: string) {
  fireEvent.click(
    screen.getByRole('combobox', { name: enMessages.settings.apiTokens.createModal.projectField }),
  );
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the permission picker — one row per grantable key, and only those', () => {
  it('renders every grantable permission and no ungrantable one', () => {
    open();
    for (const key of GRANTABLE_PERMISSIONS) expect(switchFor(key)).toBeTruthy();
    // The catalog is 31 keys; only the 6 a token can exercise are offered.
    expect(screen.getAllByRole('switch').length).toBe(GRANTABLE_PERMISSIONS.length);
  });

  it('opens on the default grant — everything except the irreversible key', () => {
    open();
    for (const key of GRANTABLE_PERMISSIONS) {
      const expected = DEFAULT_TOKEN_GRANT.includes(key);
      expect(
        switchFor(key).getAttribute('aria-checked') === 'true',
        `${key} should open ${expected ? 'ON' : 'OFF'}`,
      ).toBe(expected);
    }
    expect(switchFor('work_item:delete').getAttribute('aria-checked')).toBe('false');
  });

  it('writes no copy of its own — every row is the shipped catalogue string', () => {
    open();
    for (const key of GRANTABLE_PERMISSIONS) {
      const copy = (
        enMessages.permissions as unknown as Record<string, { label: string; description: string }>
      )[permissionSlug(key)]!;
      expect(screen.getByText(copy.description)).toBeTruthy();
    }
    // …and never the raw key, which MOTIR-2579's AC forbids showing a reader.
    expect(screen.queryByText('work_item:delete')).toBeNull();
  });
});

describe('the offer is PER PROJECT', () => {
  it('locks — never hides — a permission the actor cannot confer in this project', () => {
    open();
    pickProject('Guest Space');

    // Present, disabled, and reasoned.
    for (const key of ['work_item:edit', 'work_item:delete', 'sprint:manage', 'ai:plan'] as const) {
      const sw = switchFor(key);
      expect(sw, `${key} must stay VISIBLE`).toBeTruthy();
      expect(sw.disabled, `${key} must be disabled here`).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('false');
    }
    expect(
      screen.getAllByText(enMessages.settings.apiTokens.scopes.lockedWhy).length,
    ).toBeGreaterThan(0);

    // What they CAN confer is untouched.
    expect(switchFor('project:browse').disabled).toBe(false);
    expect(switchFor('comment:add').disabled).toBe(false);
  });

  it('recomputes the offer when the project changes back', () => {
    open();
    pickProject('Guest Space');
    expect(switchFor('sprint:manage').disabled).toBe(true);
    pickProject('Acme Core');
    expect(switchFor('sprint:manage').disabled).toBe(false);
    expect(switchFor('sprint:manage').getAttribute('aria-checked')).toBe('true');
  });
});

describe('submit — what is sent matches what is shown', () => {
  function respondCreated() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'mtr_live_secret_value',
        dto: { id: 'tok-1', label: 'CI', permissions: [...DEFAULT_TOKEN_GRANT] },
      }),
    });
  }

  it('POSTs the toggled grant with the bound project, and shows the secret once', async () => {
    respondCreated();
    const { onCreated } = open();
    typeLabel('  CI  ');
    fireEvent.click(switchFor('work_item:delete')); // opt IN to the danger row
    fireEvent.click(switchFor('ai:plan')); // opt OUT of planning
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/me/api-tokens');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.label).toBe('CI'); // trimmed
    expect(body.workspaceId).toBe('ws-1');
    expect(body.projectId).toBe('p-lead');
    expect([...body.permissions].sort()).toEqual(
      [...DEFAULT_TOKEN_GRANT.filter((k) => k !== 'ai:plan'), 'work_item:delete'].sort(),
    );

    // The shown-once phase.
    const secret = await screen.findByTestId('api-token-secret');
    expect(secret.textContent).toBe('mtr_live_secret_value');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'tok-1' }));
  });

  it('never sends a permission the chosen project cannot confer', async () => {
    respondCreated();
    open();
    typeLabel('Guest token');
    // Toggled ON while a permissive project was selected, then the project
    // changes — the stale toggle must not survive into the body.
    pickProject('Guest Space');
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.projectId).toBe('p-guest');
    expect([...body.permissions].sort()).toEqual(['comment:add', 'project:browse']);
  });

  it('refuses an empty grant — the CTA is disabled and the reason is announced', () => {
    open();
    typeLabel('Nothing');
    for (const key of DEFAULT_TOKEN_GRANT) fireEvent.click(switchFor(key));

    expect(submitButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(
      enMessages.settings.apiTokens.scopes.emptyError,
    );
    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the CTA until the token is named', () => {
    open();
    expect(submitButton().disabled).toBe(true);
    typeLabel('Named');
    expect(submitButton().disabled).toBe(false);
    typeLabel('   '); // whitespace is not a name
    expect(submitButton().disabled).toBe(true);
  });

  it('reports a failed create and stays on the form', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'API_TOKEN_INVALID_PERMISSION' }),
    });
    const { onCreated } = open();
    typeLabel('Doomed');
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByText(enMessages.settings.apiTokens.createModal.errorGeneric)).toBeTruthy(),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByTestId('api-token-secret')).toBeNull();
    // …and the form is usable again rather than stuck in its loading state.
    expect(submitButton().disabled).toBe(false);
  });
});

describe('the shown-once phase — the secret is shown, copied, and then gone', () => {
  const SECRET = 'mtr_live_secret_value';

  async function mint() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: SECRET, dto: { id: 'tok-1', label: 'CI', permissions: [] } }),
    });
    const handles = open();
    typeLabel('CI');
    fireEvent.click(submitButton());
    await screen.findByTestId('api-token-secret');
    return handles;
  }

  it('replaces the form with the secret and the one-time warning', async () => {
    await mint();
    expect(screen.getByTestId('api-token-secret').textContent).toBe(SECRET);
    expect(screen.getByText(enMessages.settings.apiTokens.created.warning)).toBeTruthy();
    // The form is GONE — the picker must not be re-submittable behind the secret.
    expect(screen.queryAllByRole('switch').length).toBe(0);
  });

  it('copies the secret to the clipboard and confirms it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mint();
    fireEvent.click(
      screen.getByRole('button', { name: enMessages.settings.apiTokens.created.copy }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(await screen.findByText(enMessages.settings.apiTokens.toast.body)).toBeTruthy();
  });

  it('says so when the clipboard refuses, rather than failing silently', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mint();
    fireEvent.click(
      screen.getByRole('button', { name: enMessages.settings.apiTokens.created.copy }),
    );
    expect(
      await screen.findByText(enMessages.settings.apiTokens.createModal.copyFailed),
    ).toBeTruthy();
  });

  it('closes on Done and wipes the secret, so a reopen starts clean', async () => {
    const { onOpenChange } = await mint();
    fireEvent.click(
      screen.getByRole('button', { name: enMessages.settings.apiTokens.created.done }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The secret is dropped from state on close — not merely hidden behind
    // `open`, which would put it back on screen the next time the modal opens.
    expect(screen.queryByTestId('api-token-secret')).toBeNull();
  });
});

describe('cancel — the form resets rather than persisting a half-filled draft', () => {
  it('drops the typed label and the toggled grant', () => {
    const { onOpenChange } = open();
    typeLabel('Draft');
    fireEvent.click(switchFor('work_item:delete'));
    fireEvent.click(
      screen.getByRole('button', { name: enMessages.settings.apiTokens.createModal.cancel }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(switchFor('work_item:delete').getAttribute('aria-checked')).toBe('false');
    expect(submitButton().disabled).toBe(true); // the label went with it
  });
});

// ── The multi-tenant shapes the single-tenant fixture never renders ──────────
// MOTIR-2488 is on record that this form grows on a ≥2-org / ≥2-workspace
// account and that the growth is what clipped the footer. Those shapes have no
// E2E fixture, so they are covered here or nowhere.

const MULTI: TokenScopeOrgDTO[] = [
  {
    id: 'org-1',
    name: 'Acme',
    workspaces: [
      {
        id: 'ws-1',
        name: 'Core',
        projects: [
          { id: 'p-1', key: 'ACME', name: 'Acme Core', grantable: [...GRANTABLE_PERMISSIONS] },
        ],
      },
      {
        id: 'ws-2',
        name: 'Labs',
        projects: [{ id: 'p-2', key: 'LABS', name: 'Acme Labs', grantable: ['project:browse'] }],
      },
    ],
  },
  {
    id: 'org-2',
    name: 'Globex',
    workspaces: [
      {
        id: 'ws-3',
        name: 'Main',
        projects: [
          {
            id: 'p-3',
            key: 'GLBX',
            name: 'Globex Main',
            grantable: ['project:browse', 'comment:add'],
          },
        ],
      },
    ],
  },
];

describe('the binding pickers — progressive disclosure by account shape', () => {
  const cm = enMessages.settings.apiTokens.createModal;

  it('hides the org picker and reads "Default" when there is one of each', () => {
    open();
    expect(screen.queryByRole('combobox', { name: cm.orgField })).toBeNull();
    expect(screen.queryByRole('combobox', { name: cm.workspaceField })).toBeNull();
    expect(screen.getByText(cm.defaultWorkspace)).toBeTruthy();
  });

  it('shows both pickers on a multi-org account, opened on the ACTIVE workspace', () => {
    open({ scopeOrgs: MULTI, activeWorkspaceId: 'ws-2' });
    expect(screen.getByRole('combobox', { name: cm.orgField }).textContent).toContain('Acme');
    expect(screen.getByRole('combobox', { name: cm.workspaceField }).textContent).toContain('Labs');
    // …and the offer follows the active workspace's project, not the first org's.
    expect(switchFor('project:browse').disabled).toBe(false);
    expect(switchFor('work_item:edit').disabled).toBe(true);
  });

  it('re-homes the workspace to the new org’s first when the org changes', () => {
    open({ scopeOrgs: MULTI, activeWorkspaceId: 'ws-1' });
    fireEvent.click(screen.getByRole('combobox', { name: cm.orgField }));
    fireEvent.click(screen.getByRole('option', { name: 'Globex' }));

    // A workspace belongs to exactly one org, so the bound workspace must move
    // with it rather than dangle in the org that no longer contains it. Globex
    // has exactly one, so the picker also COLLAPSES to the read-only field —
    // the progressive disclosure has to re-evaluate on the new org, not just on
    // first render.
    expect(screen.queryByRole('combobox', { name: cm.workspaceField })).toBeNull();
    expect(screen.getByText(cm.defaultWorkspace)).toBeTruthy();
    // The project picker is the observable proof the binding really re-homed.
    expect(screen.getByRole('combobox', { name: cm.projectField }).textContent).toContain('GLBX');
    expect(switchFor('comment:add').disabled).toBe(false);
    expect(switchFor('sprint:manage').disabled).toBe(true);
  });

  it('binds to the workspace that was picked, not the one it opened on', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 't', dto: { id: 'tok-1' } }),
    });
    open({ scopeOrgs: MULTI, activeWorkspaceId: 'ws-1' });
    fireEvent.click(screen.getByRole('combobox', { name: cm.workspaceField }));
    fireEvent.click(screen.getByRole('option', { name: 'Labs' }));
    typeLabel('Labs token');
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.workspaceId).toBe('ws-2');
    expect(body.projectId).toBe('p-2');
    expect(body.permissions).toEqual(['project:browse']);
  });

  it('falls back to the first org’s first workspace when the active one is not mintable', () => {
    // The active workspace can be one this actor cannot mint in (or none at
    // all, on first load). The picker must still open on something valid.
    open({ scopeOrgs: MULTI, activeWorkspaceId: null });
    expect(screen.getByRole('combobox', { name: cm.orgField }).textContent).toContain('Acme');
    expect(screen.getByRole('combobox', { name: cm.workspaceField }).textContent).toContain('Core');
  });
});

describe('the degenerate shapes — a workspace with no project, an account with no org', () => {
  const cm = enMessages.settings.apiTokens.createModal;

  it('cannot mint from a workspace with no projects, and does not pretend it can', () => {
    // A grant of PROJECT permissions where no project exists grants nothing, so
    // the binding cannot be satisfied. What must NOT happen is a silent no-op:
    // the CTA is reachable (label + a default grant are both present), so the
    // guard has to hold in `submit` itself.
    open({
      scopeOrgs: [
        { id: 'org-1', name: 'Empty', workspaces: [{ id: 'ws-1', name: 'Solo', projects: [] }] },
      ],
      activeWorkspaceId: 'ws-1',
    });
    typeLabel('Nowhere');
    expect(screen.getByRole('combobox', { name: cm.projectField }).textContent).not.toContain('—');

    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();

    // ⚠️ RECORDED, NOT ENDORSED. This is the shape with no empty state: the
    // form looks fillable and the button does nothing. MOTIR-2572 leaves the
    // product decision open (an empty state, or "such a workspace offers only
    // the device credential"), and this test pins today's behaviour so whichever
    // way it is settled, the change is visible here rather than silent.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders without an org at all rather than throwing on an empty account', () => {
    open({ scopeOrgs: [], activeWorkspaceId: null });
    // No org, no workspace, no project — but the modal still mounts, because a
    // crash here takes the whole settings pane with it.
    expect(screen.getByRole('heading', { name: cm.title })).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });
});
