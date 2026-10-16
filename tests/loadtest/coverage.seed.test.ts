import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Story MOTIR-8538 · MOTIR-8681 — the seed's refusal and validation branches,
// over the pure functions and the commands' bodies up to the point they would
// import `./tenants` (which opens the database). Every case here refuses or
// returns before that import, so no row is written and no connection is opened.
// The happy paths over real Postgres live in tests/loadtest/seed.test.ts.

import {
  SeedTargetRefusedError,
  assertSeedTarget,
  missingSeedEnv,
  SEED_ENV,
} from '@/loadtest/seed/guard';
import {
  MANIFEST_VERSION,
  ManifestMissingError,
  manifestCardIds,
  readManifest,
  writeManifest,
  type SeedManifest,
} from '@/loadtest/seed/manifest';
import { runReset } from '@/loadtest/seed/reset';
import { argValue, loadShape, runSeed, validRunTag } from '@/loadtest/seed/seed';
import {
  InvalidSeedShapeError,
  SMOKE_SHAPE,
  agentCount,
  validateSeedShape,
} from '@/loadtest/seed/shape';

// The DB section at the end seeds through the shipped services, with the same
// environment shims as tests/loadtest/seed.test.ts: `next/headers` answers an
// empty request scope, and rate limiting is off for the synthetic burst.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

const ALLOWED = 'ep-calm-sky-123.eu-central-1.aws.neon.tech';
const PROD = 'ep-prod-1.eu-central-1.aws.neon.tech';

function env(over: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: `postgresql://u:p@ep-calm-sky-123-pooler.eu-central-1.aws.neon.tech/db`,
    DATABASE_URL_UNPOOLED: `postgresql://u:p@${ALLOWED}/db`,
    BETTER_AUTH_SECRET: 's',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    MOTIR_BASE_URL: 'http://staging.flycast',
    NODE_ENV: 'production',
    LOADTEST_ALLOWED_DB_HOST: ALLOWED,
    LOADTEST_PRODUCTION_DB_HOSTS: PROD,
    ...over,
  };
}

const card = (n: number) => ({ id: `c${n}`, key: `LTA-${n}` });

