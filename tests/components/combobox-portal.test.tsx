// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

// Mirror the issue-list table's clipping wrapper (IssueListTable.tsx:90 /
// TreeTable.tsx:448): a SHORT card with `overflow-hidden`. Before the fix the
// Combobox menu was an absolutely-positioned descendant of this card, so a short
// table clipped it (bug-inline-edit-clipped-when-table-short). The menu must now
// be portaled OUT of this overflow ancestor.
function Host() {
  const [value, setValue] = useState<string | null>('in_progress');
  return (
    <div data-testid="clip-card" className="overflow-hidden" style={{ height: 60 }}>
      <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
    </div>
  );
}

describe('Combobox — menu portaling (bug-inline-edit-clipped-when-table-short)', () => {
  it('renders the open menu outside the overflow-hidden ancestor (portaled to body)', () => {
    render(<Host />);
    const card = screen.getByTestId('clip-card');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // The whole menu panel is the listbox's parent; it must NOT live inside the
    // clipping card, and it must be anchored with position:fixed (viewport
    // coords) rather than the old absolute-inside-the-scroller positioning.
    expect(card.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    const panel = listbox.parentElement as HTMLElement;
    expect(panel.style.position).toBe('fixed');
  });

  it('still commits a selection clicked inside the portaled menu', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    // A click lands on the portaled option; the click-outside guard must treat
    // the portaled menu as "inside" so it does not pre-close before commit.
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));

    expect(screen.queryByRole('listbox')).toBeNull(); // menu closed after pick
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('Done');
  });

  // Regression for the E2E failure on PR #444: inside a focus-trapping dialog the
  // menu must render INLINE (a body-portaled menu lands outside the dialog's focus
  // scope → focus-trap war → unstable / un-clickable; and the dialog's centering
  // transform breaks a fixed child's viewport coords). Pickers in the create-issue
  // modal must keep working.
  function DialogHost() {
    const [value, setValue] = useState<string | null>('todo');
    return (
      <div role="dialog">
        <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
      </div>
    );
  }

  it('renders inline (not portaled) inside a dialog, and still commits', () => {
    render(<DialogHost />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // Inline: the menu stays WITHIN the dialog subtree (not portaled to body).
    expect(dialog.contains(listbox)).toBe(true);
    expect((listbox.parentElement as HTMLElement).style.position).not.toBe('fixed');

    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('In Progress');
  });
});
