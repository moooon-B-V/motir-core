// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The rail's custom-field cards (Subtask 5.3.7) commit through the dedicated
// Server Action and KEEP the optimistic value on success (no router.refresh —
// the inline-edit pattern); stub the action so the section drives in isolation
// against design/work-items/custom-fields.mock.html.
const { setSpy } = vi.hoisted(() => ({
  setSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: setSpy,
}));

import { CustomFieldsSection } from '@/app/(authed)/issues/[key]/_components/CustomFieldsSection';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_bo', name: 'Bo Philips', email: 'bophilips@motir.co', role: 'member' },
  { userId: 'u_odie', name: 'Odie Park', email: 'odie@motir.co', role: 'member' },
];

function makeField(overrides: Partial<CustomFieldWithValueDto> = {}): CustomFieldWithValueDto {
  return {
    id: 'f_text',
    key: 'customer',
    label: 'Customer',
    fieldType: 'text',
    description: null,
    options: [],
    value: { text: 'Acme GmbH', number: null, date: null, option: null, user: null },
    ...overrides,
  };
}

const severityOptions = [
  { id: 'opt_low', label: 'Low', archived: false },
  { id: 'opt_high', label: 'High', archived: false },
  { id: 'opt_blocker', label: 'Blocker', archived: true },
];

function selectField(overrides: Partial<CustomFieldWithValueDto> = {}): CustomFieldWithValueDto {
  return makeField({
    id: 'f_select',
    key: 'severity',
    label: 'Severity',
    fieldType: 'select',
    options: severityOptions,
    value: {
      text: null,
      number: null,
      date: null,
      option: { id: 'opt_high', label: 'High', archived: false },
      user: null,
    },
    ...overrides,
  });
}

function renderSection(fields: CustomFieldWithValueDto[], { canEdit = true } = {}) {
  return render(
    <ProjectAccessProvider canEdit={canEdit}>
      <CustomFieldsSection workItemId="wi_1" fields={fields} members={members} />
    </ProjectAccessProvider>,
  );
}

describe('CustomFieldsSection — per-type display (mock panel 1)', () => {
  it('renders nothing at all when no fields are defined (the null-case guarantee)', () => {
    const { container } = renderSection([]);
    expect(container.innerHTML).toBe('');
  });

  it('renders text truncating with the full value on title', () => {
    renderSection([makeField()]);
    const value = screen.getByTitle('Acme GmbH');
    expect(value.textContent).toBe('Acme GmbH');
  });

  it('renders number as the formatted decimal', () => {
    renderSection([
      makeField({
        id: 'f_num',
        label: 'Effort',
        fieldType: 'number',
        value: { text: null, number: 12.5, date: null, option: null, user: null },
      }),
    ]);
    expect(screen.getByText('12.5')).toBeTruthy();
  });

  it('renders date with the Due-date grammar (formatted date)', () => {
    renderSection([
      makeField({
        id: 'f_date',
        label: 'Go-live',
        fieldType: 'date',
        value: {
          text: null,
          number: null,
          date: '2026-06-12T00:00:00.000Z',
          option: null,
          user: null,
        },
      }),
    ]);
    expect(screen.getByText('Jun 12, 2026')).toBeTruthy();
  });

  it('renders a select value plain, and an ARCHIVED one with the archived mark', () => {
    renderSection([
      selectField(),
      selectField({
        id: 'f_select2',
        label: 'Old severity',
        value: {
          text: null,
          number: null,
          date: null,
          option: { id: 'opt_blocker', label: 'Blocker', archived: true },
          user: null,
        },
      }),
    ]);
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText(/Blocker/).textContent).toContain('(archived)');
  });

  it('renders a user value with the assignee grammar (avatar initial + name)', () => {
    renderSection([
      makeField({
        id: 'f_user',
        label: 'Stakeholder',
        fieldType: 'user',
        value: {
          text: null,
          number: null,
          date: null,
          option: null,
          user: { id: 'u_bo', name: 'Bo Philips', image: null },
        },
      }),
    ]);
    expect(screen.getByText('Bo Philips')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy(); // the initial avatar
  });
});