function manifestFixture(over: Partial<SeedManifest> = {}): SeedManifest {
  return {
    version: MANIFEST_VERSION,
    runTag: 'cov',
    seededAt: '2026-10-15T00:00:00.000Z',
    baseUrl: 'http://staging.flycast',
    databaseHost: ALLOWED,
    sessionLifetimeSeconds: 60,
    sessionsExpireAt: '2026-10-15T00:01:00.000Z',
    shape: SMOKE_SHAPE,
    users: [],
    agents: [
      {
        tokenId: 't1',
        token: 'plain',
        role: 'write',
        userId: 'u1',
        workspaceId: 'w1',
        projectId: 'p1',
        projectKey: 'LTA',
        burst: { cards: [card(20)], parents: [card(21), card(22)] },
        scratchPlanIds: [],
      },
      {
        tokenId: 't2',
        token: 'plain2',
        role: 'read',
        userId: 'u1',
        workspaceId: 'w1',
        projectId: 'p1',
        projectKey: 'LTA',
        scratchPlanIds: [],
      },
    ],
    workspaces: [],
    projects: [
      {
        id: 'p1',
        key: 'LTA',
        workspaceId: 'w1',
        content: { stories: [card(1)], subtasks: [card(2)] },
        pools: {
          claim: [card(3)],
          run: [card(4)],
          write: [card(5)],
          parents: { claim: card(6), run: card(7), write: card(8) },
        },
        readPlanIds: [],
        scratchPlanIds: [],
      },
    ],
    ...over,
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loadtest-cov-seed-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('missingSeedEnv', () => {
  it('names nothing for a complete production environment', () => {
    expect(missingSeedEnv(env())).toEqual([]);
  });

  it('treats blank as missing and names a non-production NODE_ENV with its value', () => {
    expect(missingSeedEnv(env({ BETTER_AUTH_SECRET: '   ', NODE_ENV: 'development' }))).toEqual([
      'BETTER_AUTH_SECRET',
      'NODE_ENV (must be production, got development)',
    ]);
  });

  it('names every variable when the environment is empty', () => {
    expect(missingSeedEnv({})).toEqual([...SEED_ENV]);
  });
});

describe('assertSeedTarget', () => {
  it('returns the bare allowed endpoint for a pooled + direct pair on it', () => {
    expect(assertSeedTarget(env())).toBe(ALLOWED);
  });

  const refusals: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ['no allowed host', { LOADTEST_ALLOWED_DB_HOST: undefined }, /ALLOWED_DB_HOST is unset/],
    ['no deny-list', { LOADTEST_PRODUCTION_DB_HOSTS: undefined }, /fails closed/],
    ['a blank deny-list', { LOADTEST_PRODUCTION_DB_HOSTS: '  ' }, /fails closed/],
    ['an unreadable DATABASE_URL', { DATABASE_URL: 'postgresql://' }, /DATABASE_URL has no/],
    [
      'an unset DATABASE_URL_UNPOOLED',
      { DATABASE_URL_UNPOOLED: undefined },
      /DATABASE_URL_UNPOOLED has no readable host/,
    ],
    [
      'a production unpooled URL',
      { DATABASE_URL_UNPOOLED: `postgresql://u:p@${PROD}/db` },
      /DATABASE_URL_UNPOOLED points at a PRODUCTION endpoint \(ep-prod-1/,
    ],
    [
      'a pooled production host on the deny-list',
      { DATABASE_URL: 'postgresql://u:p@ep-prod-1-pooler.eu-central-1.aws.neon.tech/db' },
      /DATABASE_URL points at a PRODUCTION endpoint/,
    ],
    [
      'a host that is neither allowed nor production',
      { DATABASE_URL: 'postgresql://u:p@other.example.com/db' },
      /points at other\.example\.com, not LOADTEST_ALLOWED_DB_HOST/,
    ],
  ];
  for (const [name, over, message] of refusals) {
    it(`refuses ${name}`, () => {
      let thrown: unknown;
      try {
        assertSeedTarget(env(over));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SeedTargetRefusedError);
      expect((thrown as Error).name).toBe('SeedTargetRefusedError');
      expect((thrown as Error).message).toMatch(message);
    });
  }
});

describe('validateSeedShape', () => {
  it('refuses a non-object by saying so', () => {
    for (const input of [null, 7, 'shape']) {
      expect(() => validateSeedShape(input)).toThrow(/the shape is not an object/);
    }
  });

  it('names every field of an empty object, including the nested ones', () => {
    let problems: string[] = [];
    try {
      validateSeedShape({});
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSeedShapeError);
      problems = (err as InstanceType<typeof InvalidSeedShapeError>).problems;
    }
    expect(problems).toEqual([
      'smoke must be true or false',
      'users must be an integer ≥ 1',
      'workspaces must be an integer ≥ 1',
      'workspacesPerUser must be an integer ≥ 1',
      'projectsPerWorkspace must be an integer ≥ 1',
      'agentRoles.read must be an integer ≥ 0',
      'agentRoles.write must be an integer ≥ 0',
      'agentRoles.claim must be an integer ≥ 0',
      'agentRoles.run must be an integer ≥ 0',
      'content.stories must be an integer ≥ 0',
      'content.subtasksPerStory must be an integer ≥ 0',
      'pools.claim must be an integer ≥ 0',
      'pools.run must be an integer ≥ 0',
      'pools.write must be an integer ≥ 0',
      'burstSize must be an integer ≥ 1',
      'burstAgents must be an integer ≥ 0',
      'readPlansPerWorkspace must be an integer ≥ 0',
      'scratchPlans must be an integer ≥ 0',
    ]);
  });

  it('refuses a fractional or below-minimum count by name', () => {
    expect(() => validateSeedShape({ ...SMOKE_SHAPE, users: 2.5, burstSize: 0 })).toThrow(
      /users must be an integer ≥ 1[\s\S]*burstSize must be an integer ≥ 1/,
    );
  });

  it('names every tenancy problem of a well-typed shape at once', () => {
    let problems: string[] = [];
    try {
      validateSeedShape({
        ...SMOKE_SHAPE,
        workspaces: 1,
        users: 1,
        workspacesPerUser: 2,
        agentRoles: { ...SMOKE_SHAPE.agentRoles, write: 1 },
        burstAgents: 5,
      });
    } catch (err) {
      problems = (err as InstanceType<typeof InvalidSeedShapeError>).problems;
    }
    expect(problems).toEqual([
      'workspaces must be ≥ 2 for a smoke shape (agent traffic per workspace is capped at 12 000 a minute), got 1',
      'workspacesPerUser must be ≤ workspaces, got 2',
      'burstAgents must be ≤ the write agents the shape mints (2), got 5',
    ]);
  });

  it('refuses fewer users than workspaces', () => {
    expect(() =>
      validateSeedShape({ ...SMOKE_SHAPE, users: 3, workspaces: 4, workspacesPerUser: 1 }),
    ).toThrow(/users must be ≥ workspaces \(workspace w is owned by user w\), got 3/);
  });

  it('accepts the smoke shape and returns it unchanged', () => {
    expect(validateSeedShape(SMOKE_SHAPE)).toBe(SMOKE_SHAPE);
    expect(agentCount(SMOKE_SHAPE, 'write')).toBe(8);
  });
});

describe('the manifest file', () => {
  it('round-trips with mode 0600, and a rewrite resets loosened bits', async () => {
    const path = join(dir, 'nested', 'm.json');
    const m = manifestFixture();
    await writeManifest(m, path);
    await writeFile(path, '{}', { mode: 0o644 });
    await writeManifest(m, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readManifest(path)).toEqual(m);
    expect((await readFile(path, 'utf8')).endsWith('}\n')).toBe(true);
  });

  it('a missing file is a ManifestMissingError naming the path and the re-seed', async () => {
    const path = join(dir, 'absent.json');
    const err = await readManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestMissingError);
    expect((err as InstanceType<typeof ManifestMissingError>).path).toBe(path);
    expect((err as Error).message).toMatch(/Re-seed with `pnpm loadtest:seed`/);
  });

  it('any other read error is rethrown as itself', async () => {
    const path = join(dir, 'a-directory');
    await mkdir(path, { recursive: true });
    const err = await readManifest(path).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ManifestMissingError);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('refuses a manifest of another version', async () => {
    const path = join(dir, 'v2.json');
    await writeFile(path, JSON.stringify({ ...manifestFixture(), version: 2 }));
    await expect(readManifest(path)).rejects.toThrow(/is version 2, expected 1/);
  });

  it('manifestCardIds lists every project card, then burst cards of burst agents only', () => {
    expect(manifestCardIds(manifestFixture())).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c20',
      'c21',
      'c22',
    ]);
  });
});

