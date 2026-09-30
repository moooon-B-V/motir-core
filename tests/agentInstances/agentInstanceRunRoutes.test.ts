import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PROFILES } from '@/packages/cli/src/agentProfiles';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  AgentInstanceImageTooOldError,
  AgentInstanceWrongProjectError,
  AgentNotSignedInError,
  AgentProfileCannotRunError,
  AgentRunCardNotReadyError,
} from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import {
  NOT_OFFERED_AGENT_PROFILES,
  OFFERED_AGENT_PROFILES,
  RUNNABLE_AGENT_PROFILE_IDS,
  profileCanRunCards,
} from '@/lib/agentInstances/profiles';
import {
  AGENT_SIGN_IN_COMMAND,
  agentRunLaunchCommand,
  parseLaunchAnswer,
  parseSignInAnswer,
} from '@/lib/agentInstances/terminal';
import { DispatchRunAgentBusyError } from '@/lib/dispatchRuns/errors';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { agentInstanceRunLaunch } from '@/lib/jobs/definitions/agentInstanceRunLaunch';
import { engineJob } from '@/lib/jobs/engine/registry';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { fleet, fx, seedRepo, setUpHarness, stub, tearDownHarness } from './_harness';

// START A CARD'S RUN IN MY AGENT — the ROUTES, the launch JOB's registration and
// the pure pieces (Story MOTIR-6864 · MOTIR-7026). The routes are driven as HTTP
// over the real services and database; only the context resolvers the vitest env
// cannot provide are stubbed — the instance routes' precedent.

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

const startRoute = await import('@/app/api/work-items/[id]/agent-runs/route');
const agentsRoute = await import('@/app/api/work-items/[id]/agent-runs/agents/route');

const MASTER = 'm'.repeat(48);

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  fleet.setExecResponder((command) => ({
    exitCode: 0,
    stdout: command.includes('signin') ? '{"profile":"claude","state":"signed_in"}\n' : '',
    stderr: '',
  }));
  await seedRepo('acme', 'web');
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (key: string, body?: unknown) =>
  new Request(`http://test/api/work-items/${key}/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (key: string) => new Request(`http://test/api/work-items/${key}/agent-runs/agents`);

async function agent(name = 'yue-claude'): Promise<string> {
  return (await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx)).id;
}
const card = (title = 'a card') =>
  workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);

