// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Subtask MOTIR-2473 — THE AFFORDANCES ASK THE KEY.
//
// The two booleans were the last place in the client where a role was still a
// RANK rather than a set. A role someone composed resolves to a permission set
// the server understands perfectly, and the interface then rounded it off to
// "can edit: yes, can administer: no" — everything downstream of that rounding
// was guesswork.
//
// This file pins the two things the sweep is for: that the keys are the ones the
// SERVER asserts, and that nothing changed TREATMENT (a disabled control did not
// become a hidden one, or the reverse). The card is deliberately NOT
// behaviour-neutral in a few lines, and those lines are named individually below
// rather than buried.

const { openCreateIssue } = vi.hoisted(() => ({ openCreateIssue: vi.fn() }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue,
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { CreateIssueButton } from '@/app/(authed)/_components/CreateIssueButton';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';

const MEMBER = [...BUILTIN_ROLE_PERMISSIONS.member];
const VIEWER = [...BUILTIN_ROLE_PERMISSIONS.viewer];

function withKeys(ui: ReactElement, permissions: readonly PermissionKey[]) {
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>{ui}</ProjectAccessProvider>,
  );
}

afterEach(() => {
  cleanup();
  openCreateIssue.mockClear();
});

describe('the keys the sweep landed, read off the gates', () => {
  // The pairing is asserted against the SERVICE source, so a later card that
  // re-keys a write cannot leave an affordance gating on a key nobody asserts.
  const service = readFileSync(join(process.cwd(), 'lib/services/workItemsService.ts'), 'utf8');

  it('archive, unarchive and delete all assert `work_item:delete` in the service', () => {
    // This is the finding the card did not predict. `archiveWorkItem` and
    // `unarchiveWorkItem` were gated in the UI on `canEdit` — and a MEMBER holds
    // `work_item:edit` and NOT `work_item:delete`, so the Archive row the product
    // offered them earned a 403 on click.
    for (const method of ['archiveWorkItem', 'unarchiveWorkItem', 'deleteWorkItem']) {
      const body = service.split(`async ${method}(`)[1]?.slice(0, 1600);
      expect(body, `${method} not found`).toBeDefined();
      expect(body, `${method} no longer asserts 'work_item:delete'`).toContain(
        "'work_item:delete'",
      );
    }
  });

  it('a MEMBER does not hold `work_item:delete` — which is why that row moves', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.member.has('work_item:edit')).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.member.has('work_item:delete')).toBe(false);
    expect(BUILTIN_ROLE_PERMISSIONS.admin.has('work_item:delete')).toBe(true);
  });

  it('the context no longer offers the two booleans to reach for', () => {
    const provider = readFileSync(
      join(process.cwd(), 'app/(authed)/_components/ProjectAccessProvider.tsx'),
      'utf8',
    );
    const type = provider.split('interface ProjectAccessContextValue {')[1]!.split('}')[0]!;
    expect(type).toContain('can:');
    // Deleted rather than left derived: a convenience field that still compiles
    // is a field the next component will use.
    expect(type).not.toContain('canEdit');
    expect(type).not.toContain('canManage');
  });
});

describe('DELETE is offered on `work_item:delete`, not `project:administer`', () => {
  const menu = (canEdit: boolean, canDelete: boolean) => (
    <WorkItemActionsMenu
      itemId="wi_1"
      identifier="MOTIR-1"
      title="A work item"
      canEdit={canEdit}
      canDelete={canDelete}
      onDeleted={() => {}}
      onArchived={() => {}}
    />
  );

  it('an actor holding DELETE but NOT administer is offered Delete', async () => {
    // The case that was wrong on `main` and that no built-in role exposes: the
    // two answers only agree by coincidence, and a composed role separates them.
    withKeys(menu(true, true), ['work_item:edit', 'work_item:delete']);
    screen.getByRole('button', { name: /actions/i }).click();
    expect(await screen.findByRole('menuitem', { name: /delete/i })).toBeTruthy();
  });

  it('an actor without it is offered no Delete row — hidden, not disabled', async () => {
    // Treatment unchanged: this menu has always HIDDEN rows the actor lacks the
    // capability for ("the permission law", its own source calls it), and that is
    // treatment-table row 5. The sweep re-points the key, never the treatment.
    withKeys(menu(true, false), MEMBER);
    screen.getByRole('button', { name: /actions/i }).click();
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: /delete/i })).toBeNull();
  });
});

describe('treatment is UNCHANGED for a viewer (design panel 5)', () => {
  it('the Create control is still visible-and-disabled, never absent', () => {
    // Treatment-table row 8. A story about hiding things is exactly the context
    // in which someone helpfully hides this too.
    withKeys(<CreateIssueButton />, VIEWER);
    const control = screen.getByLabelText(/create/i);
    expect(control).toBeTruthy();
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.tagName).toBe('SPAN'); // not a button — no functional path
  });

  it('and it is a real button again for an actor who holds the key', () => {
    withKeys(<CreateIssueButton />, MEMBER);
    const control = screen.getByLabelText(/create/i);
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('aria-disabled')).toBeNull();
  });
});
