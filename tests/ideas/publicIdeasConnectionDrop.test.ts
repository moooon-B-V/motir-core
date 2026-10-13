import net from 'node:net';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { GET as listGET } from '@/app/api/public/ideas/route';
import { GET as detailGET } from '@/app/api/public/ideas/[slug]/route';
import { GET as tagsGET } from '@/app/api/public/ideas/tags/route';
import { dbPool } from '@/lib/db';
import { isConnectionError } from '@/lib/prisma/connectionError';
import { ideaPublicRepository } from '@/lib/repositories/ideaPublicRepository';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';
import { directionInput, seedTags, staffActor } from './_helpers';

// MOTIR-8350 — `GET /api/public/ideas` answered an UNHANDLED 500 in production:
// `Error: Connection terminated unexpectedly`, from `pg-pool/index.js:45` under
// `PgQueryable.performIO` → `queryRaw`, with no application frame at all.
//
// ⚠️ THE FAULT IS THE PRODUCTION ONE, NOT A HAND-BUILT LOOKALIKE. The errors this
// suite feeds the service are PRODUCED here, by the real driver: a TCP proxy
// between a `pg.Pool` and the test database destroys its sockets mid-query (an
// intermediary hanging up — Neon's pooler, a compute restart), and a backend is
// terminated server-side. And the end-to-end case drives the REAL `@/lib/db` pool:
// it kills the sockets under its idle clients and asks the route in the same tick,
// which is exactly how a pool hands out a client whose connection is already gone.
// Before the fix that request threw the production error out of the route.

runAsCloudBuild();

const get = (path: string) => new Request(`https://app.motir.co/api/public/ideas${path}`);
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

/** A proxy that forwards to the test database and can hang up every socket. */
async function droppingProxy(): Promise<{ url: string; hangUp(): void; close(): Promise<void> }> {
  const target = new URL(currentWorkerAdminUrl());
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) s.on('error', kill).on('close', kill);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return {
    url: url.toString(),
    hangUp() {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Wait until the database shows a statement carrying `marker` running. */
async function untilRunning(admin: Pool, marker: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()`,
      [`%${marker}%`],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the ${marker} statement never started`);
}

/** Run a slow read through `url`, call `cut` once it is running, and return its error. */
async function errorOfACutRead(
  url: string,
  marker: string,
  cut: (admin: Pool) => Promise<void> | void,
): Promise<unknown> {
  const pool = new Pool({ connectionString: url });
  pool.on('error', () => {});
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  const admin = new Pool({ connectionString: currentWorkerAdminUrl() });
  try {
    const pending = client.$queryRawUnsafe(`SELECT pg_sleep(5)::text AS ${marker}`).then(
      () => null,
      (err: unknown) => err,
    );
    await untilRunning(admin, marker);
    await cut(admin);
    return await pending;
  } finally {
    // A hang-up leaves the server-side backend sleeping; end it so the test owns
    // no working backend when it finishes.
    await untilGone(admin, marker);
    await client.$disconnect();
    await admin.end();
  }
}

/** Terminate any backend still running `marker`, and wait until none is left. */
async function untilGone(admin: Pool, marker: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE query LIKE $1 AND pid <> pg_backend_pid()`,
      [`%${marker}%`],
    );
    if (rows.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the ${marker} backend never ended`);
}

/** The error a read gets when its connection is closed under it mid-query. */
async function midQueryDropError(): Promise<unknown> {
  const proxy = await droppingProxy();
  try {
    return await errorOfACutRead(proxy.url, 'mot8350_hangup', () => proxy.hangUp());
  } finally {
    await proxy.close();
  }
}

