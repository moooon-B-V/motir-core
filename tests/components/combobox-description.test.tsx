// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

// MOTIR-6465 — the Combobox gained an optional `description`: a line UNDER an
// option's label in the menu, never in the trigger (the workspace role picker's
// "what this role does", design panel 1b). Backward-compatible: options without
// one render as before.

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'manager', label: 'Manager', description: 'Everything in this workspace.' },
  { value: 'viewer', label: 'Viewer', description: 'Reads every project.' },
  { value: 'plain', label: 'Plain' },
];

describe('Combobox description (MOTIR-6465)', () => {
  it('draws each description under its label in the open menu', () => {
    render(<Combobox label="Role" options={OPTIONS} value="viewer" onChange={() => {}} autoOpen />);
    const viewer = screen.getByRole('option', { name: /Viewer/ });
    expect(within(viewer).getByText('Reads every project.')).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Plain/ }).textContent).toBe('Plain');
  });

  it('keeps the TRIGGER to the label alone', () => {
    render(<Combobox label="Role" options={OPTIONS} value="viewer" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Role' });
    expect(trigger.textContent).toBe('Viewer');
  });
});
