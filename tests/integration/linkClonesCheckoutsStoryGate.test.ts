import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET as GET_REPOSITORIES } from '@/app/api/v1/projects/[projectKey]/repositories/route';
import { projectRepositorySchema } from '@/lib/api/v1/projects/repositories';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { toProjectRepositoryList } from '../../packages/cli/src/adapters/reads';
import {
  planRepoClones,
  runRepoClones,
  type RepoClonePlanEntry,
} from '../../packages/cli/src/repoClone';
import {
  materializeDispatchCheckouts,
  resolveDispatchTarget,
  resolveDispatchTargets,
} from '../../packages/cli/src/dispatch';
import type { CommandRunner } from '../../packages/cli/src/git';
import type { LinkConfig } from '../../packages/cli/src/config/linkConfig';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { createV1Caller, createV1ProjectCaller, withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// STORY GATE for MOTIR-3584 — `motir link` brings the code down (Subtask
// MOTIR-3590). It runs over the story's ASSEMBLED state and measures the seams
// BETWEEN its cards, not their individual rules — each of which is already
// covered by the card that shipped it:
//
//   * `tests/api/v1/project-repositories-route.test.ts` — the endpoint, its
//     permission gate, its tenant isolation and its mapper.
//   * `packages/cli/test/repoClone.test.ts` — the whole clone-decision matrix.
//   * `packages/cli/test/linkMaterialize.test.ts` — the link command's step.
//   * `packages/cli/test/dispatchMaterialize.test.ts` — the routing change.
//
// The questions NONE of them can answer about itself, and this file exists for:
//
//   1. THE WIRE ⟷ THE CLIENT. The endpoint's own tests assert the response the
//      route builds; the CLI's assert a hand-written fixture. A key renamed on
//      either side passes both and fails a user's terminal. This drives the REAL
//      response body through the REAL adapter, over real Postgres.
//   2. THE SHAPES THE SERVER CAN REALLY EMIT. The CLI's planner is exercised on
//      fixtures somebody typed. Here it is exercised on rows in three distinct
//      establish states, including one whose provider yields a null clone URL —
//      a shape a fixture author has no reason to invent.
//   3. THE DISPATCH PAYLOAD'S CLONE URL. The single-repository path and the
//      set path read different fields; a card shipping in two repositories must
//      materialize both, and a card shipping in one must read the scalar.
//   4. ONE CLONE IMPLEMENTATION. A source guard, because a second `git clone`
//      site is exactly how the ADR's rules get honoured in one place and not the
//      other — and it is invisible to every behavioural test of either.

const ROOT = '/home/yue/work';
const LINK: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

const none = () => false;
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** Connect one repository to the workspace, under a chosen PROVIDER — the axis
 *  that decides whether Motir can derive a clone URL at all. */
async function connectRepo(
  workspaceId: string,
  name: string,
  opts: { provider?: string; defaultBranch?: string } = {},
): Promise<string> {
  const provider = opts.provider ?? 'github';
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${workspaceId}-${provider}` },
    create: {
      installationId: `inst-${workspaceId}-${provider}`,
      workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      repoId: `repo-${name}-${randomBytes(6).toString('hex')}`,
      owner: 'moooon',
      name,
      defaultBranch: opts.defaultBranch ?? 'main',
      archived: false,
      provider,
    },
  });
  return repo.id;
}

async function establish(
  fx: WorkItemFixture,
  name: string,
  opts: { role?: 'web' | 'api' | 'shared'; provider?: string } = {},
): Promise<void> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: opts.role ?? 'web', name },
    fx.ctx,
  );
  const repoId = await connectRepo(fx.workspaceId, name, opts);
  await projectRepoSetService.attachRealizedRepo(row.id, repoId, fx.ctx);
}

function recorder(): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = (_bin, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

/** The real endpoint, as the CLI's transport would receive it. */
async function readRepositories(
  headers: Record<string, string>,
  key: string,
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const res = await GET_REPOSITORIES(
    new Request(`http://localhost:3000/api/v1/projects/${key}/repositories`, { headers }),
    { params: Promise.resolve({ projectKey: key }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { items: unknown[]; nextCursor: string | null };
}

describe('seam 1 — the v1 response through the CLI’s own adapter', () => {
  it('the REAL body feeds the REAL adapter, and the planner acts on it', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establish(caller.fixture, 'acme-web', { role: 'web' });

    const page = await readRepositories(caller.headers, caller.projectKey);
    // The adapter is the CLI's, imported here rather than re-implemented — a key
    // renamed on either side fails at this line instead of at a terminal.
    const { repositories } = toProjectRepositoryList([page as never]);

    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      name: 'acme-web',
      cloneUrl: 'https://github.com/moooon/acme-web.git',
      defaultBranch: 'main',
      established: true,
    });

    const { run, calls } = recorder();
    runRepoClones(ROOT, planRepoClones(ROOT, LINK, repositories, { exists: none }), { run });

    // The full round trip: a row the server wrote produces the git command the
    // user's terminal would run.
    expect(calls).toEqual([
      ['clone', 'https://github.com/moooon/acme-web.git', '/home/yue/work/acme-web'],
    ]);
  });

  it('fails if a published field the adapter reads is dropped or renamed', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establish(caller.fixture, 'acme-web');

    const page = await readRepositories(caller.headers, caller.projectKey);

    // Both sides, asserted against each other rather than against a fixture:
    // the wire row parses as the declared schema, and the adapter's output
    // carries every field the planner branches on.
    for (const row of page.items) expect(() => projectRepositorySchema.parse(row)).not.toThrow();
    const [repo] = toProjectRepositoryList([page as never]).repositories;
    for (const field of ['id', 'role', 'name', 'cloneUrl', 'state', 'established'] as const) {
      expect(repo, `the adapter dropped ${field}`).toHaveProperty(field);
    }
  });
});

