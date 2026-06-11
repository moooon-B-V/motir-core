// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// FieldsSettingsEditor (Subtask 5.3.6) — the Fields admin UI. Driven under
// happy-dom (DB-free): the editor is a pure client consumer of the 5.3.2
// REST endpoints, so we stub global fetch and assert (a) the populated admin
// list (rows, glosses, count pill) and its gate-dependent affordances, (b)
// the create / edit / option / delete write wiring (each firing the right
// 5.3.2 endpoint with the right body), (c) the cap + read-only + empty
// states, and (d) the reorder fractional-key helpers. The drag path itself
// (happy-dom can't synthesise it) is the 5.3.8 Playwright E2E's; the grip is
// the keyboard-operable control the dnd enhances (the 3.6 grammar).

import {
  FieldsSettingsEditor,
  computeFieldReorder,
  computeOptionReorder,
} from '@/app/(authed)/settings/project/fields/_components/FieldsSettingsEditor';
import type { CustomFieldDefinitionDTO, CustomFieldOptionDTO } from '@/lib/dto/customFields';

let optionSeq = 0;
function option(over: Partial<CustomFieldOptionDTO> = {}): CustomFieldOptionDTO {
  optionSeq += 1;
  return {
    id: `o${optionSeq}`,
    label: `Option ${optionSeq}`,
    position: `a${optionSeq}`,
    archived: false,
    valueCount: 0,
    ...over,
  };
}

