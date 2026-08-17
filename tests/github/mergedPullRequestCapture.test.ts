import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { toLinkedPullRequestDto } from '@/lib/mappers/githubMappers';
import { MAX_CAPTURED_PR_PATHS } from '@/lib/github/pullRequestFiles';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-2922 — the merge CAPTURE: a merged pull request's changed paths and its
// merge instant land on the `github_pull_request` row, and the accessor a
// subsumption check consumes reads them back. Real Postgres (the motir-core
// convention); the GitHub transport is stubbed at `fetch`, so what these tests
// assert is the ROW, never the fetcher's return value.
//
// The load-bearing assertion in this file is the one about FAILURE. The capture
// rides on a delivery whose real job is the status sync, and `notes.html` #39 is
// the standing rule that a post-commit side effect may never fail the committed
// work. A swallowed error that also swallowed the sync would satisfy "no
// exception escaped" while destroying the thing the delivery exists for — so the
// test compares the sync's whole outcome against a control run in which the fetch
// succeeded, rather than merely checking that nothing threw.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-capture';
const REPO_PROVIDER_ID = '777';
const MERGED_AT = '2026-08-15T09:30:00.000Z';

async function makeScenario(
  email: string,
  ids: { installationId?: string; providerRepoId?: string; identifier?: string } = {},
) {
  const installationId = ids.installationId ?? INSTALLATION_ID;
  const providerRepoId = ids.providerRepoId ?? REPO_PROVIDER_ID;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: ids.identifier ?? 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId,
        owner: 'moooon-B-V',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  return { user, workspace, project, item, ctx, repo, installationId, providerRepoId };
}

function prPayload(opts: {
  action: string;
  identifier: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  mergedAt?: string | null;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon-B-V', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 11,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      merged_at: opts.mergedAt === undefined ? (opts.merged ? MERGED_AT : null) : opts.mergedAt,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** Wire the GitHub App credentials the installation-token mint needs. */
function stubAppCredentials() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_capture',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

/** Stub the App-auth mint + the files endpoint, PAGINATING `files` the way GitHub
 *  does. `files: null` makes the files read fail with a non-retryable status —
 *  the "GitHub blip" case. */
function stubGithub(opts: { files: string[] | null }) {
  stubAppCredentials();
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/access_tokens')) return tokenResponse();
    if (u.includes('/files')) {
      if (opts.files === null) return new Response('gone', { status: 404 });
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      const slice = opts.files.slice((page - 1) * 100, page * 100);
      return new Response(JSON.stringify(slice.map((filename) => ({ filename }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function prRow(number: number) {
  return adminDb.githubPullRequest.findFirst({ where: { number } });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the merge capture writes the row (MOTIR-2922)', () => {
  it('a MERGED delivery stores the changed paths and the merge instant', async () => {
    const s = await makeScenario('merge-capture@example.com');
    const { calls } = stubGithub({ files: ['lib/services/workflowsService.ts', 'prisma/x.sql'] });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(['lib/services/workflowsService.ts', 'prisma/x.sql']);
    expect(row!.changedPathsTruncated).toBe(false);
    expect(row!.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(calls.some((u) => u.includes('/pulls/11/files'))).toBe(true);
  });

  it('a delivery for an OPEN pull request stores NEITHER, and never reads the host', async () => {
    const s = await makeScenario('open-capture@example.com');
    const { calls } = stubGithub({ files: ['should-never-be-read.ts'] });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    const row = await prRow(11);
    expect(row!.state).toBe('open');
    expect(row!.changedPaths).toEqual([]);
    expect(row!.mergedAt).toBeNull();
    // Not merely "no paths stored" — the capture must not even ASK, or every open
    // and every synchronize delivery would spend a rate-limited request each.
    expect(calls.some((u) => u.includes('/files'))).toBe(false);
  });

  it('the merge instant comes from the PAYLOAD, and a payload without one stays null', async () => {
    const s = await makeScenario('no-merged-at@example.com');
    stubGithub({ files: ['a.ts'] });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: true,
        mergedAt: null,
      }),
    );

    const row = await prRow(11);
    // Null, never `now()`: a stamped-at-ingestion time would LOOK like the merge
    // instant and be the delivery instant, and a redelivery would move it.
    expect(row!.mergedAt).toBeNull();
    expect(row!.changedPaths).toEqual(['a.ts']);
  });
});

describe('a failed capture leaves the status sync untouched (notes.html #39)', () => {
  it('the sync outcome and the transition are IDENTICAL to a run whose fetch succeeded', async () => {
    // Control: the fetch succeeds.
    const ok = await makeScenario('capture-control@example.com');
    stubGithub({ files: ['lib/db.ts'] });
    const okResult = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: ok.item.identifier,
        state: 'closed',
        merged: true,
      }),
    );
    const okStatus = await statusOf(ok.item.id);
    const okRow = await prRow(11);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    // The same delivery, with GitHub refusing the files read.
    await truncateAuthTables();
    _resetInstallationTokenCache();
    const bad = await makeScenario('capture-blip@example.com');
    stubGithub({ files: null });
    const badResult = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: bad.item.identifier,
        state: 'closed',
        merged: true,
      }),
    );
    const badStatus = await statusOf(bad.item.id);
    const badRow = await prRow(11);

    // The outcome the delivery reports — the whole object, not just "it didn't
    // throw". A swallowed error that also swallowed the sync passes the weaker
    // check and fails this one.
    expect(badResult).toEqual({
      ...okResult,
      workItemId: bad.item.id,
    });
    expect(badStatus).toBe(okStatus);
    expect(badStatus).toBe('done');
    // The row is written all the same: the merge instant is read from the
    // delivery we already hold, so only the paths are lost.
    expect(badRow!.merged).toBe(true);
    expect(badRow!.state).toBe(okRow!.state);
    expect(badRow!.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(badRow!.changedPaths).toEqual([]);
    expect(badRow!.changedPathsTruncated).toBe(false);
  });

  it('an unreachable host is swallowed the same way a 4xx is', async () => {
    const s = await makeScenario('capture-unreachable@example.com');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual([]);
    expect(row!.mergedAt?.toISOString()).toBe(MERGED_AT);
  });
});