describe('seam 2 — the shapes the server can really emit', () => {
  it('drives the planner over three distinct establish states from real Postgres', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establish(caller.fixture, 'acme-web', { role: 'web' });
    // ESTABLISHED, and yet un-materializable: a provider this build cannot
    // address, so `repoCloneUrl` answers null rather than guessing a host.
    await establish(caller.fixture, 'acme-legacy', { role: 'shared', provider: 'bitbucket' });
    // PROPOSED — a real member of the set with no repository behind it.
    await projectRepoSetService.addRow(
      caller.fixture.projectId,
      { role: 'api', name: 'acme-api' },
      caller.fixture.ctx,
    );

    const page = await readRepositories(caller.headers, caller.projectKey);
    const { repositories } = toProjectRepositoryList([page as never]);
    const plan = planRepoClones(ROOT, LINK, repositories, { exists: none });

    // Three rows in, three outcomes out — and the two skips are DIFFERENT, which
    // is the whole reason `established` rides beside `cloneUrl` on the wire.
    expect(plan.map((e: RepoClonePlanEntry) => e.kind)).toEqual(['clone', 'skip', 'skip']);
    expect(plan[1]).toMatchObject({ skipReason: 'no_clone_url', state: 'connected' });
    expect(plan[2]).toMatchObject({ skipReason: 'not_established', state: 'proposed' });

    const { run, calls } = recorder();
    runRepoClones(ROOT, plan, { run });
    expect(calls).toHaveLength(1);
  });

  it('answers a token carrying EXACTLY the CLI grant, and nobody else’s', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establish(caller.fixture, 'acme-web');

    // The gate that is invisible to every test authenticating as an owner: the
    // one caller this endpoint exists for holds a fixed, narrow grant.
    const cli = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      permissions: [...CLI_TOKEN_GRANT],
      projectId: caller.fixture.projectId,
    });
    await readRepositories(cli.headers, caller.projectKey);

    const stranger = await createV1Caller({ scopes: ['read'], workspaceName: 'Elsewhere' });
    const refused = await GET_REPOSITORIES(
      new Request(`http://localhost:3000/api/v1/projects/${caller.projectKey}/repositories`, {
        headers: stranger.headers,
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(refused.status).toBe(404);
  });
});

