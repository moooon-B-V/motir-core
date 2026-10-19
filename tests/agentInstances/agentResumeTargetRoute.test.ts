import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  AgentRunCommandInvalidError,
  AgentRunCommandMismatchError,
} from '@/lib/agentInstances/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { fx, setUpHarness, tearDownHarness } from './_harness';

// GET /api/work-items/[id]/agent-runs/resume-target (Story MOTIR-8981 · MOTIR-9046):
// the route's answers over the real service and database; only the session and
// workspace-context resolvers the vitest env cannot provide are stubbed — the
// precedent `agentInstanceRunRoutes.test.ts` sets.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const route = await import('@/app/api/work-items/[id]/agent-runs/resume-target/route');

beforeEach(async () => {
  await setUpHarness();
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const read = (key: string) =>
  route.GET(new Request(`http://test/api/work-items/${key}/agent-runs/resume-target`), {
    params: Promise.resolve({ id: key }),
  });

describe('GET /api/work-items/[id]/agent-runs/resume-target', () => {
  it('answers 200 { lastRun: null } for a card never run, uncached', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'never run' },
      fx.ctx,
    );
    const res = await read(item.identifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ lastRun: null });
  });

  it('answers 404 WORK_ITEM_NOT_FOUND for a key that does not exist', async () => {
    const res = await read(`${fx.projectIdentifier}-99999`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('answers the sign-in refusal when there is no session', async () => {
    session.user = null;
    ctxRef.current = null;
    const res = await read(`${fx.projectIdentifier}-1`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('the run-command errors', () => {
  it('carry their code and what the caller needs to act', () => {
    const invalid = new AgentRunCommandInvalidError('review', ['run', 'fix', 'continue']);
    expect(invalid.code).toBe('agent_run_command_invalid');
    expect(invalid.message).toBe('command must be one of run, fix, continue.');
    expect(invalid.name).toBe('AgentRunCommandInvalidError');
    const mismatch = new AgentRunCommandMismatchError('r1', 'fix', 'run');
    expect(mismatch).toMatchObject({ code: 'agent_run_command_mismatch', runId: 'r1' });
    expect(mismatch.message).toContain('fix');
    expect(mismatch.message).toContain('run');
  });
});
