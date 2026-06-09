// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

// Component tests for the Story 6.4 · Subtask 6.4.6 UI gating:
//   * the no-access state a non-member hits on a private project;
//   * the role-affordance treatment — create controls render DISABLED (not
//     absent) for a read-only actor;
//   * the assignee picker is exactly the (already access-scoped) member list it
//     is handed (the scoping itself is service-tested in
//     project-access-ui-gating.test.ts).

// The create entry points read the shell create-issue context; stub it so these
// DB-free unit renders don't pull the real CreateIssueModal (→ server action →
// db). `canCreate: true` = there IS an active project; the EDIT gate is what
// ProjectAccessProvider supplies.
const { openCreateIssue } = vi.hoisted(() => ({ openCreateIssue: vi.fn() }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue,
    canCreate: true,
    issuesChangedAt: 0,
  }),
}));

import { NewIssueButton } from '@/app/(authed)/issues/_components/NewIssueButton';
import { CreateIssueButton } from '@/app/(authed)/_components/CreateIssueButton';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { ContentSectionCard } from '@/app/(authed)/issues/[key]/_components/ContentSectionCard';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

function withAccess(ui: ReactElement, canEdit: boolean) {
  return renderWithIntl(<ProjectAccessProvider canEdit={canEdit}>{ui}</ProjectAccessProvider>);
}

afterEach(() => {
  cleanup();
  openCreateIssue.mockClear();
});

describe('NoAccessState (6.4.6)', () => {
  it('renders the lock panel with copy + a back-to-projects link', () => {
    renderWithIntl(
      <NoAccessState
        title="You don’t have access to this project"
        description="This project is private."
        backHref="/dashboard"
        backLabel="Back to projects"
      />,
    );
    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.getByText('This project is private.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Back to projects' });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

describe('NewIssueButton role affordance (6.4.6)', () => {
  it('is enabled and opens the modal when the actor can edit', () => {
    withAccess(<NewIssueButton />, true);
    const btn = screen.getByRole('button', { name: 'New work item' });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(openCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('renders DISABLED (not absent) and does not open the modal when read-only', () => {
    withAccess(<NewIssueButton />, false);
    const btn = screen.getByRole('button', { name: 'New work item' });
    // Present but disabled — the 6.4.6 "disabled, not missing" treatment.
    expect(btn.hasAttribute('disabled')).toBe(true);
    fireEvent.click(btn);
    expect(openCreateIssue).not.toHaveBeenCalled();
  });
});

describe('CreateIssueButton role affordance (6.4.6)', () => {
  it('is an interactive button when the actor can edit', () => {
    withAccess(<CreateIssueButton />, true);
    const btn = screen.getByRole('button', { name: 'Create work item' });
    fireEvent.click(btn);
    expect(openCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('renders a non-interactive, aria-disabled affordance when read-only', () => {
    withAccess(<CreateIssueButton />, false);
    // No interactive button — instead a disabled-looking affordance.
    expect(screen.queryByRole('button', { name: 'Create work item' })).toBeNull();
    const affordance = screen.getByLabelText('Create work item');
    expect(affordance.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Edit affordance is HIDDEN for read-only (6.4.6)', () => {
  // The read-only path passes `editHref={undefined}` (the issue-detail page
  // computes this from canEdit), so the section's "Edit" link is not rendered —
  // the PM-directed "hide the edit button" treatment, distinct from the
  // disabled-with-tooltip create button.
  it('renders the section "Edit" link only when an editHref is provided', () => {
    const { rerender } = renderWithIntl(
      <ContentSectionCard title="Description" editHref="/issues/PROD-7/edit">
        <p>body</p>
      </ContentSectionCard>,
    );
    expect(screen.getByRole('link', { name: /Edit/ })).toBeTruthy();

    rerender(
      <ContentSectionCard title="Description" editHref={undefined}>
        <p>body</p>
      </ContentSectionCard>,
    );
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
  });
});

describe('AssigneePicker is the handed (access-scoped) member list (6.4.6)', () => {
  it('offers exactly the members passed in, plus Unassigned', () => {
    const members: WorkspaceMemberDTO[] = [
      { userId: 'u1', name: 'Ada Member', email: 'ada@ex.com', role: 'member' },
      { userId: 'u2', name: 'Bo Member', email: 'bo@ex.com', role: 'member' },
    ];
    renderWithIntl(<AssigneePicker members={members} value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Assignee' }));
    expect(screen.getByRole('option', { name: 'Unassigned' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Ada Member/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Bo Member/ })).toBeTruthy();
    // A workspace member NOT in the scoped list never appears as an option.
    expect(screen.queryByRole('option', { name: /Carol/ })).toBeNull();
  });
});