describe('the cap is stored, and it SAYS it capped (MOTIR-2922)', () => {
  it('a file list past MAX_CAPTURED_PR_PATHS stores exactly the cap and flags truncation', async () => {
    const s = await makeScenario('capture-cap@example.com');
    // 301 files across four pages of 100 — one past the cap.
    const files = Array.from({ length: 301 }, (_, i) => `packages/generated/f-${i}.ts`);
    stubGithub({ files });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    const row = await prRow(11);
    expect(row!.changedPaths).toHaveLength(MAX_CAPTURED_PR_PATHS);
    expect(row!.changedPaths[0]).toBe('packages/generated/f-0.ts');
    expect(row!.changedPathsTruncated).toBe(true);
  });

  it('a file list under the cap stores every path and leaves the flag false', async () => {
    const s = await makeScenario('capture-under-cap@example.com');
    const files = Array.from({ length: 5 }, (_, i) => `app/page-${i}.tsx`);
    stubGithub({ files });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(files);
    expect(row!.changedPathsTruncated).toBe(false);
  });
});

describe('no shipped consumer of GithubPullRequest changes shape', () => {
  it('the Development-surface DTO carries exactly its documented keys after a capture', async () => {
    const s = await makeScenario('dto-shape@example.com');
    stubGithub({ files: ['lib/db.ts'] });
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    // Read through a BOUND context, as the Development surface itself does: an
    // unbound read of `github_pull_request` under `motir_app` returns [] without
    // raising, so it would assert the DTO's shape against no rows at all.
    const rows = await withWorkspaceContext(s.ctx, (tx) =>
      githubPullRequestRepository.listByWorkItemWithContext(s.item.id, tx),
    );
    expect(rows).toHaveLength(1);
    const dto = toLinkedPullRequestDto(rows[0]!);

    // The mapper enumerates its fields, so a new column cannot leak into the wire
    // shape — this pins that, because "it enumerates" is a property of today's
    // mapper and the DTO is what a client parses.
    expect(Object.keys(dto).sort()).toEqual(
      ['ci', 'linkedManually', 'number', 'repo', 'state', 'title', 'url'].sort(),
    );
    expect(dto).toMatchObject({ state: 'merged', number: 11, repo: 'moooon-B-V/motir-core' });
  });
});

