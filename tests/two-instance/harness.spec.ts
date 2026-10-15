import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client } from 'pg';
import { addressOf, clientFor, startInstances, type InstancePair } from './harness';

// THE HARNESS'S OWN SELF-CHECKS (MOTIR-8616). The cases that matter to the
// product — the limits, the follow-ups — live in their own specs beside this
// one. These prove the harness can be trusted to run them:
//
//   1. smoke        — A and B are two processes on two ports, read back.
//   2. visibility   — a row written through one machine is read through the
//                     other, both ways (one shared Postgres).
//   3. detectability — a module-level counter used as a limiter is VISIBLY
//                     per-instance through this client, and a shared one is not.
//
// A vacuous pass is the failure each case is built against: without (1), every
// cross-machine case could be talking to one process twice.

const app = clientFor(inject('twoInstanceApp'));
const address = inject('twoInstanceApp');

/** Better-Auth trusts this origin in every build (`trustedOrigins`). */
const ORIGIN = 'http://localhost:3000';

/** A fresh client IP per case, so no case spends another's Better-Auth bucket. */
function freshIp(): string {
  const [a = 0, b = 0] = randomBytes(2);
  return `198.18.${a}.${b}`;
}

describe('smoke: two processes, not one', () => {
  it('A and B answer on their own ports from different processes', async () => {
    expect(address.A.port).not.toBe(address.B.port);
    expect(address.A.pid).not.toBe(address.B.pid);
    // Each pid announced the port the harness gave it — so port A IS process A.
    expect(address.A.announcedPort).toBe(address.A.port);
    expect(address.B.announcedPort).toBe(address.B.port);

    const [a, b] = await Promise.all([
      app.sendTo('A', '/api/health/ready'),
      app.sendTo('B', '/api/health/ready'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('alternate() sends request N to A and N+1 to B', async () => {
    const served = await app.alternate([
      { path: '/api/health/ready' },
      { path: '/api/health/ready' },
      { path: '/api/health/ready' },
    ]);
    expect(served.map((s) => s.served)).toEqual(['A', 'B', 'A']);
    for (const s of served) expect(s.response.status).toBe(200);
  });
});

describe('visibility: one Postgres behind both machines', () => {
  async function signUp(machine: 'A' | 'B', ip: string): Promise<string> {
    const email = `two-instance-${randomUUID()}@example.com`;
    const res = await app.sendTo(machine, '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password: 'two-instance-pass-1', name: 'Two Instance' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookie).toContain('session_token');
    return cookie;
  }

  async function sessionEmail(machine: 'A' | 'B', cookie: string): Promise<string | null> {
    const res = await app.sendTo(machine, '/api/auth/get-session', {
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } } | null;
    return body?.user?.email ?? null;
  }

  it('a session created through A is read through B', async () => {
    const cookie = await signUp('A', freshIp());
    expect(await sessionEmail('B', cookie)).toMatch(/^two-instance-/);
  });

  it('a session created through B is read through A', async () => {
    const cookie = await signUp('B', freshIp());
    expect(await sessionEmail('A', cookie)).toMatch(/^two-instance-/);
  });
});

describe('detectability: the lane can SEE per-instance state', () => {
  let fixture: InstancePair;
  let pg: Client;

  beforeAll(async () => {
    fixture = await startInstances({
      command: [process.execPath, 'tests/two-instance/fixtureServer.mjs'],
      env: { ...process.env },
      readyPath: '/health',
      readyTimeoutMs: 30_000,
      announcePattern: /listening on port (\d+)/,
    });
    pg = new Client({ connectionString: process.env['DATABASE_URL'] });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.query(`DELETE FROM "rate_limit_counter" WHERE "key" LIKE 'two-instance-fixture:%'`);
    await pg?.end();
    await fixture?.stop();
  });

  async function fourCalls(path: string): Promise<number[]> {
    const client = clientFor(addressOf(fixture));
    const key = randomUUID();
    const statuses: number[] = [];
    for (const machine of ['A', 'A', 'A', 'B'] as const) {
      const res = await client.sendTo(machine, `${path}?key=${key}&max=3`);
      statuses.push(res.status);
    }
    return statuses;
  }

  it('the fixture runs as two processes', async () => {
    const client = clientFor(addressOf(fixture));
    const [a, b] = await Promise.all([
      client.sendTo('A', '/health'),
      client.sendTo('B', '/health'),
    ]);
    expect(a.headers.get('x-fixture-pid')).not.toBe(b.headers.get('x-fixture-pid'));
  });

  it('a module-level counter limiter lets the 4th call through on the other machine', async () => {
    // 3 to A, 1 to B: the counter on B has seen one call, so it does NOT refuse.
    // This is the defect, observed — the proof the lane can catch it.
    expect(await fourCalls('/counter-limit')).toEqual([200, 200, 200, 200]);
  });

  it('a shared Postgres limiter refuses the 4th, whichever machine serves it', async () => {
    expect(await fourCalls('/shared-limit')).toEqual([200, 200, 200, 429]);
  });
});
