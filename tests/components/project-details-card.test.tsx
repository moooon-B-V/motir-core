// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectDetailsCard } from '@/app/(authed)/settings/project/_components/ProjectDetailsCard';

// ProjectDetailsCard (Subtask 6.5.3) — the read-only Details landing body. The
// identity rows are identical for every viewer; the ROLE SPLIT is the contract
// under test (the verified 1.3.4 / 6.4 rule the mock's role-states panel draws):
//   * admin → "Admin" pill + the editing seam + the Archive danger zone;
//   * non-admin member → "Read-only" pill, NO seam, NO danger zone.
// The danger zone re-houses ArchiveProjectCard → ArchiveProjectModal, which pull
// next/navigation + the archive Server Action — stubbed here so the unit render
// stays pure (the modal is closed, the action never fires).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  archiveProjectAction: vi.fn(),
}));

afterEach(cleanup);

const baseProps = {
  projectId: 'p-1',
  projectName: 'Motir',
  projectIdentifier: 'PROD',
  workspaceName: 'moooon',
  createdLabel: '29 May 2026',
};

function renderCard(props: { canManage: boolean }) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectDetailsCard {...baseProps} {...props} />
    </ToastProvider>,
  );
}

describe('ProjectDetailsCard', () => {
  it('renders the read-only identity rows + avatar initial for every viewer', () => {
    renderCard({ canManage: true });
    // Field labels + values from the mock's Details panel.
    expect(screen.getByText('Avatar')).toBeTruthy();
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Motir')).toBeTruthy();
    expect(screen.getByText('Key')).toBeTruthy();
    expect(screen.getByText('PROD')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('moooon')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('29 May 2026')).toBeTruthy();
    // Avatar chip = the project name's initial.
    expect(screen.getByText('M')).toBeTruthy();
  });

  it('shows the Admin pill, the editing seam, and the Archive danger zone for an admin', () => {
    renderCard({ canManage: true });
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.queryByText('Read-only')).toBeNull();
    expect(screen.getByText(/Editing name, key and avatar/)).toBeTruthy();
    // The re-homed danger zone (ArchiveProjectCard).
    expect(screen.getByText('Danger zone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('shows the Read-only pill and HIDES the seam + danger zone for a non-admin member', () => {
    renderCard({ canManage: false });
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.queryByText('Admin')).toBeNull();
    // No editing seam (only admins gain editing in 6.8).
    expect(screen.queryByText(/Editing name, key and avatar/)).toBeNull();
    // Archive is admin-gated — the danger zone is absent.
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    // Identity is still fully visible.
    expect(screen.getByText('Motir')).toBeTruthy();
    expect(screen.getByText('PROD')).toBeTruthy();
  });
});