/** The error a read gets when the SERVER terminates its backend mid-query. */
async function serverTerminatedError(): Promise<unknown> {
  return errorOfACutRead(currentWorkerAdminUrl(), 'mot8350_terminate', async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE query LIKE '%mot8350_terminate%' AND pid <> pg_backend_pid()`,
    );
  });
}

let midQuery: unknown;
let terminated: unknown;

beforeAll(async () => {
  midQuery = await midQueryDropError();
  terminated = await serverTerminatedError();
});

async function seed(): Promise<void> {
  await seedTags('smb');
  const actor = await staffActor('operator');
  await ideasAdminService.addIdeas(actor, [
    directionInput('pet-clinics', { category: 'pets', tags: ['smb'] }),
  ]);
}

beforeEach(async () => {
  await truncateAuthTables();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('the dropped-connection errors the driver actually raises', () => {
  it('a mid-query hang-up is the production error, and is classified as a connection error', async () => {
    expect(midQuery).toBeInstanceOf(Error);
    expect((midQuery as Error).message).toBe('Connection terminated unexpectedly');
    expect(isConnectionError(midQuery)).toBe(true);
  });

  it('a server-side termination (57P01) is classified as a connection error', async () => {
    expect(JSON.stringify(terminated)).toContain('57P01');
    expect(isConnectionError(terminated)).toBe(true);
  });

  it('a real answer from the database is NOT a connection error', async () => {
    const owner = new PrismaClient({
      adapter: new PrismaPg(new Pool({ connectionString: currentWorkerAdminUrl() }), {
        disposeExternalPool: true,
      }),
    });
    try {
      const unique = await owner.ideaTag
        .create({ data: { slug: 'smb', label: 'SMB', description: 'dup' } })
        .then(
          () => null,
          (err: unknown) => err,
        );
      const badSql = await owner.$queryRaw`SELECT * FROM no_such_table_mot8350`.then(
        () => null,
        (err: unknown) => err,
      );
      expect(unique).not.toBeNull();
      expect(badSql).not.toBeNull();
      expect(isConnectionError(unique)).toBe(false);
      expect(isConnectionError(badSql)).toBe(false);
      expect(isConnectionError(new Error('db down'))).toBe(false);
      expect(isConnectionError(null)).toBe(false);
    } finally {
      await owner.$disconnect();
    }
  });
});

describe('GET /api/public/ideas on a pooled connection that is already dead', () => {
  it('answers 200 — the real pool hands out a dead client, and the one retry takes a fresh one', async () => {
    const pool = dbPool();
    expect(pool, 'the app pool is measurable').not.toBeNull();
    const handedOut = new Set<PoolClient>();
    const track = (client: PoolClient) => void handedOut.add(client);
    pool!.on('acquire', track);
    try {
      expect((await listGET(get(''))).status).toBe(200); // warm the pool
    } finally {
      pool!.off('acquire', track);
    }
    expect(handedOut.size).toBeGreaterThan(0);

    const read = vi.spyOn(ideaPublicRepository, 'listActive');
    // The intermediary hangs up; the request arrives before the pool notices.
    for (const client of handedOut) {
      (client as unknown as { connection: { stream: net.Socket } }).connection.stream.destroy();
    }
    const res = await listGET(get(''));

    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { slug: string }) => i.slug)).toEqual(['pet-clinics']);
    expect(read.mock.calls.length).toBe(2); // the dropped attempt, then the retry
  });
});

describe('the three public idea reads, fed the production error', () => {
  it('retry once and answer 200 when the first attempt loses its connection', async () => {
    vi.spyOn(ideaPublicRepository, 'listActive').mockRejectedValueOnce(midQuery);
    vi.spyOn(ideaPublicRepository, 'tagCounts').mockRejectedValueOnce(terminated);
    vi.spyOn(ideaPublicRepository, 'findActiveBySlug').mockRejectedValueOnce(midQuery);

    const list = await listGET(get(''));
    const tags = await tagsGET(get('/tags'));
    const detail = await detailGET(get('/pet-clinics'), slugCtx('pet-clinics'));

    expect([list.status, tags.status, detail.status]).toEqual([200, 200, 200]);
    expect((await list.json()).total).toBe(1);
    expect((await tags.json()).tags).toHaveLength(1);
    expect((await detail.json()).slug).toBe('pet-clinics');
  });

  it('answer a handled, uncached 503 with Retry-After when the retry loses its connection too', async () => {
    vi.spyOn(ideaPublicRepository, 'listActive').mockRejectedValue(midQuery);
    vi.spyOn(ideaPublicRepository, 'tagCounts').mockRejectedValue(midQuery);
    vi.spyOn(ideaPublicRepository, 'findActiveBySlug').mockRejectedValue(terminated);

    for (const res of [
      await listGET(get('')),
      await tagsGET(get('/tags')),
      await detailGET(get('/pet-clinics'), slugCtx('pet-clinics')),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: 'IDEAS_UNAVAILABLE' });
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('cache-control')).toBeNull();
    }
    expect(ideaPublicRepository.listActive).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a failure that is not a lost connection', async () => {
    const read = vi
      .spyOn(ideaPublicRepository, 'listActive')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(listGET(get(''))).rejects.toThrow('db down');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