describe('the seed command helpers', () => {
  it('argValue reads `--flag value`, `--flag=value`, and nothing', () => {
    expect(argValue(['--tag', 'abc'], '--tag')).toBe('abc');
    expect(argValue(['--tag=xyz'], '--tag')).toBe('xyz');
    expect(argValue(['--out', 'o'], '--tag')).toBeUndefined();
    expect(argValue(['--tag'], '--tag')).toBeUndefined();
  });

  it('validRunTag admits short plain tags only', () => {
    expect(validRunTag('lt')).toBe(true);
    expect(validRunTag('a'.repeat(24))).toBe(true);
    expect(validRunTag('a'.repeat(25))).toBe(false);
    expect(validRunTag('-lead')).toBe(false);
    expect(validRunTag('Upper')).toBe(false);
  });

  it('loadShape is the smoke shape with no path, and validates a file', async () => {
    expect(await loadShape(undefined)).toBe(SMOKE_SHAPE);
    const good = join(dir, 'shape.json');
    await writeFile(good, JSON.stringify(SMOKE_SHAPE));
    expect(await loadShape(good)).toEqual(SMOKE_SHAPE);
    const bad = join(dir, 'bad-shape.json');
    await writeFile(bad, JSON.stringify({ ...SMOKE_SHAPE, users: 0 }));
    await expect(loadShape(bad)).rejects.toBeInstanceOf(InvalidSeedShapeError);
  });
});

