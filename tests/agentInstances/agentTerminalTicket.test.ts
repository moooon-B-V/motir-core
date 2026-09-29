import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import '@/lib/jobs/definitions/agentInstanceSweep';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import {
  agentTerminalClock,
  agentTerminalRelayService as relayService,
} from '@/lib/services/agentTerminalRelayService';
import { adminDb } from '../helpers/adminDb';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { clock, fleet, fx, setUpHarness, tearDownHarness } from './_harness';

// THE TERMINAL TICKET (Story MOTIR-6861 · MOTIR-6940, `docs/decisions/agent-terminal.md`
// Q3) against a real Postgres and the fake persistent fleet: the route's owner-only
// ticket and its refusals, and the relay's redeem — single use, 60-second life,
// bound to its own agent — plus the connection row and the sweep.

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

const route = await import('@/app/api/projects/[key]/instances/[id]/terminal-ticket/route');

const MASTER = 'm'.repeat(48);

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.stubEnv('MOTIR_RELAY_URL', '');
  vi.spyOn(agentTerminalClock, 'now').mockImplementation(() => clock.now());
  await actAs(fx.ownerId);
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

async function member(role: 'member' | 'admin' | 'viewer'): Promise<string> {
  const user = await adminDb.user.create({
    data: { name: `M ${role}`, email: `t-${role}-${Date.now()}-${Math.random()}@example.com` },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  if (role !== 'member') await setWorkspaceRoleFor(user.id, fx.workspaceId, role);
  return user.id;
}

const running = async (name = 'yue-claude') => {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
};

const post = (id: string, body?: string) =>
  route.POST(
    new Request(
      `http://test/api/projects/${fx.projectIdentifier}/instances/${id}/terminal-ticket`,
      { method: 'POST', body },
    ),
    { params: Promise.resolve({ key: fx.projectIdentifier, id }) },
  );

async function ticketFor(id: string, body?: string) {
  const res = await post(id, body);
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; ticket: string; expiresAt: string };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('the ticket route (Q3)', () => {
  it('gives the OWNER a 60-second ticket for their running agent, storing only its hash', async () => {
    const id = await running();
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { url: string; ticket: string; expiresAt: string };
    expect(body.url).toBe('wss://relay.motir.co/v1/terminal');
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime() - clock.now().getTime()).toBe(60_000);

    const rows = await adminDb.agentTerminalTicket.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      tokenHash: sha256(body.ticket),
      consumedAt: null,
    });
    // The ticket itself is in no column.
    expect(JSON.stringify(rows[0])).not.toContain(body.ticket);
  });

  it('reads MOTIR_RELAY_URL at call time, and takes no body (the session rides the open frame)', async () => {
    const id = await running();
    vi.stubEnv('MOTIR_RELAY_URL', 'ws://localhost:8080/v1/terminal');
    const body = await ticketFor(id, JSON.stringify({ sessionId: 'ignored' }));
    expect(body.url).toBe('ws://localhost:8080/v1/terminal');
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'ticket', 'url']);
  });

  it('refuses another member and a MANAGER alike with not_owner — and gives neither a ticket', async () => {
    const id = await running();
    for (const role of ['member', 'admin'] as const) {
      await actAs(await member(role));
      const res = await post(id);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'not_owner' });
    }
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('answers not_owner for an agent that does not exist or is deleted — no existence leak', async () => {
    const res = await post('no-such-agent');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_owner' });
    const id = await running();
    await adminDb.agentInstance.update({ where: { id }, data: { deletedAt: new Date() } });
    expect((await post(id)).status).toBe(403);
  });

  it('refuses a reader without instance:use, and an unauthenticated caller', async () => {
    const id = await running();
    await actAs(await member('viewer'));
    const res = await post(id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'instance:use' });
    session.user = null;
    ctxRef.current = null;
    expect((await post(id)).status).toBe(401);
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('refuses not_running for a hibernated agent and no_terminal_server for an old image, 409 both', async () => {
    const id = await running();
    await adminDb.agentInstance.update({ where: { id }, data: { terminalServer: 'absent' } });
    let res = await post(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_terminal_server' });

    await adminDb.agentInstance.update({ where: { id }, data: { terminalServer: 'present' } });
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    res = await post(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_running' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
    // The route never wakes anything (Q6): the machine stays stopped.
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
      'hibernated',
    );
  });

  it('is unavailable (503) while the terminal master key is unset', async () => {
    const id = await running();
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const res = await post(id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'agent_instances_unavailable' });
  });
});