let fieldSeq = 0;
function field(over: Partial<CustomFieldDefinitionDTO> = {}): CustomFieldDefinitionDTO {
  fieldSeq += 1;
  return {
    id: `f${fieldSeq}`,
    key: `field-${fieldSeq}`,
    label: `Field ${fieldSeq}`,
    fieldType: 'text',
    description: null,
    position: `a${fieldSeq}`,
    options: [],
    valueCount: 0,
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
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
  optionSeq = 0;
  fieldSeq = 0;
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the populated admin list', () => {
  it('renders one row per definition with the type gloss and the count pill', () => {
    const fields = [
      field({
        label: 'Severity',
        fieldType: 'select',
        valueCount: 12,
        options: [option(), option(), option(), option()],
      }),
      field({ label: 'Customer', fieldType: 'text', valueCount: 7 }),
      field({ label: 'Stakeholder', fieldType: 'user' }),
    ];
    render(<FieldsSettingsEditor projectKey="PROD" fields={fields} canManage />);

    expect(screen.getByText('Custom fields')).toBeTruthy();
    expect(screen.getByText('3 / 50')).toBeTruthy();
    expect(screen.getByText('Severity')).toBeTruthy();
    expect(screen.getByText('Select · 4 options · used on 12 issues')).toBeTruthy();
    expect(screen.getByText('Text · used on 7 issues')).toBeTruthy();
    expect(screen.getByText('User · not used yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add field' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reorder Severity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Severity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Severity' })).toBeTruthy();
  });

  it('read-only (non-admin): affordances are hidden, the pill + note show', () => {
    const fields = [field({ label: 'Severity' })];
    render(<FieldsSettingsEditor projectKey="PROD" fields={fields} canManage={false} />);

    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText('Only project admins can manage fields.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Severity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Severity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reorder Severity' })).toBeNull();
  });

  it('the 50-field cap disables Add field and shows the explanatory line', () => {
    const fields = Array.from({ length: 50 }, () => field());
    render(<FieldsSettingsEditor projectKey="PROD" fields={fields} canManage />);

    expect(screen.getByText('50 / 50')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add field' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(
      screen.getByText('A project can hold up to 50 custom fields. Delete a field to add another.'),
    ).toBeTruthy();
  });

  it('the empty state offers the Add field CTA and opens the create modal', () => {
    render(<FieldsSettingsEditor projectKey="PROD" fields={[]} canManage />);

    expect(screen.getByText('No custom fields yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Create field' })).toBeTruthy();
  });

  it('the empty state hides the CTA from non-admins', () => {
    render(<FieldsSettingsEditor projectKey="PROD" fields={[]} canManage={false} />);
    expect(screen.getByText('No custom fields yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull();
  });
});

describe('create field', () => {
  it('POSTs the label, type, and seed options, then appends the new row', async () => {
    const created = field({
      id: 'created',
      label: 'Severity',
      fieldType: 'select',
      options: [option({ label: 'Low' }), option({ label: 'High' })],
    });
    stubFetch((url, init) => (init?.method === 'POST' ? { field: created } : {}));
    render(<FieldsSettingsEditor projectKey="PROD" fields={[]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Severity' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Select/ }));

    // The Options block renders only while Select is chosen.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    fireEvent.change(within(dialog).getByPlaceholderText('Option label'), {
      target: { value: 'Low' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    const optionInputs = within(dialog).getAllByPlaceholderText('Option label');
    fireEvent.change(optionInputs[1]!, { target: { value: 'High' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/PROD/fields',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const init = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      label: 'Severity',
      fieldType: 'select',
      options: ['Low', 'High'],
    });
    await waitFor(() => expect(screen.getByText('Severity')).toBeTruthy());
  });

  it('requires a label before submitting', async () => {
    render(<FieldsSettingsEditor projectKey="PROD" fields={[]} canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create field' }),
    );

    expect(await screen.findByText('Enter a label for the field.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('edit field', () => {
  it('shows the frozen type, PATCHes a rename and a description change', async () => {
    const f = field({ label: 'Severity', fieldType: 'select', description: 'Old' });
    stubFetch((url, init) =>
      init?.method === 'PATCH'
        ? { field: { ...f, label: 'Impact', description: 'New purpose' } }
        : {},
    );
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText("The type can't be changed after the field is created."),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Impact' } });
    fireEvent.change(within(dialog).getByLabelText('Description (optional)'), {
      target: { value: 'New purpose' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const bodies = fetchMock.mock.calls
        .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')
        .map((c) => JSON.parse((c[1] as RequestInit).body as string));
      expect(bodies).toEqual([{ label: 'Impact' }, { description: 'New purpose' }]);
    });
    expect(
      fetchMock.mock.calls.every((c) => (c[0] as string).startsWith(`/api/fields/${f.id}`)),
    ).toBe(true);
  });

  it('archives an in-use option, blocks its delete, and deletes an unused one', async () => {
    const inUse = option({ id: 'used', label: 'Low', valueCount: 2 });
    const unused = option({ id: 'free', label: 'High' });
    const f = field({
      label: 'Severity',
      fieldType: 'select',
      options: [inUse, unused],
      valueCount: 2,
    });
    stubFetch((url, init) =>
      init?.method === 'PATCH' ? { option: { ...inUse, archived: true } } : {},
    );
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const dialog = screen.getByRole('dialog');

    // Per-option usage gloss + the guarded delete (disabled, tooltip-wrapped).
    expect(within(dialog).getByText('used on 2 issues')).toBeTruthy();
    const lowRow = within(dialog).getByTestId('option-row-used');
    const lowDelete = within(lowRow).getByRole('button', {
      name: 'Delete Low',
    }) as HTMLButtonElement;
    expect(lowDelete.disabled).toBe(true);

    // Archive fires the PATCH with archived: true.
    fireEvent.click(within(lowRow).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/fields/${f.id}/options/used`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    const patchInit = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    )![1] as RequestInit;
    expect(JSON.parse(patchInit.body as string)).toEqual({ archived: true });
    await waitFor(() => expect(within(dialog).getByText('Archived')).toBeTruthy());

    // The unused option's delete is live and removes the row.
    const highRow = within(dialog).getByTestId('option-row-free');
    fireEvent.click(within(highRow).getByRole('button', { name: 'Delete High' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/fields/${f.id}/options/free`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => expect(within(dialog).queryByTestId('option-row-free')).toBeNull());
  });

  it('adds an option through the footer input and respects the 55 cap', async () => {
    const newOption = option({ id: 'new-opt', label: 'Medium' });
    const f = field({
      label: 'Severity',
      fieldType: 'select',
      options: [option({ label: 'Low' })],
    });
    stubFetch((url, init) => (init?.method === 'POST' ? { option: newOption } : {}));
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1 / 55')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    fireEvent.change(within(dialog).getByPlaceholderText('Option label'), {
      target: { value: 'Medium' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/fields/${f.id}/options`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(within(dialog).getByText('Medium')).toBeTruthy());
    expect(within(dialog).getByText('2 / 55')).toBeTruthy();
  });

  it('shows the cap-reached footer when a field holds 55 options', () => {
    const f = field({
      label: 'Severity',
      fieldType: 'select',
      options: Array.from({ length: 55 }, () => option()),
    });
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('55 / 55 — a field can hold up to 55 options')).toBeTruthy();
    const add = within(dialog).getByRole('button', { name: 'Add option' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });
});

describe('delete field', () => {
  it('refetches on confirm-open, names the value count, and DELETEs on confirm', async () => {
    const f = field({ id: 'del-me', label: 'Severity', valueCount: 3 });
    stubFetch((url, init) => {
      if (!init?.method || init.method === 'GET') {
        return { fields: [{ ...f, valueCount: 12 }] };
      }
      return { deleted: { id: f.id, key: f.key, label: f.label, valueCount: 12 } };
    });
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Severity' }));

    // The consequence statement uses the FRESH count from the confirm-open GET.
    expect(await screen.findByText('Delete Severity?')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('12 issues')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/fields/del-me',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => expect(screen.queryByText('Severity')).toBeNull());
    expect(screen.getByText('No custom fields yet')).toBeTruthy();
  });

  it('a field with no values gets the no-values consequence copy', async () => {
    const f = field({ id: 'empty-del', label: 'Customer', valueCount: 0 });
    stubFetch((url, init) => (!init?.method || init.method === 'GET' ? { fields: [f] } : {}));
    render(<FieldsSettingsEditor projectKey="PROD" fields={[f]} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Customer' }));
    expect(
      await screen.findByText('Deletes the field. No issues hold a value for it.'),
    ).toBeTruthy();
  });
});

describe('the fractional-key reorder helpers', () => {
  it('computeFieldReorder moves a field and mints a key between its neighbours', () => {
    const a = field({ id: 'a', position: 'a0' });
    const b = field({ id: 'b', position: 'a1' });
    const c = field({ id: 'c', position: 'a2' });

    const moved = computeFieldReorder([a, b, c], 'c', 'a');
    expect(moved).not.toBeNull();
    expect(moved!.fields.map((f) => f.id)).toEqual(['c', 'a', 'b']);
    expect(moved!.position < 'a0').toBe(true);

    expect(computeFieldReorder([a, b, c], 'a', 'a')).toBeNull();
    expect(computeFieldReorder([a, b, c], 'missing', 'a')).toBeNull();
  });

  it('computeOptionReorder refuses to move archived options', () => {
    const o1 = option({ id: 'o-1', position: 'a0' });
    const o2 = option({ id: 'o-2', position: 'a1' });
    const archived = option({ id: 'o-3', position: 'a2', archived: true });

    const moved = computeOptionReorder([o1, o2, archived], 'o-2', 'o-1');
    expect(moved!.options.map((o) => o.id)).toEqual(['o-2', 'o-1', 'o-3']);

    expect(computeOptionReorder([o1, o2, archived], 'o-3', 'o-1')).toBeNull();
    expect(computeOptionReorder([o1, o2, archived], 'o-1', 'o-3')).toBeNull();
  });
});
