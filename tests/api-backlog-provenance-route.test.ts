import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { truncateAuthTables } from './helpers/db';

// POST /api/backlog stamps planning provenance `manual` (Story MOTIR-1685 ·
// MOTIR-1689). The backlog / sprint-planning "+ Create issue" row is a manual UI
// create, so — like the board create action — its item must read
// `planningSource = manual`, SERVER-SET (never from the request body). Only a
// create→read-back through the route catches a dropped field on this whitelisted
// create (the create-action-whitelist lesson). Real Postgres; we stub only the
// two context resolvers the test env can't supply via cookies.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const { POST } = await import('@/app/api/backlog/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture) {
  session.current = {
    user: { id: fx.ownerId, email: 'backlog@example.com', name: 'Backlog Owner' },
  };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/api/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/backlog — planning provenance', () => {
  it('stamps planningSource = manual (harness/model null) on a backlog create', async () => {
    const fx = await makeWorkItemFixture({ name: 'BacklogProv' });
    signInAs(fx);

    const res = await post({ kind: 'task', title: 'From the backlog' });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as {
      id: string;
      planningSource: string | null;
      planningHarness: string | null;
      planningModel: string | null;
      implementationSource: string | null;
    };
    expect(dto.planningSource).toBe('manual');
    expect(dto.planningHarness).toBeNull();
    expect(dto.planningModel).toBeNull();
    expect(dto.implementationSource).toBeNull();

    // Persisted, not just echoed.
    const row = await db.workItem.findUnique({ where: { id: dto.id } });
    expect(row!.planningSource).toBe('manual');
  });

  it('IGNORES a client-forged provenance in the body — source stays server-set manual', async () => {
    const fx = await makeWorkItemFixture({ name: 'BacklogForge' });
    signInAs(fx);

    const res = await post({
      kind: 'task',
      title: 'Forged',
      provenance: { planning: { source: 'native', harness: 'evil', model: 'evil' } },
      planningSource: 'native',
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; planningSource: string | null };
    expect(dto.planningSource).toBe('manual');
    const row = await db.workItem.findUnique({ where: { id: dto.id } });
    expect(row!.planningHarness).toBeNull();
  });
});