describe('findMergedTouchingPaths — the single read the subsumption check consumes', () => {
  /** Seed one PR row directly: these cases are about the QUERY, so they are set
   *  up as data rather than driven through six webhook deliveries. */
  async function seedPr(
    repoId: string,
    number: number,
    opts: {
      merged?: boolean;
      state?: string;
      mergedAt?: Date | null;
      changedPaths?: string[];
      workItemId?: string | null;
    },
  ) {
    return adminDb.githubPullRequest.create({
      data: {
        repoId,
        number,
        state: opts.state ?? 'closed',
        merged: opts.merged ?? true,
        headRef: `subtask/MOTIR-${number}`,
        title: `PR ${number}`,
        mergedAt: opts.mergedAt === undefined ? new Date('2026-08-15T12:00:00Z') : opts.mergedAt,
        changedPaths: opts.changedPaths ?? ['lib/services/workflowsService.ts'],
        workItemId: opts.workItemId ?? null,
      },
    });
  }

  async function query(
    s: Awaited<ReturnType<typeof makeScenario>>,
    paths: string[],
    since: Date,
    exclude: string | null,
  ) {
    return withWorkspaceContext(s.ctx, (tx) =>
      githubPullRequestRepository.findMergedTouchingPaths(
        s.workspace.id,
        paths,
        since,
        exclude,
        tx,
      ),
    );
  }

  it('returns a merged row whose paths intersect and whose merge is after `since`', async () => {
    const s = await makeScenario('accessor-hit@example.com');
    await seedPr(s.repo.id, 101, {});

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );

    expect(found.map((r) => r.number)).toEqual([101]);
    expect(found[0]!.repo.name).toBe('motir-core');
  });

  it('omits a row merged BEFORE `since`', async () => {
    const s = await makeScenario('accessor-old@example.com');
    await seedPr(s.repo.id, 102, { mergedAt: new Date('2026-08-01T00:00:00Z') });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );

    expect(found).toEqual([]);
  });

  it('omits a row whose paths do not intersect', async () => {
    const s = await makeScenario('accessor-miss@example.com');
    await seedPr(s.repo.id, 103, { changedPaths: ['README.md'] });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );

    expect(found).toEqual([]);
  });

  it('omits an OPEN row even when its paths intersect', async () => {
    const s = await makeScenario('accessor-open@example.com');
    await seedPr(s.repo.id, 104, { state: 'open', merged: false });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );

    expect(found).toEqual([]);
  });

  it('omits the row linked to `excludeWorkItemId`, and KEEPS an unlinked one', async () => {
    const s = await makeScenario('accessor-exclude@example.com');
    await seedPr(s.repo.id, 105, { workItemId: s.item.id });
    await seedPr(s.repo.id, 106, { workItemId: null });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      s.item.id,
    );

    // The asking card's own merge is not evidence that someone else shipped its
    // deliverable; an UNLINKED merge touched the paths just the same, and the
    // missing link is a fact about the tracker, not about the repository.
    expect(found.map((r) => r.number)).toEqual([106]);
  });

  it('is scoped to the workspace, and an empty path set reads nothing', async () => {
    const s = await makeScenario('accessor-tenant@example.com');
    const other = await makeScenario('accessor-tenant-other@example.com', {
      installationId: 'inst-capture-other',
      providerRepoId: '778',
      identifier: 'OTHR',
    });
    // One PR in EACH workspace's repo, identical in every other respect.
    await seedPr(s.repo.id, 107, {});
    await seedPr(other.repo.id, 108, {});

    const mine = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );
    expect(mine.map((r) => r.number)).toEqual([107]);

    const theirs = await query(
      other,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
      null,
    );
    expect(theirs.map((r) => r.number)).toEqual([108]);

    // No paths to ask about is not "match everything" — it is nothing to match.
    expect(await query(s, [], new Date('2026-08-12T00:00:00Z'), null)).toEqual([]);
  });
});