describe('POST /api/work-items/[id]/agent-runs', () => {
  it('201 with the run id, then 200 for the same key; 400 without an agent', async () => {
    const id = await agent();
    const item = await card();
    const res = await startRoute.POST(
      post(item.identifier, { agentInstanceId: id, idempotencyKey: 'k-1' }),
      params(item.identifier),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatchRunId: string; created: boolean; woke: boolean };
    expect(body).toMatchObject({ created: true, woke: false });
    const again = await startRoute.POST(
      post(item.identifier, { agentInstanceId: id, idempotencyKey: 'k-1' }),
      params(item.identifier),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { dispatchRunId: string }).dispatchRunId).toBe(
      body.dispatchRunId,
    );

    const bad = await startRoute.POST(post(item.identifier, {}), params(item.identifier));
    expect(bad.status).toBe(400);
    const none = await startRoute.POST(post(item.identifier), params(item.identifier));
    expect(none.status).toBe(400);
  });

  it('maps each refusal to its code and status', async () => {
    const id = await agent();
    const item = await card();
    const status = async (key: string, agentInstanceId: string) => {
      const res = await startRoute.POST(post(key, { agentInstanceId }), params(key));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect(await status(item.identifier, 'nope')).toMatchObject({
      status: 404,
      body: { code: 'agent_instance_not_found' },
    });
    expect(await status(`${fx.projectIdentifier}-9999`, id)).toMatchObject({ status: 404 });
    expect(await status('NOPE-1', id)).toMatchObject({ status: 404 });

    stub.installation = { 'acme/web': 404 };
    expect(await status(item.identifier, id)).toMatchObject({
      status: 409,
      body: { code: 'hosted_repository_not_writable' },
    });
    stub.installation = {};

    const spy = vi.spyOn(agentInstanceRunService, 'start');
    spy.mockRejectedValueOnce(
      new CiCreditsExhaustedError({
        organizationId: 'org',
        state: 'ci_credits_exhausted',
        consumedMinutes: 10,
        poolMinutes: 10,
        balance: 0,
      }),
    );
    expect((await status(item.identifier, id)).status).toBe(402);
    spy.mockRejectedValueOnce(new DispatchRunAgentBusyError(id, 'run-1', 'PROD-1'));
    expect(await status(item.identifier, id)).toMatchObject({
      status: 409,
      body: { code: 'agent_instance_run_active', runId: 'run-1', workItemKey: 'PROD-1' },
    });
    spy.mockRejectedValueOnce(new Error('kaboom'));
    await expect(status(item.identifier, id)).rejects.toThrow('kaboom');
    spy.mockRestore();

    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    stub.mayRun = false;
    expect(await status(item.identifier, id)).toMatchObject({
      status: 402,
      body: { code: 'agent_instance_start_refused', reason: 'credits' },
    });
  });

  it('a card another workspace holds reads as missing', async () => {
    const id = await agent();
    ctxRef.current = { userId: fx.ownerId, workspaceId: 'another' } as WorkspaceContext;
    const res = await startRoute.POST(post('PROD-1', { agentInstanceId: id }), params('PROD-1'));
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('GET /api/work-items/[id]/agent-runs/agents', () => {
  it('200 with the caller’s agents; 404 for a card that does not exist', async () => {
    await agent();
    const item = await card();
    const res = await agentsRoute.GET(get(item.identifier), params(item.identifier));
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: Array<{ name: string; refusal: null }> };
    expect(agents).toMatchObject([{ name: 'yue-claude', refusal: null }]);

    const missing = await agentsRoute.GET(
      get(`${fx.projectIdentifier}-9999`),
      params(`${fx.projectIdentifier}-9999`),
    );
    expect(missing.status).toBe(404);
    const spy = vi.spyOn(agentInstanceRunService, 'listAgentsForCard');
    spy.mockRejectedValueOnce(new AgentInstanceWrongProjectError('x'));
    expect((await agentsRoute.GET(get(item.identifier), params(item.identifier))).status).toBe(409);
    spy.mockRejectedValueOnce(new Error('kaboom'));
    await expect(agentsRoute.GET(get(item.identifier), params(item.identifier))).rejects.toThrow(
      'kaboom',
    );
  });
});

describe('both routes — the gate and a browse denial', () => {
  it('401 without a session; a card the caller cannot browse reads as missing', async () => {
    const item = await card();
    const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');
    const start = vi.spyOn(agentInstanceRunService, 'start');
    const list = vi.spyOn(agentInstanceRunService, 'listAgentsForCard');
    start.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'browse'));
    list.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'browse'));
    const denied = await startRoute.POST(
      post(item.identifier, { agentInstanceId: 'a' }),
      params(item.identifier),
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    expect((await agentsRoute.GET(get(item.identifier), params(item.identifier))).status).toBe(404);

    session.user = null;
    ctxRef.current = null;
    const anon = await startRoute.POST(
      post(item.identifier, { agentInstanceId: 'a' }),
      params(item.identifier),
    );
    expect(anon.status).toBe(401);
    expect((await agentsRoute.GET(get(item.identifier), params(item.identifier))).status).toBe(401);
  });
});

