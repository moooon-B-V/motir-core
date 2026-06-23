// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MultiSelectPicker,
  ValueChip,
  type MultiSelectOption,
  type MultiSelectPickerProps,
} from '@/components/ui/MultiSelectPicker';

// The generic chip-input primitive (Subtask 5.4.8), against
// design/work-items/labels-components-watch.mock.html panel 1: chips + filter
// input, the aria-multiselectable listbox of OptionRow rows, the complete
// keyboard model (type / ↑↓ / Enter toggles / Backspace removes the last chip
// / Esc closes), the create-row, the cap, and the tint treatments. Pure —
// options in, selection out — so it drives standalone with no provider.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const api: MultiSelectOption = { id: 'l1', label: 'api', tint: 'sky' };
const designDebt: MultiSelectOption = { id: 'l2', label: 'design-debt', tint: 'lavender' };
const onboarding: MultiSelectOption = { id: 'l3', label: 'onboarding', tint: 'rose' };

function renderPicker(overrides: Partial<MultiSelectPickerProps> = {}) {
  const props: MultiSelectPickerProps = {
    values: [api],
    options: [api, designDebt, onboarding],
    onToggle: vi.fn(),
    onRemove: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    label: 'Labels',
    placeholder: 'Add a label…',
    removeLabel: (label) => `Remove ${label}`,
    ...overrides,
  };
  return { ...render(<MultiSelectPicker {...props} />), props };
}

function input() {
  return screen.getByRole('combobox', { name: 'Labels' });
}

describe('MultiSelectPicker', () => {
  it('renders the selected values as chips and opens an aria-multiselectable listbox on focus', () => {
    renderPicker();
    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.focus(input());
    const listbox = screen.getByRole('listbox', { name: 'Labels' });
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['api', 'design-debt', 'onboarding']);
    // The selected value's row carries aria-selected (the trailing Check).
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('toggles a row on click WITHOUT closing the menu (multi-select)', () => {
    const { props } = renderPicker();
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole('option', { name: 'design-debt' }));
    expect(props.onToggle).toHaveBeenCalledWith(designDebt);
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('moves the active row with ↑↓ (aria-activedescendant) and toggles it with Enter', () => {
    const { props } = renderPicker();
    const box = input();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    // Row 0 is active on open; one ↓ lands on row 1 (design-debt).
    expect(props.onToggle).toHaveBeenCalledWith(designDebt);
    expect(box.getAttribute('aria-activedescendant')).toContain('opt-1');
  });

  it('Backspace on an empty input removes the LAST chip; with text it does not', () => {
    const { props, rerender } = renderPicker({ values: [api, designDebt] });
    const box = input();
    fireEvent.keyDown(box, { key: 'Backspace' });
    expect(props.onRemove).toHaveBeenCalledWith(designDebt);

    rerender(<MultiSelectPicker {...props} values={[api, designDebt]} query="de" />);
    (props.onRemove as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it('Esc closes the listbox', () => {
    renderPicker();
    const box = input();
    fireEvent.focus(box);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the create-row only when onCreate is set AND the query matches nothing (case-insensitively)', () => {
    const onCreate = vi.fn();
    renderPicker({
      onCreate,
      query: 'perf-q3',
      options: [],
      createLabel: (q) => `Create '${q}'`,
    });
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole('option', { name: "Create 'perf-q3'" }));
    expect(onCreate).toHaveBeenCalledWith('perf-q3');

    // A case-insensitive match (an existing option OR an existing chip)
    // suppresses the create-row — the existing casing is offered instead.
    cleanup();
    renderPicker({ onCreate, query: 'API', options: [api], createLabel: (q) => `Create '${q}'` });
    fireEvent.focus(input());
    expect(screen.queryByRole('option', { name: "Create 'API'" })).toBeNull();
    expect(screen.getByRole('option', { name: 'api' })).toBeTruthy();
  });

  it('disables the input at the cap while chips stay removable, and renders the hint', () => {
    const { props } = renderPicker({
      values: [api, designDebt],
      cap: 2,
      hint: 'Label limit reached (2) — remove one to add another.',
    });
    expect((input() as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Label limit reached (2) — remove one to add another.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove api' }));
    expect(props.onRemove).toHaveBeenCalledWith(api);
  });

  it('announces the inline error via role="alert" (the typed 422 grammar)', () => {
    renderPicker({ error: "Labels can't contain spaces — use a hyphen: perf-q3" });
    expect(screen.getByRole('alert').textContent).toContain('use a hyphen: perf-q3');
  });

  it('renders the empty state when there are no options and no create-row', () => {
    renderPicker({ values: [], options: [], emptyText: 'No components defined' });
    fireEvent.focus(input());
    expect(screen.getByText('No components defined')).toBeTruthy();
  });
});

describe('ValueChip', () => {
  it('tints the chip via the value tint with strong text; neutral chips keep the bordered surface', () => {
    const { container } = render(
      <>
        <ValueChip option={api} />
        <ValueChip option={{ id: 'c1', label: 'API' }} />
      </>,
    );
    const [tinted, neutral] = Array.from(container.querySelectorAll('span.inline-flex'));
    // The chip tint routes through the dedicated `--el-label-1..6` ramp (MOTIR-1274
    // · 1266.3); `sky` is the 5th tint → `--el-label-5` (zero visual change).
    expect(tinted?.className).toContain('bg-(--el-label-5)');
    expect(tinted?.className).toContain('text-(--el-text-strong)');
    // The neutral chip routes through the dedicated --el-chip-bg / --el-chip-border
    // (MOTIR-1275 · 1266.4 — they default to --color-surface / --color-border, so
    // zero visual change; a palette can now tune the neutral chip apart).
    expect(neutral?.className).toContain('bg-(--el-chip-bg)');
    expect(neutral?.className).toContain('border-(--el-chip-border)');
  });

  it('renders the remove × with its accessible name only when removable', () => {
    const onRemove = vi.fn();
    render(<ValueChip option={api} onRemove={onRemove} removeLabel={(l) => `Remove ${l}`} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove api' }));
    expect(onRemove).toHaveBeenCalledWith(api);

    cleanup();
    render(<ValueChip option={api} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
