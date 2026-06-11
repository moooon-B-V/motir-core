// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// ComponentsSettingsEditor (Subtask 5.4.10) — the Components admin UI. Driven
// under happy-dom (DB-free): the editor is a pure client consumer of the
// 5.4.3 REST endpoints, so we stub global fetch and assert (a) the populated
// admin list (rows, default-assignee cluster, usage gloss, count pill) and
// its gate-dependent affordances, (b) the create / edit / delete write wiring
// (each firing the right 5.4.3 endpoint with the right body — including the
// move-or-remove delete branches), (c) the inline unique-name 409 naming the
// EXISTING casing, and (d) the read-only + empty states. The full journey
// (real DB, real gates) is the 5.4.11 Playwright E2E's.

import { ComponentsSettingsEditor } from '@/app/(authed)/settings/project/components/_components/ComponentsSettingsEditor';
import type { ComponentWithCountDto } from '@/lib/dto/components';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

let componentSeq = 0;
function component(over: Partial<ComponentWithCountDto> = {}): ComponentWithCountDto {
  componentSeq += 1;
  return {
    id: `c${componentSeq}`,
    name: `Component ${componentSeq}`,
    description: null,
    defaultAssigneeId: null,
    defaultAssignee: null,
    itemCount: 0,
    ...over,
  };
}

const members: WorkspaceMemberDTO[] = [
  { userId: 'u-bob', name: 'Bo', email: 'bophilips@prodect.co', role: 'member' },
  { userId: 'u-odie', name: 'Odie', email: 'odie@prodect.co', role: 'member' },
];

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function renderEditor(over: Partial<Parameters<typeof ComponentsSettingsEditor>[0]> = {}) {
  return render(
    <ComponentsSettingsEditor
      projectKey="PROD"
      components={[]}
      assignableMembers={members}
      canManage
      {...over}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
function stubFetch(responder?: (url: string, init?: RequestInit) => unknown) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = responder?.(url, init) ?? {};
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  componentSeq = 0;
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the populated admin list', () => {
  it('renders one name-ordered row per component with the assignee cluster and usage', () => {
    const components = [
      component({
        name: 'API',
        description: 'The public REST API and its background jobs.',
        defaultAssigneeId: 'u-bob',
        defaultAssignee: { id: 'u-bob', name: 'Bo', email: 'bophilips@prodect.co' },
        itemCount: 12,
      }),
      component({ name: 'Web', itemCount: 7 }),
      component({ name: 'Billing' }),
    ];
    renderEditor({ components });

    expect(screen.getByText('3')).toBeTruthy(); // the plain count pill
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('The public REST API and its background jobs.')).toBeTruthy();
    expect(screen.getByText('Bo')).toBeTruthy();
    expect(screen.getAllByText('Default assignee').length).toBe(3);
    expect(screen.getAllByText('None').length).toBe(2); // Web + Billing unset
    expect(screen.getByText('12 issues')).toBeTruthy();
    expect(screen.getByText('7 issues')).toBeTruthy();
    expect(screen.getByText('not used yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add component' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit API' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete API' })).toBeTruthy();
  });

  it('read-only (non-admin): affordances are hidden, the pill + note show', () => {
    renderEditor({ components: [component({ name: 'API' })], canManage: false });

    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText('Only project admins can manage components.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add component' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit API' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete API' })).toBeNull();
  });

  it('the empty state offers the Add component CTA and opens the create modal', () => {
    renderEditor();

    expect(screen.getByText('No components yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }));
    expect(screen.getByRole('dialog', { name: 'Create component' })).toBeTruthy();
  });

  it('the read-only empty state has no CTA', () => {
    renderEditor({ canManage: false });
    expect(screen.getByText('No components yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add component' })).toBeNull();
  });
});

describe('create', () => {
  it('POSTs name / description / picked default assignee and inserts the row sorted', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        return {
          component: {
            id: 'c-new',
            name: 'Billing',
            description: 'Plans and invoicing.',
            defaultAssigneeId: 'u-odie',
          },
        };
      }
      return {};
    });
    renderEditor({ components: [component({ name: 'API' }), component({ name: 'Web' })] });

    fireEvent.click(screen.getByRole('button', { name: 'Add component' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Billing' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Plans and invoicing.' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Default assignee' }));
    fireEvent.click(await screen.findByRole('option', { name: /Odie/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/components',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({
      name: 'Billing',
      description: 'Plans and invoicing.',
      defaultAssigneeId: 'u-odie',
    });

    // Inserted in name order: API · Billing · Web — and the assignee resolved.
    await waitFor(() => expect(screen.getByText('Billing')).toBeTruthy());
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('API');
    expect(rows[1]!.textContent).toContain('Billing');
    expect(rows[1]!.textContent).toContain('Odie');
    expect(rows[2]!.textContent).toContain('Web');
  });

  it('an empty name blocks the submit with the inline required error', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }));
    expect(screen.getByText('Enter a name for the component.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the unique-name 409 surfaces inline naming the EXISTING casing', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: false, status: 409, json: async () => ({ code: 'COMPONENT_NAME_CONFLICT' }) }
        : { ok: true, status: 200, json: async () => ({}) },
    );
    renderEditor({ components: [component({ name: 'API' })] });

    fireEvent.click(screen.getByRole('button', { name: 'Add component' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }));

    await waitFor(() =>
      expect(
        screen.getByText('A component named “API” already exists in this project.'),
      ).toBeTruthy(),
    );
    // The modal stays open for the correction.
    expect(screen.getByRole('dialog', { name: 'Create component' })).toBeTruthy();
  });
});

