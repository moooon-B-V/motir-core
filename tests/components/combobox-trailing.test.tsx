// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

// Story 7.10 · MOTIR-1596 — the Combobox gained an optional `trailing` slot so
// the explicit-link picker can pin a PR-state Pill / "Linked to …" chip to each
// option row (design Panel 5b). Backward-compatible: options without `trailing`
// are unchanged. Rendered open (autoOpen) so the option rows are present.

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  {
    value: 'pr-1',
    label: 'Throttle burst traffic',
    secondary: 'moooon/motir-gateway · #57',
    trailing: <span data-testid="trailing-open">Open</span>,
  },
  {
    value: 'pr-2',
    label: 'Token-bucket spike',
    secondary: 'moooon/motir-core · #127',
    trailing: <span data-testid="trailing-linked">Linked to MOTIR-871</span>,
  },
];

describe('Combobox trailing slot (MOTIR-1596)', () => {
  it('renders each option’s trailing content in the open listbox', () => {
    render(
      <Combobox
        label="Pull request to link"
        options={OPTIONS}
        value={null}
        onChange={() => {}}
        searchable
        autoOpen
      />,
    );
    expect(screen.getByTestId('trailing-open').textContent).toBe('Open');
    expect(screen.getByTestId('trailing-linked').textContent).toBe('Linked to MOTIR-871');
    // Both options still carry their label + secondary meta.
    expect(screen.getByText('Throttle burst traffic')).toBeTruthy();
    expect(screen.getByText('moooon/motir-core · #127')).toBeTruthy();
  });

  it('renders rich emptyText (a no-matches line + a hint sub-line)', () => {
    render(
      <Combobox
        label="Pull request to link"
        options={[]}
        value={null}
        onChange={() => {}}
        searchable
        autoOpen
        emptyText={
          <>
            <span className="block">No matching pull requests</span>
            <span className="block">Repositories sync in Settings.</span>
          </>
        }
      />,
    );
    expect(screen.getByText('No matching pull requests')).toBeTruthy();
    expect(screen.getByText('Repositories sync in Settings.')).toBeTruthy();
  });
});
