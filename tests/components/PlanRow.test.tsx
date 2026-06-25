// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanRow } from '@/app/(authed)/plans/_components/PlanRow';
import type { PlanRowView } from '@/app/(authed)/plans/_components/types';

// Component test for the Plans-list row (Subtask 7.21.1 / MOTIR-1338). Asserts
// the row binds the server-built view-model to the design (title, item count,
// when-label, the status pill, and the conditional stale flag) and links the
// whole row to the plan detail. happy-dom + the real `en` catalog (renderWithIntl)
// — no jest-dom (the component-test convention).

afterEach(() => cleanup());

function view(overrides: Partial<PlanRowView> = {}): PlanRowView {
  return {
    id: 'plan_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    itemCount: 14,
    staleCount: 0,
    whenKey: 'plannedAt',
    whenLabel: '2 hours ago',
    ...overrides,
  };
}

describe('PlanRow', () => {
  it('renders the title, item count + when-label, and links the row to the plan detail', () => {
    renderWithIntl(<PlanRow view={view()} />);
    expect(screen.getByText('Stripe Connect payouts')).toBeTruthy();
    expect(screen.getByText('14 items')).toBeTruthy();
    expect(screen.getByText('planned 2 hours ago')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Stripe Connect payouts/ });
    expect(link.getAttribute('href')).toBe('/plans/plan_1');
  });

  it('labels the when-line with the verb matching the lifecycle timestamp', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'approved', whenKey: 'approvedAt', whenLabel: 'yesterday' })}
      />,
    );
    expect(screen.getByText('approved yesterday')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders the declined status pill', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'declined', whenKey: 'declinedAt', whenLabel: '3 days ago' })}
      />,
    );
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('declined 3 days ago')).toBeTruthy();
  });

  it('shows the stale flag when staleCount > 0', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 3 })} />);
    expect(screen.getByText('3 may be out of date')).toBeTruthy();
  });

  it('omits the stale flag when nothing has drifted', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 0 })} />);
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });

  it('falls back to a placeholder title for an unnamed generating plan', () => {
    renderWithIntl(
      <PlanRow view={view({ title: '', status: 'generating', whenKey: 'createdAt' })} />,
    );
    expect(screen.getByText('Untitled plan')).toBeTruthy();
    expect(screen.getByText('Generating')).toBeTruthy();
  });

  it('uses the singular item label for a one-item plan', () => {
    renderWithIntl(<PlanRow view={view({ itemCount: 1 })} />);
    expect(screen.getByText('1 item')).toBeTruthy();
  });
});
