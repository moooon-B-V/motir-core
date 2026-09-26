// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { RoleMigrationReason } from '@/generated/prisma/client';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { RoleMigrationEntryDTO, RoleMigrationPageDTO } from '@/lib/dto/workspaces';

// The migration notice (Story MOTIR-6168 · MOTIR-6465; design panels 1g–1h):
// Managers only (the SERVER hands no page to anyone else), total over the
// report's reason enum, paged, and a dismissed row leaves for good.

const dismissAction = vi.fn();
const loadAction = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/actions', () => ({
  dismissRoleMigrationEntryAction: (...a: unknown[]) => dismissAction(...a),
  loadRoleMigrationPageAction: (...a: unknown[]) => loadAction(...a),
}));

import {
  ROLE_MIGRATION_REASONS,
  RoleMigrationNotice,
  describeBefore,
} from '@/app/(authed)/settings/workspace/_components/RoleMigrationNotice';

function entry(i: number, overrides: Partial<RoleMigrationEntryDTO> = {}): RoleMigrationEntryDTO {
  return {
    id: `e${i}`,
    userId: `u${i}`,
    name: `Person ${i}`,
    email: `p${i}@ex.com`,
    before: {
      workspaceRole: 'member',
      projects: [{ projectKey: 'PROD', role: 'viewer', customRoleName: null }],
      narrowedIn: [],
    },
    afterRole: 'viewer',
    afterCustomRoleName: null,
    reason: 'narrowest_kept',
    ...overrides,
  };
}

function page(entries: RoleMigrationEntryDTO[], extra: Partial<RoleMigrationPageDTO> = {}) {
  return { entries, total: entries.length, nextCursor: null, ...extra };
}

function renderNotice(initial: RoleMigrationPageDTO) {
  return render(
    <ToastProvider>
      <RoleMigrationNotice initial={initial} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  dismissAction.mockReset();
  loadAction.mockReset();
});
afterEach(() => cleanup());

describe('the reason is TOTAL over the enum', () => {
  it('the component lists exactly the Prisma enum’s values', () => {
    expect([...ROLE_MIGRATION_REASONS].sort()).toEqual(Object.values(RoleMigrationReason).sort());
  });

  it.each(Object.values(RoleMigrationReason))(
    'renders a sentence for %s, in en and zh',
    (reason) => {
      const reasons = (m: typeof en) =>
        (m.settings.members.migration.reason as Record<string, string>)[reason];
      expect(reasons(en)).toBeTruthy();
      expect(reasons(zh as typeof en)).toBeTruthy();
      renderNotice(page([entry(1, { reason })]));
      expect(screen.getByText(reasons(en)!)).toBeTruthy();
    },
  );
});

describe('what a row says', () => {
  it('before → after: the legacy role and every project role, then the new role', () => {
    renderNotice(
      page([
        entry(1, {
          before: {
            workspaceRole: 'admin',
            projects: [
              { projectKey: 'PROD', role: 'viewer', customRoleName: null },
              { projectKey: 'OPS', role: 'member', customRoleName: 'Contractor' },
            ],
            narrowedIn: [],
          },
          afterRole: 'member',
          afterCustomRoleName: 'Contractor ∩ Reviewer',
          reason: 'custom_role_merged',
        }),
      ]),
    );
    expect(screen.getByText('Workspace admin · Viewer in PROD · Contractor in OPS')).toBeTruthy();
    expect(screen.getByText('Contractor ∩ Reviewer')).toBeTruthy();
    expect(screen.getByText('Changed by the move to workspace roles')).toBeTruthy();
    expect(screen.getByText('Managers only')).toBeTruthy();
    expect(screen.getByText('1 person')).toBeTruthy();
  });

  it('a never-wider row names the projects its keys narrowed in', () => {
    const t = (key: string, v?: Record<string, string | number>) =>
      key === 'members.migration.narrowedIn' ? `Narrower in ${String(v?.['projects'])}` : key;
    expect(
      describeBefore(
        {
          workspaceRole: null,
          projects: [],
          narrowedIn: [
            { projectKey: 'PROD', lost: ['work_item:edit'] },
            { projectKey: 'OPS', lost: [] },
          ],
        },
        t,
      ),
    ).toBe('Narrower in PROD, OPS');
  });
});

