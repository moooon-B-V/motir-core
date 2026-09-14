import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntitlementExceededError } from '@/lib/billing/errors';
import type { ProjectContext } from '@/lib/projects';

// MOTIR-5133 — the §4.1 work-item cap refusal carries its KIND out of the
// action, so the create modal can pick the translated sentence by it.
//
// Before this card the action answered `{ ok: false, error: err.message }` —
// the server's English sentence and nothing a client could translate. This is a
// test of the action's ERROR BOUNDARY, not of the cap
// (`entitlementsService.test.ts` covers that), so the service is stubbed and no
// database is needed.

const { createWorkItem } = vi.hoisted(() => ({ createWorkItem: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  getSession: async () => ({ user: { id: 'user_5133', email: 'cap@example.com', name: 'Cap' } }),
}));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async (): Promise<ProjectContext> =>
    ({
      userId: 'user_5133',
      workspaceId: 'ws_5133',
      projectId: 'proj_5133',
    }) as ProjectContext,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/services/workItemsService', () => ({ workItemsService: { createWorkItem } }));

const { createIssueAction } = await import('@/app/(authed)/items/actions');

afterEach(() => {
  vi.clearAllMocks();
});

describe('createIssueAction — the §4.1 work-item cap', () => {
  it('returns the refusal WITH its entitlement kind', async () => {
    const err = new EntitlementExceededError('work_items', { limit: 500, usage: 500 });
    createWorkItem.mockRejectedValue(err);

    const result = await createIssueAction({ kind: 'task', title: 'One too many' });

    expect(result).toEqual({ ok: false, error: err.message, entitlement: 'work_items' });
  });

  it('any other fault still propagates untouched', async () => {
    createWorkItem.mockRejectedValue(new Error('connection terminated'));
    await expect(createIssueAction({ kind: 'task', title: 'x' })).rejects.toThrow(
      'connection terminated',
    );
  });
});