describe('edit', () => {
  it('PATCHes the full form state (clearing the assignee via the None row)', async () => {
    const target = component({
      name: 'API',
      description: 'Old gloss.',
      defaultAssigneeId: 'u-bob',
      defaultAssignee: { id: 'u-bob', name: 'Bo', email: 'bophilips@prodect.co' },
      itemCount: 3,
    });
    stubFetch((url, init) => {
      if (init?.method === 'PATCH') {
        return {
          component: {
            id: target.id,
            name: 'Public API',
            description: 'New gloss.',
            defaultAssigneeId: null,
          },
        };
      }
      return {};
    });
    renderEditor({ components: [target] });

    fireEvent.click(screen.getByRole('button', { name: 'Edit API' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Public API' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'New gloss.' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Default assignee' }));
    fireEvent.click(await screen.findByRole('option', { name: /No automatic assignment/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/components/${target.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({
      name: 'Public API',
      description: 'New gloss.',
      defaultAssigneeId: null,
    });

    // The row reflects the response: renamed, assignee cleared, count kept.
    await waitFor(() => expect(screen.getByText('Public API')).toBeTruthy());
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByText('3 issues')).toBeTruthy();
  });
});

describe('delete', () => {
  it('an UNUSED component confirms simply and DELETEs without a body', async () => {
    const target = component({ name: 'Billing', itemCount: 0 });
    renderEditor({ components: [target, component({ name: 'Web' })] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Billing' }));
    // Opening refreshes the held count from the list read (the fresh-count rule).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/PROD/components'));
    expect(screen.getByRole('dialog', { name: 'Delete Billing?' })).toBeTruthy();
    expect(
      screen.getByText('No work items carry this component. This removes it from the project.'),
    ).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete component' }));
    await waitFor(() => expect(screen.queryByText('Billing')).toBeNull());
    const call = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    )!;
    expect(call[0]).toBe(`/api/components/${target.id}`);
    expect((call[1] as RequestInit).body).toBeUndefined();
  });

  it('an IN-USE component offers move-or-remove; the MOVE branch sends the target', async () => {
    const target = component({ name: 'API', itemCount: 12 });
    const web = component({ name: 'Web' });
    renderEditor({ components: [target, web] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete API' }));
    expect(screen.getByRole('dialog', { name: 'Delete API?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Move 12 work items to…/ })).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: /Remove the component from 12 work items/ }),
    ).toBeTruthy();

    // Move is preselected with the first other component as the target —
    // the picker excludes the component being deleted.
    fireEvent.click(screen.getByRole('combobox', { name: 'Move target component' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).not.toContain('API');

    fireEvent.click(screen.getByRole('button', { name: 'Delete component' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        moveToComponentId: web.id,
      });
    });
  });

  it('the REMOVE branch DELETEs without a body and drops the row', async () => {
    const target = component({ name: 'API', itemCount: 12 });
    renderEditor({ components: [target, component({ name: 'Web' })] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete API' }));
    fireEvent.click(screen.getByRole('radio', { name: /Remove the component from 12 work items/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete component' }));

    await waitFor(() => expect(screen.queryByText('API')).toBeNull());
    const call = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    )!;
    expect((call[1] as RequestInit).body).toBeUndefined();
  });

  it('in use with NO other component: only the remove branch is offered', () => {
    renderEditor({ components: [component({ name: 'API', itemCount: 5 })] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete API' }));
    expect(screen.queryByRole('radio', { name: /Move/ })).toBeNull();
    expect(
      screen.getByRole('radio', { name: /Remove the component from 5 work items/ }),
    ).toBeTruthy();
  });

  it('a failed DELETE reverts the optimistic removal and toasts', async () => {
    const target = component({ name: 'Billing' });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? { ok: false, status: 403, json: async () => ({ code: 'NOT_PROJECT_ADMIN' }) }
        : { ok: true, status: 200, json: async () => ({}) },
    );
    renderEditor({ components: [target] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Billing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete component' }));

    await waitFor(() =>
      expect(screen.getByText("The component wasn't deleted. Please try again.")).toBeTruthy(),
    );
    expect(screen.getByText('Billing')).toBeTruthy();
  });
});
