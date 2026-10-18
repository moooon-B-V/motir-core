// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The Sprint report's sprint picker (Story MOTIR-8919): grouped options in the
// order it is handed, and a pick navigates to the sprint's PATH URL.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { SprintReportSprintPicker } from '@/app/(authed)/sprints/[id]/report/_components/SprintReportSprintPicker';

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
  { id: 'live', name: 'Sprint 3', state: 'active' as const },
  { id: 'done2', name: 'Sprint 2', state: 'complete' as const },
  { id: 'done1', name: 'Sprint 1', state: 'complete' as const },
];

describe('SprintReportSprintPicker', () => {
  it('lists the sprints in the order given, grouped Active then Completed', () => {
    render(<SprintReportSprintPicker sprints={SPRINTS} selectedSprintId="live" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Sprint' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.map((t) => t?.trim())).toEqual(['Sprint 3', 'Sprint 2', 'Sprint 1']);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('navigates to the chosen sprint by path', () => {
    render(<SprintReportSprintPicker sprints={SPRINTS} selectedSprintId="live" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Sprint' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sprint 1' }));
    expect(push).toHaveBeenLastCalledWith('/sprints/done1/report');
  });
});