describe('seam 3 — the dispatch payload’s clone URL', () => {
  it('materializes EVERY repository of a set, from each element’s own URL', () => {
    // The multi-repository path: the shape `toDispatchPrompt` hands the launcher.
    const targets = resolveDispatchTargets(
      ROOT,
      LINK,
      [
        { name: 'motir-core', cloneUrl: 'https://github.com/moooon/motir-core.git' },
        { name: 'motir-ai', cloneUrl: 'https://github.com/moooon/motir-ai.git' },
      ],
      { exists: none },
    );

    const { run, calls } = recorder();
    materializeDispatchCheckouts(ROOT, targets, { run });

    expect(calls).toEqual([
      ['clone', 'https://github.com/moooon/motir-core.git', '/home/yue/work/motir-core'],
      ['clone', 'https://github.com/moooon/motir-ai.git', '/home/yue/work/motir-ai'],
    ]);
  });

  it('reads the SCALAR on the single-repository path, and preserves bootstrap without one', () => {
    const withUrl = resolveDispatchTarget(ROOT, LINK, 'motir-core', {
      exists: none,
      cloneUrl: 'https://github.com/moooon/motir-core.git',
    });
    const withoutUrl = resolveDispatchTarget(ROOT, LINK, 'brand-new', { exists: none });

    expect(withUrl.reason).toBe('clonable_checkout');
    // The genuine empty-folder bootstrap, provably preserved.
    expect(withoutUrl.reason).toBe('bootstrap_root');
    expect(withoutUrl.cwd).toBe(ROOT);
  });

  it('never issues a git command for a checkout that is already there', () => {
    const targets = resolveDispatchTargets(
      ROOT,
      LINK,
      [{ name: 'motir-core', cloneUrl: 'https://github.com/moooon/motir-core.git' }],
      { exists: only('/home/yue/work/motir-core') },
    );

    const { run, calls } = recorder();
    materializeDispatchCheckouts(ROOT, targets, { run });

    // The never-touch invariant, held on the DISPATCH path too — the planner's
    // own suite holds it for the link path, and it must not be true in only one.
    expect(calls).toEqual([]);
  });
});

describe('seam 4 — ONE clone implementation', () => {
  /** Every `.ts` under `packages/cli/src`, relative to that root. */
  function cliSources(dir: string, base = dir, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) cliSources(full, base, acc);
      else if (entry.endsWith('.ts')) acc.push(relative(base, full));
    }
    return acc;
  }

  it('only `repoClone.ts` invokes `git clone`', () => {
    const root = join(process.cwd(), 'packages', 'cli', 'src');
    const offenders = cliSources(root).filter((file) => {
      if (file === 'repoClone.ts') return false;
      const source = readFileSync(join(root, file), 'utf8');
      // The shape a `CommandRunner` invocation takes: `'clone'` as the first
      // element of the argument array handed to git.
      return /\[\s*'clone'/.test(source) || /"clone"\s*,/.test(source);
    });

    // A second site is how the ADR's rules — full clone, never write into an
    // existing path, the pending-invitation message — get honoured in one place
    // and not the other. Neither behavioural suite can see it.
    expect(offenders).toEqual([]);
  });

  it('the dispatch path reaches the clone THROUGH the link card’s primitive', () => {
    const source = readFileSync(
      join(process.cwd(), 'packages', 'cli', 'src', 'dispatch.ts'),
      'utf8',
    );

    expect(source).toContain("from './repoClone.js'");
    expect(source).toContain('runRepoClones(');
  });
});