describe('the launch job', () => {
  it('is registered once per run, never retried, and returns the wait’s verdict when it is not ready', async () => {
    expect(agentInstanceRunLaunch.id).toBe('agent-instance-run/launch');
    const job = engineJob('agent-instance-run/launch')!;
    expect(job.maxAttempts).toBe(1);
    const spy = vi.spyOn(agentInstanceRunService, 'awaitAgent').mockResolvedValueOnce('noop');
    const step = { run: vi.fn() };
    expect(
      await job.handler(
        {
          step,
          event: { data: { dispatchRunId: 'r', workspaceId: 'w', idempotencyKey: 'k' } },
        } as never,
        { agentInstanceRun: agentInstanceRunService } as never,
      ),
    ).toBe('noop');
    expect(spy).toHaveBeenCalledWith('r');
    expect(step.run).not.toHaveBeenCalled();
  });
});

describe('the pure pieces', () => {
  it('the launch command carries the key and run id, never a credential; sign-in runs as node', () => {
    expect(agentRunLaunchCommand('PROD-7', 'run-1').slice(-4)).toEqual([
      'run',
      'PROD-7',
      '--run-id',
      'run-1',
    ]);
    expect(AGENT_SIGN_IN_COMMAND.slice(0, 3)).toEqual(['runuser', '-u', 'node']);
  });

  it('reads the sign-in answer, and gives none for a failure or an unknown word', () => {
    expect(
      parseSignInAnswer({
        exitCode: 0,
        stdout: 'noise\n{"profile":"claude","state":"signed_out"}\n',
      }),
    ).toBe('signed_out');
    expect(parseSignInAnswer({ exitCode: 0, stdout: '{"state":"unknown"}' })).toBe('unknown');
    expect(parseSignInAnswer({ exitCode: 0, stdout: '{"state":"signed_in"}' })).toBe('signed_in');
    expect(parseSignInAnswer({ exitCode: 1, stdout: '{"state":"signed_in"}' })).toBeNull();
    expect(parseSignInAnswer({ exitCode: 0, stdout: '{not json' })).toBeNull();
    expect(parseSignInAnswer({ exitCode: 0, stdout: '{"state":"maybe"}' })).toBeNull();
  });

  it('reads the launcher’s session or its refusal', () => {
    expect(parseLaunchAnswer({ exitCode: 0, stdout: '{"session":"s-1"}' })).toEqual({
      ok: true,
      session: 's-1',
    });
    expect(parseLaunchAnswer({ exitCode: 1, stdout: '{"error":"server_unavailable"}' })).toEqual({
      ok: false,
      error: 'server_unavailable',
    });
    expect(parseLaunchAnswer({ exitCode: 0, stdout: '' })).toEqual({
      ok: false,
      error: 'launch_failed',
    });
    expect(parseLaunchAnswer({ exitCode: 0, stdout: '[1]\n"x"' })).toEqual({
      ok: false,
      error: 'launch_failed',
    });
  });

  it('the runnable profiles are exactly the CLI’s profiles with an unattended command', () => {
    const cli = AGENT_PROFILES.filter((p) => p.agentCommand !== null).map((p) => p.id);
    expect([...RUNNABLE_AGENT_PROFILE_IDS].sort()).toEqual([...cli].sort());
    for (const p of OFFERED_AGENT_PROFILES) expect(profileCanRunCards(p.id)).toBe(true);
    for (const p of NOT_OFFERED_AGENT_PROFILES) expect(profileCanRunCards(p.id)).toBe(false);
  });

  it('maps the start’s own refusals to 409 with their words', async () => {
    for (const err of [
      new AgentInstanceWrongProjectError('a'),
      new AgentInstanceImageTooOldError('a'),
      new AgentProfileCannotRunError('cursor', 'Cursor'),
      new AgentNotSignedInError('a', 'Claude Code'),
    ]) {
      const res = mapAgentInstanceError(err)!;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: err.code, error: err.message });
    }
    const notReady = mapAgentInstanceError(new AgentRunCardNotReadyError('PROD-1', 'it is done'))!;
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({
      code: 'agent_run_card_not_ready',
      detail: 'it is done',
    });
    expect(new DispatchRunAgentBusyError('a', 'run-1').message).toContain('run run-1');
    expect(new DispatchRunAgentBusyError('a', 'run-1', 'PROD-2').message).toContain('PROD-2');
  });
});
