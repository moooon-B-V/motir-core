// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// The WORKSPACE-tier danger zone after the move (MOTIR-6312 ·
// `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 2): Leave
// stays, Delete is gone — for everyone, at `/settings/workspace` AND in the
// one-workspace fold-in, which mount this same component. An Owner/Admin gets a
// POINTER to where removal went; a Member gets nothing.
vi.mock('@/app/(authed)/settings/workspace/actions', () => ({
  leaveWorkspaceAction: vi.fn(async () => ({ ok: true })),
}));

import { DangerZoneCard } from '@/app/(authed)/settings/workspace/_components/DangerZoneCard';

function renderCard(props: {
  isLastMember?: boolean;
  canRemoveWorkspace: boolean;
  placement: 'workspace' | 'foldIn';
}) {
  return render(
    <ToastProvider>
      <DangerZoneCard isLastMember={props.isLastMember ?? false} {...props} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Delete workspace is gone from the workspace tier', () => {
  for (const placement of ['workspace', 'foldIn'] as const) {
    for (const canRemoveWorkspace of [true, false]) {
      it(`${placement}, ${canRemoveWorkspace ? 'Owner/Admin' : 'Member'}: Leave stays, no Delete`, () => {
        renderCard({ canRemoveWorkspace, placement });
        expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
        expect(screen.queryByText(/delete workspace/i)).toBeNull();
      });
    }
  }
});

describe('the pointer, not a door', () => {
  it('an Owner/Admin in workspace settings is pointed at Organization settings → Workspaces', () => {
    renderCard({ canRemoveWorkspace: true, placement: 'workspace' });
    const link = screen.getByRole('link', {
      name: 'To remove this workspace, go to Organization settings → Workspaces.',
    });
    expect(link.getAttribute('href')).toBe('/settings/organization');
  });

  it('in the fold-in the pointer says “Workspaces above” — the card is on the same page', () => {
    renderCard({ canRemoveWorkspace: true, placement: 'foldIn' });
    expect(screen.getByTestId('workspace-remove-hint').textContent).toBe(
      'To remove this workspace, use Workspaces above.',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a Member, who cannot remove, is told nothing', () => {
    renderCard({ canRemoveWorkspace: false, placement: 'workspace' });
    expect(screen.queryByTestId('workspace-remove-hint')).toBeNull();
  });
});
