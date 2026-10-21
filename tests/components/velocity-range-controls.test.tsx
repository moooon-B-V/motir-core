// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The Velocity range controls (Story MOTIR-8919) under happy-dom: every change
// NAVIGATES to the canonical `buildReportHref` URL (the range lives in the URL,
// so a copied link reopens it); defaults are omitted.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/velocity',
}));

import { VelocityRangeControls } from '@/app/(authed)/reports/_components/VelocityRangeControls';

// Combobox (Radix popover) needs a few browser APIs happy-dom lacks.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => push.mockClear());
afterEach(cleanup);

const SPRINTS = [
  { id: 's3', name: 'Sprint 3' },
  { id: 's2', name: 'Sprint 2' },
  { id: 's1', name: 'Sprint 1' },
];

describe('VelocityRangeControls', () => {
  it('steps the count along the ladder and keeps the end sprint in the URL', () => {
    render(<VelocityRangeControls sprints={SPRINTS} endingAt="s2" count={7} />);
    fireEvent.click(screen.getByRole('button', { name: 'More sprints' }));
    expect(push).toHaveBeenLastCalledWith('/reports/velocity?endingAt=s2&count=10');
    fireEvent.click(screen.getByRole('button', { name: 'Fewer sprints' }));
    expect(push).toHaveBeenLastCalledWith('/reports/velocity?endingAt=s2&count=5');
  });

  it('omits the defaults: stepping back to 7 with no end sprint is the bare path', () => {
    render(<VelocityRangeControls sprints={SPRINTS} endingAt={null} count={10} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fewer sprints' }));
    expect(push).toHaveBeenLastCalledWith('/reports/velocity');
  });

  it('disables the stepper at its bounds', () => {
    const { rerender } = render(
      <VelocityRangeControls sprints={SPRINTS} endingAt={null} count={3} />,
    );
    expect(
      (screen.getByRole('button', { name: 'Fewer sprints' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<VelocityRangeControls sprints={SPRINTS} endingAt={null} count={52} />);
    expect(
      (screen.getByRole('button', { name: 'More sprints' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the latest completed sprint as the blank choice and the count as text', () => {
    render(<VelocityRangeControls sprints={SPRINTS} endingAt={null} count={7} />);
    expect(screen.getByText('Ending at')).toBeTruthy();
    expect(screen.getByText('Latest completed — Sprint 3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('picking a sprint navigates with endingAt, and Latest clears it', () => {
    render(<VelocityRangeControls sprints={SPRINTS} endingAt={null} count={7} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Ending at' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sprint 2' }));
    expect(push).toHaveBeenLastCalledWith('/reports/velocity?endingAt=s2');
  });
});