describe('runSeed refusals (before any database import)', () => {
  it('refuses a missing environment with exit 2, naming each variable', async () => {
    const lines: string[] = [];
    expect(await runSeed([], env({ GOOGLE_CLIENT_ID: undefined }), (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual(['refused: missing environment — GOOGLE_CLIENT_ID']);
  });

  it('refuses a production target with exit 2', async () => {
    const lines: string[] = [];
    const over = { DATABASE_URL: `postgresql://u:p@${PROD}/db` };
    expect(await runSeed([], env(over), (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toMatch(/^refused: DATABASE_URL points at a PRODUCTION endpoint/);
  });

  it('refuses an invalid --tag (either flag form) with exit 2', async () => {
    for (const argv of [['--tag', 'Bad_Tag'], ['--tag=Bad_Tag']]) {
      const lines: string[] = [];
      expect(await runSeed(argv, env(), (l) => lines.push(l))).toBe(2);
      expect(lines).toEqual(['refused: --tag must match [a-z0-9][a-z0-9-]{0,23}, got Bad_Tag']);
    }
  });

  it('an invalid --shape file rejects before anything is seeded', async () => {
    const bad = join(dir, 'bad-seed-shape.json');
    await writeFile(bad, JSON.stringify({ smoke: true }));
    const lines: string[] = [];
    await expect(runSeed(['--shape', bad], env(), (l) => lines.push(l))).rejects.toBeInstanceOf(
      InvalidSeedShapeError,
    );
    expect(lines).toEqual([]);
  });
});

describe('runReset refusals (before any database import)', () => {
  it('with no --manifest it reads the default path under the working directory', async () => {
    const cwd = process.cwd();
    const work = await mkdtemp(join(dir, 'cwd-'));
    process.chdir(work);
    try {
      // DEFAULT_MANIFEST_PATH is fixed at module load, so load a fresh copy here.
      vi.resetModules();
      const fresh = await import('@/loadtest/seed/reset');
      const lines: string[] = [];
      expect(await fresh.runReset([], env(), (l) => lines.push(l))).toBe(3);
      expect(lines[0]).toContain(
        `no seed manifest at ${join(work, 'loadtest/.out/manifest.json')}`,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses a missing environment with exit 2', async () => {
    const lines: string[] = [];
    expect(await runReset([], env({ NODE_ENV: 'test' }), (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([
      'refused: missing environment — NODE_ENV (must be production, got test)',
    ]);
  });

  it('refuses a target outside the allow-list with exit 2', async () => {
    const lines: string[] = [];
    const over = { DATABASE_URL_UNPOOLED: 'postgresql://u:p@elsewhere.example/db' };
    expect(await runReset([], env(over), (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toMatch(/^refused: DATABASE_URL_UNPOOLED points at elsewhere\.example/);
  });

  it('a missing manifest exits 3 and names the re-seed', async () => {
    const lines: string[] = [];
    const path = join(dir, 'never-written.json');
    expect(await runReset([`--manifest=${path}`], env(), (l) => lines.push(l))).toBe(3);
    expect(lines[0]).toMatch(new RegExp(`^refused: no seed manifest at ${path}`));
  });

  it('a manifest that cannot be read for another reason is rethrown', async () => {
    const path = join(dir, 'reset-dir');
    await mkdir(path, { recursive: true });
    await expect(runReset(['--manifest', path], env(), () => {})).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('refuses a manifest seeded into another host, and leaves it unchanged', async () => {
    const path = join(dir, 'other-host.json');
    await writeManifest(manifestFixture({ databaseHost: 'ep-other.example' }), path);
    const before = await readFile(path, 'utf8');
    const lines: string[] = [];
    expect(await runReset(['--manifest', path], env(), (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([
      `refused: the manifest was seeded into ep-other.example, but this target is ${ALLOWED}`,
    ]);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

// ── Over real Postgres: pagination, the grant cache and every scratch-plan fate ──

describe('seedTenants and resetPools past one page', () => {
  const TAG = 'covpage';
  // 2 users, 2 workspaces, one project each. 100 claim cards + 3 pool parents puts
  // each project past one 100-row card page, and 1 read + 10 scratch plans puts it
  // past one 10-row plan page, so a re-seed walks both cursors. Two run tokens per
  // user in one project share one grant lookup.
  const SHAPE = {
    smoke: true,
    users: 2,
    workspaces: 2,
    workspacesPerUser: 1,
    projectsPerWorkspace: 1,
    agentRoles: { read: 0, write: 1, claim: 0, run: 2 },
    content: { stories: 0, subtasksPerStory: 0 },
    pools: { claim: 100, run: 0, write: 0 },
    burstSize: 1,
    burstAgents: 0,
    readPlansPerWorkspace: 1,
    scratchPlans: 10,
  };

  let dbMod: typeof import('@/lib/db');
  let adminDb: (typeof import('../helpers/adminDb'))['adminDb'];
  let truncateAuthTables: (typeof import('../helpers/db'))['truncateAuthTables'];
  let settleServerWork: (typeof import('../helpers/serverWork'))['settleServerWork'];
  let tenants: typeof import('@/loadtest/seed/tenants');
  let plans: (typeof import('@/lib/services/plansService'))['plansService'];
  let tokens: (typeof import('@/lib/services/apiTokensService'))['apiTokensService'];

  beforeAll(async () => {
    dbMod = await import('@/lib/db');
    ({ adminDb } = await import('../helpers/adminDb'));
    ({ truncateAuthTables } = await import('../helpers/db'));
    ({ settleServerWork } = await import('../helpers/serverWork'));
    tenants = await import('@/loadtest/seed/tenants');
    ({ plansService: plans } = await import('@/lib/services/plansService'));
    ({ apiTokensService: tokens } = await import('@/lib/services/apiTokensService'));
    await truncateAuthTables();
  });

  afterAll(async () => {
    await settleServerWork();
    await truncateAuthTables();
    await dbMod.db.$disconnect();
    await adminDb.$disconnect();
  });

  it('a re-seed finds every card and plan across pages, and a reset replaces only spent scratch plans', async () => {
    const shape = validateSeedShape(SHAPE);
    const first = await tenants.seedTenants(shape, { runTag: TAG, databaseHost: 'localhost' });
    expect(first.projects).toHaveLength(2);
    for (const p of first.projects) {
      expect(p.pools.claim).toHaveLength(100);
      expect(p.readPlanIds).toHaveLength(1);
      expect(p.scratchPlanIds).toHaveLength(10);
    }
    const runAgents = first.agents.filter((a) => a.role === 'run');
    expect(runAgents).toHaveLength(4);
    // The two run tokens of one user share the one grant the cache resolved.
    for (const a of runAgents) {
      const twin = runAgents.find((b) => b !== a && b.userId === a.userId)!;
      const [mine, theirs] = await Promise.all(
        [a, twin].map(async (x) => (await tokens.verify(x.token)).grant),
      );
      expect(mine).toEqual(theirs);
    }

    // A token of the same user under another label is not the tag's, so it survives.
    const owner = first.workspaces[0]!;
    const foreign = await tokens.create(owner.ownerUserId, owner.id, {
      label: 'not-a-loadtest-token',
      projectId: owner.projectIds[0]!,
    });

    const lines: string[] = [];
    const again = await tenants.seedTenants(shape, {
      runTag: TAG,
      databaseHost: 'localhost',
      log: (l) => lines.push(l),
    });
    // Every card past the first page and every plan past the first page was found,
    // not duplicated.
    expect(manifestCardIds(again)).toEqual(manifestCardIds(first));
    for (const [i, p] of again.projects.entries()) {
      expect(p.readPlanIds).toEqual(first.projects[i]!.readPlanIds);
      expect(p.scratchPlanIds).toEqual(first.projects[i]!.scratchPlanIds);
    }
    expect(lines).toContain(`deleted 6 previous ${TAG} tokens (new ones are minted below)`);
    const kept = await tokens.listForUser(owner.ownerUserId);
    expect(kept.map((t) => t.id)).toContain(foreign.dto.id);

    // Spend three scratch plans three different ways, then reset with no log.
    const project = again.projects[0]!;
    const writer = again.agents.find((a) => a.role === 'write' && a.projectId === project.id)!;
    const ctx = {
      userId: again.workspaces.find((w) => w.id === writer.workspaceId)!.ownerUserId,
      workspaceId: writer.workspaceId,
    };
    const [grown, planned, declined, untouched] = writer.scratchPlanIds as [
      string,
      string,
      string,
      string,
    ];
    const proposal = [
      { op: 'add' as const, proposedFields: { title: 'x', kind: 'task' as const } },
    ];
    await plans.addProposals(grown, proposal, ctx);
    await plans.addProposals(planned, proposal, ctx);
    await plans.markPlanned(planned, ctx);
    await plans.declinePlan(declined, ctx);

    const reset = await tenants.resetPools(again);
    const after = reset.agents.find((a) => a.tokenId === writer.tokenId)!;
    const replacedIds = [grown, planned, declined];
    for (const [s, id] of after.scratchPlanIds.entries()) {
      const before = writer.scratchPlanIds[s]!;
      if (replacedIds.includes(before)) expect(id).not.toBe(before);
      else expect(id).toBe(before);
      const plan = await plans.getPlan(id, ctx);
      expect(plan.status).toBe('generating');
      expect(plan.items).toHaveLength(0);
    }
    expect(after.scratchPlanIds).toContain(untouched);
    // A still-open spent plan is declined; an already-declined one is left as it was.
    expect((await plans.getPlan(grown, ctx)).status).toBe('declined');
    expect((await plans.getPlan(planned, ctx)).status).toBe('declined');
    expect((await plans.getPlan(declined, ctx)).status).toBe('declined');
    // The project's own list follows the replacements; the other project's is untouched.
    expect(reset.projects[0]!.scratchPlanIds).toEqual(after.scratchPlanIds);
    expect(reset.projects[1]!.scratchPlanIds).toEqual(first.projects[1]!.scratchPlanIds);
  }, 300_000);

  it('a custom shape with no --out is announced as custom, and a failed seed writes no manifest', async () => {
    const { usersService } = await import('@/lib/services/usersService');
    const { endpointHost } = await import('@/loadtest/lib/endpointHost');
    const local = endpointHost(process.env['DATABASE_URL'])!;
    const shapePath = join(dir, 'custom-shape.json');
    await writeFile(
      shapePath,
      JSON.stringify({ ...SMOKE_SHAPE, smoke: false, workspaces: 6, users: 6 }),
    );
    // The seed's first write is a user; refusing it stops the seed before any row
    // exists, so the default manifest path (loadtest/.out/) is never written.
    const refusal = new Error('stop before the first write');
    const spy = vi.spyOn(usersService, 'createUser').mockRejectedValue(refusal);
    const lines: string[] = [];
    try {
      await expect(
        runSeed(
          ['--tag', 'covcustom', '--shape', shapePath],
          env({
            DATABASE_URL: process.env['DATABASE_URL'],
            DATABASE_URL_UNPOOLED: process.env['DATABASE_URL'],
            LOADTEST_ALLOWED_DB_HOST: local,
          }),
          (l) => lines.push(l),
        ),
      ).rejects.toBe(refusal);
    } finally {
      spy.mockRestore();
    }
    expect(lines[0]).toBe(`seeding tag "covcustom" (custom shape) into ${local}`);
    expect(lines.some((l) => l.startsWith('manifest written'))).toBe(false);
    expect(await adminDb.user.count({ where: { email: { contains: 'covcustom' } } })).toBe(0);
  });
});
