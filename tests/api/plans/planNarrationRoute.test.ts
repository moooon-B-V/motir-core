import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { plansService } from '@/lib/services/plansService';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { truncateAuthTables, truncateRateLimitCounters } from '@/tests/helpers/db';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// `GET /api/plans/[id]/narration` (Story MOTIR-8060 · Subtask MOTIR-8063) — the
// earlier-sentences page, through the REAL route. The paging itself is proven in
// `tests/integration/plans/planNarrationRead.test.ts`; asserted here is the HTTP
// layer: the query parsing and its 400, the 404s the review route also gives, and
// a Visitor served by the visitor branch only where the review read serves one.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const wsCtx = { current: null as WorkspaceContext | null };
const incoming = { current: new Headers() };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
vi.mock('next/headers', () => ({
  headers: async () => incoming.current,
  cookies: async () => ({ get: () => undefined }),
}));

const { GET } = await import('@/app/api/plans/[id]/narration/route');

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  session.current = null;
  activeCtx.current = null;
  wsCtx.current = null;
  incoming.current = new Headers();
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function asMember(fx: WorkItemFixture) {
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'O' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project as unknown as ProjectContext['project'],
  };
  wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

async function asVisitor(fx: WorkItemFixture) {
  const ctx = await consentedVisitor(fx.projectIdentifier);
  session.current = { user: { id: ctx.actorUserId, email: 'stranger@example.com', name: 'S' } };
  incoming.current = new Headers({ [VISITOR_ADDRESS_HEADER]: fx.projectIdentifier });
}

const call = (planId: string, query: string, address?: string) =>
  GET(
    new Request(`http://localhost:3000/api/plans/${planId}/narration${query}`, {
      headers: address ? { [VISITOR_ADDRESS_HEADER]: address } : {},
    }),
    { params: Promise.resolve({ id: planId }) },
  );

/** A public project's generating plan narrating three sentences, and one that touches a
 *  private epic's descendant. */
async function fixture() {
  const fx = await makeWorkItemFixture({ name: 'Route', identifier: 'NRTE' });
  await adminDb.project.update({ where: { id: fx.projectId }, data: projectAccessData('public') });
  const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
  const hidden = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden',
    parentId: epic.id,
  });
  await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });

  const plan = async (modifyHidden: boolean) => {
    const p = await plansService.createPlan(fx.projectId, { title: 'Narrated' }, fx.ctx);
    if (modifyHidden) {
      await plansService.addProposals(
        p.id,
        [{ op: 'modify', workItemId: hidden.id, patch: { title: 'Renamed' } }],
        fx.ctx,
      );
    }
    await plansService.recordPlanStep(
      p.id,
      { sessionKey: 's', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanNarration(
      p.id,
      { sessionKey: 's', narration: ['One.', 'Two.', 'Three.'] },
      fx.ctx,
    );
    return p.id;
  };
  return { fx, visible: await plan(false), secret: await plan(true) };
}

describe('GET /api/plans/[id]/narration', () => {
  it('a member gets the page before `beforeSeq`, honouring `limit`', async () => {
    const t = await fixture();
    asMember(t.fx);
    const res = await call(t.visible, '?beforeSeq=4&limit=2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      entries: [
        { seq: 2, body: 'Two.', sessionKey: 's' },
        { seq: 3, body: 'Three.', sessionKey: 's' },
      ],
      earlierCount: 1,
    });

    const all = (await (await call(t.visible, '?beforeSeq=4')).json()) as {
      entries: unknown[];
    };
    expect(all.entries).toHaveLength(3);
  });

  it.each([
    ['no beforeSeq', ''],
    ['a non-integer beforeSeq', '?beforeSeq=abc'],
    ['a fractional beforeSeq', '?beforeSeq=2.5'],
    ['beforeSeq 0', '?beforeSeq=0'],
    ['limit 0', '?beforeSeq=4&limit=0'],
    ['limit over the window', '?beforeSeq=4&limit=101'],
    ['a non-integer limit', '?beforeSeq=4&limit=ten'],
  ])('answers 400 INVALID_NARRATION_PAGE on %s', async (_label, query) => {
    const t = await fixture();
    asMember(t.fx);
    const res = await call(t.visible, query);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_NARRATION_PAGE');
  });

  it('answers 404 for an unknown plan', async () => {
    const t = await fixture();
    asMember(t.fx);
    expect((await call('cm-not-a-plan', '?beforeSeq=4')).status).toBe(404);
  });

  it('serves a consented Visitor a visible plan, and 404s the one touching a private epic', async () => {
    const t = await fixture();
    await asVisitor(t.fx);
    const ok = await call(t.visible, '?beforeSeq=4', t.fx.projectIdentifier);
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { entries: { body: string }[] }).entries.map((e) => e.body),
    ).toEqual(['One.', 'Two.', 'Three.']);

    const hidden = await call(t.secret, '?beforeSeq=4', t.fx.projectIdentifier);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain('One.');
  });
});