describe('the relay’s redeem (Q3)', () => {
  it('redeems ONCE: the dial target is the ticket’s own agent, with a signed relay token', async () => {
    fleet.setTerminalAddress('ws://127.0.0.1:7999');
    const id = await running();
    const other = await running('second');
    const { ticket } = await ticketFor(id);

    const verdict = await relayService.authorizeConnection(ticket);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    expect(verdict.target).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    // A ticket names ONE agent: it can never reach the second one.
    expect(verdict.target.instanceId).not.toBe(other);
    expect(verdict.target.dial.url).toBe('ws://127.0.0.1:7999/v1/terminal');
    expect(verdict.target.dial.headers['x-motir-machine-id']).toBe(row.machineId);
    expect(verdict.target.dial.headers['authorization']).toMatch(
      /^Motir-Relay [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/,
    );
    const payload = JSON.parse(
      Buffer.from(
        verdict.target.dial.headers['authorization']!.split(' ')[1]!.split('.')[0]!,
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ instanceId: id, machineId: row.machineId });
    // No session is bound into the token: the browser's `open` frame names it.
    expect(payload).not.toHaveProperty('sessionId');
    expect(payload['exp']).toBe(Math.floor(clock.now().getTime() / 1000) + 60);
    expect((await adminDb.agentTerminalTicket.findFirstOrThrow({})).consumedAt).toEqual(
      clock.now(),
    );

    // A second use is refused.
    expect(await relayService.authorizeConnection(ticket)).toEqual({
      ok: false,
      closeCode: TERMINAL_CLOSE.badTicket,
    });
    fleet.setTerminalAddress(null);
  });

  it('refuses an unknown, empty or oversized ticket, and one past its 60 seconds', async () => {
    const id = await running();
    for (const bad of ['', 'x'.repeat(300), 'not-a-ticket-anyone-minted']) {
      expect(await relayService.authorizeConnection(bad)).toEqual({ ok: false, closeCode: 4401 });
    }
    const { ticket } = await ticketFor(id);
    clock.advance(60_000);
    expect(await relayService.authorizeConnection(ticket)).toEqual({ ok: false, closeCode: 4401 });
    expect((await adminDb.agentTerminalTicket.findFirstOrThrow({})).consumedAt).toBeNull();
  });

  it('lets exactly one of two concurrent redeems through', async () => {
    const id = await running();
    const { ticket } = await ticketFor(id);
    const verdicts = await Promise.all([
      relayService.authorizeConnection(ticket),
      relayService.authorizeConnection(ticket),
    ]);
    expect(verdicts.filter((v) => v.ok)).toHaveLength(1);
    expect(verdicts.filter((v) => !v.ok)).toEqual([{ ok: false, closeCode: 4401 }]);
  });

  it('re-reads the instance: 4409 not running, 4410 no terminal server, 4403 no longer the user’s', async () => {
    const id = await running();
    const redeemAfter = async (patch: Record<string, unknown>) => {
      const { ticket } = await ticketFor(id);
      await adminDb.agentInstance.update({ where: { id }, data: patch });
      const verdict = await relayService.authorizeConnection(ticket);
      await adminDb.agentInstance.update({
        where: { id },
        data: { state: 'running', terminalServer: 'present', ownerId: fx.ownerId, deletedAt: null },
      });
      return verdict;
    };
    expect(await redeemAfter({ state: 'hibernating' })).toEqual({ ok: false, closeCode: 4409 });
    expect(await redeemAfter({ terminalServer: 'absent' })).toEqual({
      ok: false,
      closeCode: 4410,
    });
    expect(await redeemAfter({ deletedAt: new Date() })).toEqual({ ok: false, closeCode: 4403 });
    const someoneElse = await member('member');
    expect(await redeemAfter({ ownerId: someoneElse })).toEqual({ ok: false, closeCode: 4403 });
  });
});

describe('the connection record and the sweep (Q3, Q8)', () => {
  it('opens and closes one row — and the table has no column for content', async () => {
    const id = await running();
    const rowId = await relayService.openConnection({
      workspaceId: fx.workspaceId,
      instanceId: id,
      userId: fx.ownerId,
    });
    const opened = await adminDb.agentTerminalConnection.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(opened).toMatchObject({ openedAt: clock.now(), closedAt: null, closeReason: null });
    clock.advance(90_000);
    const close = {
      id: rowId,
      workspaceId: fx.workspaceId,
      closeCode: 1000,
      closeReason: 'browser_closed' as const,
    };
    await relayService.closeConnection(close);
    await relayService.closeConnection({ ...close, closeCode: 4502, closeReason: 'unreachable' });
    const closed = await adminDb.agentTerminalConnection.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(closed).toMatchObject({ closeCode: 1000, closeReason: 'browser_closed' });
    expect(closed.closedAt!.getTime() - closed.openedAt.getTime()).toBe(90_000);
    expect(Object.keys(closed).sort()).toEqual(
      [
        'closeCode',
        'closeReason',
        'closedAt',
        'createdAt',
        'id',
        'instanceId',
        'openedAt',
        'userId',
        'workspaceId',
      ].sort(),
    );
  });

  it('deletes only tickets past their life, through the sweep job’s own step', async () => {
    const id = await running();
    await ticketFor(id);
    clock.advance(30_000);
    await ticketFor(id);
    clock.advance(31_000); // the first is past its 60 s, the second is not
    vi.spyOn(agentInstanceSweepService, 'sweep').mockResolvedValue({ settled: 0 } as never);
    const steps: string[] = [];
    const step = {
      run: async <T>(name: string, fn: () => Promise<T>) => {
        steps.push(name);
        return fn();
      },
    };
    await engineJob('system.agent-instance-sweep')!.handler(
      { step } as never,
      jobServices as never,
    );
    expect(steps).toEqual(['sweep-agent-instances', 'sweep-agent-terminal-tickets']);
    expect(await adminDb.agentTerminalTicket.count()).toBe(1);
    clock.advance(60_000);
    expect(await relayService.sweepExpiredTickets()).toEqual({ deleted: 1 });
    expect(await relayService.sweepExpiredTickets()).toEqual({ deleted: 0 });
  });
});
