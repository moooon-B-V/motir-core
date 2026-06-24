// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { DashboardSummaryDto } from '@/lib/dto/dashboards';
import { DashboardsHome } from '@/app/(authed)/dashboard/_components/DashboardsHome';

// Next's Link reads usePathname internally in some paths; stub navigation so the
// happy-dom render doesn't throw.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function dash(overrides: Partial<DashboardSummaryDto> = {}): DashboardSummaryDto {
  return {
    id: 'dash_1',
    name: 'Team Pulse',
    access: 'private',
    layout: 'two',
    owner: { id: 'u_yue', name: 'Yue' },
    isOwner: true,
    widgetCount: 3,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardsHome — surface-material coverage (MOTIR-1314)', () => {
  it('tags the dashboard-list card with data-surface="card" so the material layer reaches it', () => {
    const { container } = renderWithIntl(
      <ToastProvider>
        <DashboardsHome dashboards={[dash()]} />
      </ToastProvider>,
    );

    // The row renders (sanity — the list card is the populated path, not empty state).
    expect(screen.getByText('Team Pulse')).toBeTruthy();

    // The list card must emit the surface-material hook (neumorphism / glass /
    // aurora apply via [data-style] [data-surface='card']); without it the
    // /dashboard list stayed flat under those styles.
    const surface = container.querySelector('[data-surface="card"]');
    expect(surface).not.toBeNull();
    // It is the rounded card container that wraps the rows.
    expect(surface?.className).toContain('rounded-(--radius-card)');
  });
});
