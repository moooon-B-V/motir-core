// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// RoomViewSwitch's `next === value` guard (MOTIR-6336 coverage floor). The
// shipped `Segmented` does not call `onChange` for the pressed segment, so a real
// render cannot reach the guard; this stub does, to prove the guard holds if a
// future `Segmented` ever re-emits the current value — a navigation to the page
// already shown would re-run its server read for nothing.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/runs',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/ui/Segmented', () => ({
  Segmented: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange(value)}>
      re-emit
    </button>
  ),
}));

const { RoomViewSwitch } = await import('@/components/rooms/RoomViewSwitch');

describe('RoomViewSwitch — a re-emitted current value', () => {
  it('navigates nowhere', () => {
    renderWithIntl(<RoomViewSwitch value="mine" label="Runs" />);
    fireEvent.click(screen.getByRole('button', { name: 're-emit' }));
    expect(push).not.toHaveBeenCalled();
  });
});
