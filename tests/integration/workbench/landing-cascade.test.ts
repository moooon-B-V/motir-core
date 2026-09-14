import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import type { ProjectContext } from '@/lib/projects';

// THE LANDING CASCADE, WIRED (Story MOTIR-5213 · MOTIR-5219) — the story gate's
// integration seam, against real Postgres and the shipped services.
//
// The resolver's own truth table is `tests/workbench/landing.test.ts` and is NOT
// re-covered here. What no unit can see is the wiring AROUND that pure function:
// that the page, given a real reader in a real project, reads the counts the
// cascade claims to read and forwards on them. So these cases call the PAGE — the
// async Server Component, which is a function — with real services underneath,
// and seed each fixture through the product's own writes.
//
// ⚠️ WHAT IS MOCKED, AND WHY EXACTLY THAT MUCH. The request boundary and nothing
// under it: the SESSION (`getSession`, the one mock the repo convention allows),
// the ACTIVE-PROJECT resolver (it reads cookies, which a test has none of), the
// `next-intl` server translator (it reads the request's locale), and
// `next/navigation` (so a `redirect()` is observable as a thrown address instead
// of a framework control-flow signal). `homeService`, the repositories and the
// database are the real ones — which is the whole point of this file.

const actor = vi.hoisted(() => ({ ctx: null as ProjectContext | null }));

vi.mock('@/lib/auth', () => ({
  getSession: async () => (actor.ctx ? { user: { id: actor.ctx.userId } } : null),
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => actor.ctx }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as 'workbench' }),
  };
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

import WorkbenchPage from '@/app/(authed)/workbench/page';

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WBL' });
  actor.ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project as unknown as ProjectContext['project'],
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A task the reader owns (the creator is its reporter, and it is assigned to them). */
async function mine(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  return { id: item.id, identifier: item.identifier };
}

/** Moves a card the way the product does — never a direct `status` write. */
async function start(id: string): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
}

/** An `awaiting` gate ROUTED to the reader: the card is assigned to them. */
async function awaitingMyDecision(title: string): Promise<void> {
  const item = await mine(title);
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: `evidence-${item.id}`,
      },
      tx,
    ),
  );
}

/** Call the page as a request carrying `query`; the forwarded address, or null when it rendered. */
async function land(query: Record<string, string | string[]>): Promise<string | null> {
  try {
    await WorkbenchPage({ searchParams: Promise.resolve(query) });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('NEXT_REDIRECT:')) return message.slice('NEXT_REDIRECT:'.length);
    throw err;
  }
}

describe('the cascade, end to end over three seeded readers', () => {
  it('a reader with a decision waiting lands on To approve — even with work moving and waiting too', async () => {
    await awaitingMyDecision('Approve the design');
    await start((await mine('Moving')).id);
    await mine('Not started');
    expect(await land({})).toBe('/workbench?tab=approvals');
  });

  it('with nothing awaiting but something moving, lands on In progress', async () => {
    await start((await mine('Moving')).id);
    await mine('Not started');
    expect(await land({})).toBe('/workbench?tab=in-progress');
  });

  it('with nothing awaiting and nothing moving, lands on To do', async () => {
    await mine('Not started');
    expect(await land({})).toBe('/workbench?tab=todo');
  });

  it('with NOTHING anywhere, still lands on To do — the terminal rung is unconditional', async () => {
    expect(await land({})).toBe('/workbench?tab=todo');
  });

  it('an unknown, empty or repeated `?tab=` falls into the cascade rather than 404-ing', async () => {
    await start((await mine('Moving')).id);
    expect(await land({ tab: 'nonsense' })).toBe('/workbench?tab=in-progress');
    expect(await land({ tab: '' })).toBe('/workbench?tab=in-progress');
    expect(await land({ tab: ['Watching', 'todo'] })).toBe('/workbench?tab=in-progress');
  });

  it('carries the rest of the query through the forward', async () => {
    await awaitingMyDecision('Approve the design');
    expect(await land({ peek: 'WBL-1', page: '4' })).toBe('/workbench?tab=approvals&peek=WBL-1');
  });

  it('counts only what is ROUTED to the reader: a gate on somebody else’s card does not move them', async () => {
    // The first rung reads the reader's own queue. A gate that exists in the
    // project but waits on another person must not send this reader to an empty
    // To approve — which is the cascade reading the WRONG count.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Someone else decides this' },
      fx.ctx,
    );
    const other = await createTestUser({ email: 'other-landing@ex.com', name: 'Other' });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: other.id } });
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: `evidence-${item.id}`,
        },
        tx,
      ),
    );
    await mine('Not started');
    expect(await land({})).toBe('/workbench?tab=todo');
  });
});

describe('an explicit `?tab=` always wins — the resolver never runs', () => {
  it('renders To approve when asked, even while it is EMPTY and In progress is not', async () => {
    await start((await mine('Moving')).id);
    // The cascade would forward this reader to In progress; asking by address
    // must render the tab they asked for instead.
    expect(await land({ tab: 'approvals' })).toBeNull();
  });

  it('renders every known tab by its own address, whatever the counts say', async () => {
    await awaitingMyDecision('Approve the design');
    for (const tab of ['approvals', 'in-progress', 'todo', 'finished', 'watching']) {
      expect(await land({ tab }), `?tab=${tab} was overridden`).toBeNull();
    }
  });
});
