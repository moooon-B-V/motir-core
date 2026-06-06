// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';
import { CommandPalette, type CommandGroup } from '@/components/ui/CommandPalette';
import {
  CommandPaletteProvider,
  useCommandPalette,
} from '@/app/(authed)/_components/CommandPaletteProvider';

afterEach(() => cleanup());

function makeGroups(spies: Record<string, () => void>): CommandGroup[] {
  return [
    {
      heading: 'Navigation',
      actions: [
        { id: 'dash', label: 'Go to Dashboard', onSelect: spies.dash! },
        { id: 'issues', label: 'Go to Work Items', onSelect: spies.issues! },
        { id: 'boards', label: 'Go to Boards', onSelect: spies.boards! },
      ],
    },
    {
      heading: 'Account',
      actions: [{ id: 'signout', label: 'Sign out', onSelect: spies.signout! }],
    },
  ];
}

/** A controlled host so tests can observe open/close transitions. */
function Host({ groups }: { groups: CommandGroup[] }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />
    </>
  );
}

describe('CommandPalette (primitive)', () => {
  it('shows all grouped actions on an empty query', () => {
    render(
      <Host
        groups={makeGroups({ dash: vi.fn(), issues: vi.fn(), boards: vi.fn(), signout: vi.fn() })}
      />,
    );
    expect(screen.getByText('Navigation')).toBeTruthy();
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('filters actions by substring of the label', () => {
    render(
      <Host
        groups={makeGroups({ dash: vi.fn(), issues: vi.fn(), boards: vi.fn(), signout: vi.fn() })}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Search commands' }), {
      target: { value: 'work' },
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Go to Work Items');
    // The non-matching group heading is gone too.
    expect(screen.queryByText('Account')).toBeNull();
  });

  it('invokes the highlighted action on Enter (first row by default)', () => {
    const dash = vi.fn();
    render(
      <Host groups={makeGroups({ dash, issues: vi.fn(), boards: vi.fn(), signout: vi.fn() })} />,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search commands' }), { key: 'Enter' });
    expect(dash).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with ArrowDown before invoking', () => {
    const dash = vi.fn();
    const issues = vi.fn();
    render(<Host groups={makeGroups({ dash, issues, boards: vi.fn(), signout: vi.fn() })} />);
    const input = screen.getByRole('textbox', { name: 'Search commands' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(issues).toHaveBeenCalledTimes(1);
    expect(dash).not.toHaveBeenCalled();
  });

  it('invokes the filtered match on Enter', () => {
    const issues = vi.fn();
    render(
      <Host groups={makeGroups({ dash: vi.fn(), issues, boards: vi.fn(), signout: vi.fn() })} />,
    );
    const input = screen.getByRole('textbox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(issues).toHaveBeenCalledTimes(1);
  });

  it('shows a no-match message when nothing matches', () => {
    render(
      <Host
        groups={makeGroups({ dash: vi.fn(), issues: vi.fn(), boards: vi.fn(), signout: vi.fn() })}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Search commands' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No actions match.')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('renders a trailing badge on an action that carries one', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <CommandPalette
          open={open}
          onOpenChange={setOpen}
          groups={[
            {
              heading: 'Workspace',
              actions: [
                { id: 'cur', label: 'Acme Inc.', badge: 'Current', onSelect: vi.fn() },
                { id: 'other', label: 'Switch to Beta Labs', onSelect: vi.fn() },
              ],
            },
          ]}
        />
      );
    }
    render(<Host />);
    const current = screen.getByRole('option', { name: /Acme Inc\./ });
    expect(current.textContent).toContain('Current');
    // The non-active workspace keeps the "Switch to" affordance, no badge.
    const other = screen.getByRole('option', { name: /Switch to Beta Labs/ });
    expect(other.textContent).not.toContain('Current');
  });

  it('closes (onOpenChange→false) when Escape is pressed', () => {
    render(
      <Host
        groups={makeGroups({ dash: vi.fn(), issues: vi.fn(), boards: vi.fn(), signout: vi.fn() })}
      />,
    );
    expect(screen.getByTestId('state').textContent).toBe('open');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search commands' }), { key: 'Escape' });
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });
});

describe('CommandPaletteProvider', () => {
  function ProbeHarness() {
    const { open } = useCommandPalette();
    return <span data-testid="probe">{open ? 'open' : 'closed'}</span>;
  }

  it('opens on ⌘K / Ctrl+K from anywhere in the shell', () => {
    render(
      <CommandPaletteProvider>
        <ProbeHarness />
      </CommandPaletteProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('closed');

    // Send both modifiers so the assertion is platform-agnostic (the hook reads
    // metaKey on Mac, ctrlKey elsewhere).
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true }),
      );
    });
    expect(screen.getByTestId('probe').textContent).toBe('open');
  });
});
