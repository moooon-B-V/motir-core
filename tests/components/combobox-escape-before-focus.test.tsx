// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'home', label: 'Moon Labs · Moon Labs' },
  { value: 'target', label: 'Moon Labs · Ship It' },
];

function Host() {
  const [value, setValue] = useState<string | null>('home');
  return <Combobox label="Workspace" options={OPTIONS} value={value} onChange={setValue} />;
}

// MOTIR-7345. Opening the menu hands focus to the listbox from a `setTimeout(0)`,
// and Escape was handled only by the LIST. An Escape that arrived before that
// timer fired landed on the trigger, which ignored it — so the menu stayed open,
// and the next click on the trigger TOGGLED it shut. That is the sequence the
// OAuth consent acceptance spec drives (open, Escape, open, pick), and on a busy
// CI runner it closed the picker for good: the trace shows `aria-expanded="true"`
// at the second click's input and `"false"` after it, and the option never came.
//
// No timer is advanced here, so the focus hand-off never runs: these cases are
// exactly the window the CI runner landed in.
describe('Combobox — Escape before the open menu has taken focus (MOTIR-7345)', () => {
  it('closes the menu when Escape lands on the trigger', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Workspace' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Workspace' })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('opens again on the next click, so open → Escape → open → pick commits', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Workspace' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Moon Labs · Ship It' }));

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toContain('Ship It');
  });

  it('leaves a CLOSED menu closed on Escape', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Workspace' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