describe('describeBefore — the parts it leaves out', () => {
  it('a project row with neither a built-in nor a custom role says nothing about that project', () => {
    const t = (key: string, v?: Record<string, string | number>) =>
      key === 'members.migration.projectRole'
        ? `${String(v?.['role'])} in ${String(v?.['project'])}`
        : key;
    expect(
      describeBefore(
        {
          workspaceRole: null,
          projects: [
            { projectKey: 'PROD', role: null, customRoleName: null },
            { projectKey: 'OPS', role: null, customRoleName: 'Contractor' },
          ],
          narrowedIn: [],
        },
        t,
      ),
    ).toBe('Contractor in OPS');
  });
});

describe('dismiss and paging', () => {
  it('a dismissed row leaves, the count drops, and it does not come back', async () => {
    dismissAction.mockResolvedValue({ ok: true });
    renderNotice(page([entry(1), entry(2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Person 1' }));
    await waitFor(() => expect(screen.queryByText('Person 1')).toBeNull());
    expect(dismissAction).toHaveBeenCalledWith('e1');
    expect(screen.getByText('1 person')).toBeTruthy();
    expect(await screen.findByText('Dismissed')).toBeTruthy();
  });

  it('a refused dismiss keeps the row and says so', async () => {
    dismissAction.mockResolvedValue({
      ok: false,
      error: 'Only a workspace Manager can change roles.',
    });
    renderNotice(page([entry(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Person 1' }));
    expect(await screen.findByText('Couldn’t dismiss it')).toBeTruthy();
    expect(screen.getByText('Person 1')).toBeTruthy();
  });

  it('the last dismiss removes the whole card — no “nothing changed” chrome', async () => {
    dismissAction.mockResolvedValue({ ok: true });
    renderNotice(page([entry(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Person 1' }));
    await waitFor(() =>
      expect(screen.queryByText('Changed by the move to workspace roles')).toBeNull(),
    );
  });

  it('pages at 20: Show more appends the next page and disappears on the last', async () => {
    const first = Array.from({ length: 20 }, (_, i) => entry(i));
    loadAction.mockResolvedValue({ ok: true, page: page([entry(20), entry(21)], { total: 22 }) });
    renderNotice(page(first, { total: 22, nextCursor: 'e19' }));
    expect(screen.getByText('22 people')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Person 21')).toBeTruthy();
    expect(loadAction).toHaveBeenCalledWith('e19');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('a Show more that fails keeps the rows and the control; an overlapping page is de-duplicated', async () => {
    const first = Array.from({ length: 20 }, (_, i) => entry(i));
    loadAction.mockResolvedValueOnce({ ok: false, error: 'nope' });
    renderNotice(page(first, { total: 21, nextCursor: 'e19' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(loadAction).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    // The refused load settles back to an enabled control (the transition ends).
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Show more' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    // The next page repeats the last row (a row dismissed elsewhere shifted the
    // cursor): it is shown once.
    loadAction.mockResolvedValueOnce({
      ok: true,
      page: page([entry(19), entry(20)], { total: 21 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Person 20')).toBeTruthy();
    expect(screen.getAllByText('Person 19')).toHaveLength(1);
  });

  it('a person with no name is initialled from their email', () => {
    renderNotice(page([entry(1, { name: '', email: 'quinn@ex.com' })]));
    expect(screen.getByText('Q')).toBeTruthy();
  });

  it('renders nothing when nothing is open', () => {
    const { container } = renderNotice(page([]));
    expect(container.textContent).toBe('');
  });
});