describe('CustomFieldsSection — "Show more fields" disclosure (mock panel 3)', () => {
  const fields = [
    makeField(),
    makeField({ id: 'f_empty1', key: 'golive', label: 'Go-live', fieldType: 'date', value: null }),
    makeField({
      id: 'f_empty2',
      key: 'stake',
      label: 'Stakeholder',
      fieldType: 'user',
      value: null,
    }),
  ];

  it('hides empty fields behind the counted disclosure and reveals them on expand', () => {
    renderSection(fields);

    expect(screen.queryByText('Go-live')).toBeNull();
    const disclosure = screen.getByRole('button', { name: 'Show more fields (2)' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure.textContent).toContain('Show fewer fields');
    expect(screen.getByText('Go-live')).toBeTruthy();
    expect(screen.getByText('Stakeholder')).toBeTruthy();
    expect(screen.getAllByText('None').length).toBe(2); // the empty placeholders

    fireEvent.click(disclosure);
    expect(screen.queryByText('Go-live')).toBeNull();
  });

  it('renders no disclosure when every field holds a value', () => {
    renderSection([makeField()]);
    expect(screen.queryByRole('button', { name: /Show more fields/ })).toBeNull();
  });
});

describe('CustomFieldsSection — inline editors (mock panel 2)', () => {
  it('commits an edited text value on blur and KEEPS the optimistic value on success', async () => {
    setSpy.mockResolvedValue({ ok: true });
    renderSection([makeField()]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Customer' }));
    const input = screen.getByRole('textbox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'New Co' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({
        workItemId: 'wi_1',
        fieldId: 'f_text',
        value: 'New Co',
      }),
    );
    // Editor closes and the new value stays on the card — the 200 IS the
    // confirmation, so there is NO whole-tree refresh that would revert it.
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Customer' })).toBeNull());
    expect(screen.getByText('New Co')).toBeTruthy();
    expect(screen.queryByText('Acme GmbH')).toBeNull();
  });

  it('clears the value when the input is emptied', async () => {
    setSpy.mockResolvedValue({ ok: true });
    renderSection([makeField()]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Customer' }));
    const input = screen.getByRole('textbox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', fieldId: 'f_text', value: null }),
    );
  });

  it('closes without a write when the draft is unchanged', async () => {
    renderSection([makeField()]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Customer' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Customer' }));

    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Customer' })).toBeNull());
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('snaps the value back and reopens the editor with the role="alert" inline error on a 422', async () => {
    setSpy.mockResolvedValue({ ok: false, error: 'Enter a number — e.g. 12.5.' });
    renderSection([
      makeField({
        id: 'f_num',
        label: 'Effort',
        fieldType: 'number',
        value: { text: null, number: 12.5, date: null, option: null, user: null },
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Effort' }));
    const input = screen.getByRole('textbox', { name: 'Effort' });
    fireEvent.change(input, { target: { value: '12,5x' } });
    fireEvent.blur(input);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Enter a number — e.g. 12.5.');
    expect(screen.getByRole('textbox', { name: 'Effort' })).toBeTruthy(); // reopened on error
  });

  it('select editor excludes archived options, offers None first, and commits a pick', async () => {
    setSpy.mockResolvedValue({ ok: true });
    renderSection([selectField()]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const listbox = await screen.findByRole('listbox', { name: 'Severity' });
    const optionNames = Array.from(listbox.querySelectorAll('[role="option"]')).map((o) =>
      o.textContent?.trim(),
    );
    expect(optionNames).toEqual(['None', 'Low', 'High']); // Blocker (archived) excluded

    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({
        workItemId: 'wi_1',
        fieldId: 'f_select',
        value: 'opt_low',
      }),
    );
  });

  it('select None row clears the value', async () => {
    setSpy.mockResolvedValue({ ok: true });
    renderSection([selectField()]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    fireEvent.click(await screen.findByRole('option', { name: 'None' }));

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', fieldId: 'f_select', value: null }),
    );
  });

  it('a current-but-archived select value stays on the trigger with its mark', () => {
    renderSection([
      selectField({
        value: {
          text: null,
          number: null,
          date: null,
          option: { id: 'opt_blocker', label: 'Blocker', archived: true },
          user: null,
        },
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Severity' }));
    const trigger = screen.getByRole('combobox', { name: 'Severity' });
    expect(trigger.textContent).toContain('Blocker (archived)');
  });

  it('user editor searches members and commits the picked member', async () => {
    setSpy.mockResolvedValue({ ok: true });
    renderSection([
      makeField({
        id: 'f_user',
        key: 'stake',
        label: 'Stakeholder',
        fieldType: 'user',
        value: null,
      }),
    ]);

    // The empty field sits behind the disclosure — expand, then edit in place.
    fireEvent.click(screen.getByRole('button', { name: 'Show more fields (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stakeholder' }));
    expect(await screen.findByPlaceholderText('Search members…')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Odie Park/ }));

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({
        workItemId: 'wi_1',
        fieldId: 'f_user',
        value: 'u_odie',
      }),
    );
  });

  it('date editor opens the DatePicker from the chevron', async () => {
    renderSection([
      makeField({
        id: 'f_date',
        label: 'Go-live',
        fieldType: 'date',
        value: {
          text: null,
          number: null,
          date: '2026-06-12T00:00:00.000Z',
          option: null,
          user: null,
        },
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Go-live' }));
    // The shipped DatePicker mounts (autoOpen) — trigger + calendar both carry
    // the field label, so assert at least one labelled control appears.
    expect((await screen.findAllByLabelText('Go-live')).length).toBeGreaterThan(0);
  });
});

describe('CustomFieldsSection — viewer read-only (mock panel 4)', () => {
  it('drops every chevron but keeps values and the disclosure row', () => {
    renderSection(
      [
        selectField(),
        makeField({
          id: 'f_empty',
          key: 'golive',
          label: 'Go-live',
          fieldType: 'date',
          value: null,
        }),
      ],
      { canEdit: false },
    );

    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Severity' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more fields (1)' })).toBeTruthy();
  });
});
