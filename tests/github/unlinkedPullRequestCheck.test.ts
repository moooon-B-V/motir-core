import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { LINK_CHECK_NAME, NO_WORK_ITEM_LABEL } from '@/lib/services/pullRequestLinkCheckService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { readPullRequestHeadSha, writeCheckRun } from '@/lib/github/checkRuns';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE UNLINKED-PULL-REQUEST CHECK (Story MOTIR-3672 · MOTIR-3675), against a real
// Postgres with only the GitHub HOST stubbed — the same boundary the historical
// backfill suite stubs, and for the same reason: a real check-run write needs an
// App private key the test environment has no business carrying.
//
// What is asserted is the DECISION and the WRITE SHAPE: which pull requests get a
// failing check, which are exempt, that linking clears it in place rather than
// stacking a second run, and that a refusal is silent. `docs/decisions/
// unlinked-pull-request-check.md` is what those answers come from.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-linkcheck';
const REPO_PROVIDER_ID = '96001';
const HEAD_SHA = 'a'.repeat(40);

interface CheckCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

let calls: CheckCall[] = [];
/** Ids the stubbed host reports as already existing at the head sha — empty means
 *  "no run yet", which is what makes the next write a POST. */
let existingRunIds: number[] = [];
/** The status the stubbed host answers a check-run WRITE with. 403 is the App
 *  without `checks: write` — the state every installation is in until an admin
 *  approves the added permission. */
let writeStatus = 201;

function stubHost(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (url.includes('/check-runs')) {
        calls.push({ method, url, body });
        if (method === 'GET')
          return new Response(
            JSON.stringify({ check_runs: existingRunIds.map((id) => ({ id })) }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ id: 1 }), { status: writeStatus });
      }
      // The head-sha read the link side makes when it has no delivery to take one
      // from.
      if (/\/pulls\/\d+$/.test(url))
        return new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
      // The merge-capture file listing — not this suite's subject.
      if (url.includes('/files')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
}

/** Only the check-run WRITES, in order — the reads are plumbing. */
function writes(): CheckCall[] {
  return calls.filter((c) => c.method !== 'GET');
}

async function makeScenario(
  email: string,
  opts: { planned?: boolean } = {},
): Promise<{
  user: { id: string };
  workspace: { id: string };
  project: { id: string };
  ctx: { userId: string; workspaceId: string };
  repoRowId: string;
}> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: REPO_PROVIDER_ID },
  });
  // A repository BOUND to a project is what makes it one Motir plans work in —
  // the ADR's second exemption, expressed with the concept that already exists.
  if (opts.planned !== false) {
    await adminDb.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: 'web',
        name: 'acme',
        seedSource: 'starter',
        state: 'connected',
        position: 'a0',
        githubRepoId: repoRow.id,
      },
    });
  }
  return {
    user,
    workspace,
    project,
    ctx: { userId: user.id, workspaceId: workspace.id },
    repoRowId: repoRow.id,
  };
}

function prPayload(opts: {
  action?: string;
  number?: number;
  headRef?: string;
  title?: string;
  authorType?: string;
  draft?: boolean;
  labels?: string[];
  headSha?: string;
  repoId?: number;
  installationId?: string;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: {
      id: opts.installationId ?? INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 61,
      state: 'open',
      merged: false,
      draft: opts.draft ?? false,
      title: opts.title ?? 'A change nobody linked',
      head: { ref: opts.headRef ?? 'feat/some-work', sha: opts.headSha ?? HEAD_SHA },
      base: { ref: 'main' },
      user: { id: 4242, type: opts.authorType ?? 'User' },
      labels: (opts.labels ?? []).map((name) => ({ name })),
    },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  calls = [];
  existingRunIds = [];
  writeStatus = 201;
  stubHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('an UNLINKED pull request fails its checks (MOTIR-3675)', () => {
  it('writes a FAILING check naming the call that fixes it, the hint, and the hatch', async () => {
    await makeScenario('lc-unlinked@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ headRef: 'feat/ACME-1-a-change' }),
    );

    expect(writes()).toHaveLength(1);
    const write = writes()[0]!;
    expect(write.method).toBe('POST');
    expect(write.body).toMatchObject({
      name: LINK_CHECK_NAME,
      head_sha: HEAD_SHA,
      status: 'completed',
      conclusion: 'failure',
    });
    const summary = String((write.body!['output'] as Record<string, unknown>)['summary']);
    // "The message is the feature": the fix, the hatch, and — because the branch
    // happens to name one — the key to try. Motir does NOT resolve that key; the
    // text says so, which is what keeps it a hint rather than the retired parse.
    expect(summary).toContain('link_pull_request');
    expect(summary).toContain('moooon/acme');
    expect(summary).toContain(NO_WORK_ITEM_LABEL);
    expect(summary).toContain('ACME-1');
    expect(summary).toContain('it is a hint, not');
  });

  it('LINKING it clears the failure in place, with no new push', async () => {
    const s = await makeScenario('lc-clears@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'The card it delivers' },
      s.ctx,
    );
    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 62 }));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ conclusion: 'failure' });

    // The host now reports the run this suite just created, so the next write is
    // an update of THAT run rather than a second one below it.
    existingRunIds = [77];
    writeStatus = 200;

    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'acme',
        number: 62,
        headRef: 'feat/some-work',
        baseRef: 'main',
        title: 'A change nobody linked',
      },
      s.ctx,
    );

    // No delivery arrived in between — this is the whole criterion.
    expect(writes()).toHaveLength(2);
    const cleared = writes()[1]!;
    expect(cleared.method).toBe('PATCH');
    expect(cleared.url).toContain('/check-runs/77');
    expect(cleared.body).toMatchObject({ conclusion: 'success' });
  });

  it('is IDEMPOTENT across redeliveries — one check run, updated, never a second', async () => {
    await makeScenario('lc-idempotent@example.com');

    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 63 }));
    existingRunIds = [88];
    writeStatus = 200;
    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 63 }));
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 63, action: 'synchronize' }),
    );

    const posts = writes().filter((c) => c.method === 'POST');
    const patches = writes().filter((c) => c.method === 'PATCH');
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(2);
    for (const p of patches) expect(p.url).toContain('/check-runs/88');
  });

  it('follows the HEAD COMMIT — a `synchronize` delivery writes at the new sha', async () => {
    // A check run belongs to a commit, so one written at `opened` is not on the
    // sha GitHub shows after a push. This is why `synchronize` is in the check's
    // own action set even though `HANDLED_PR_ACTIONS` deliberately excludes it.
    await makeScenario('lc-sync@example.com');
    const second = 'b'.repeat(40);

    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 64 }));
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 64, action: 'synchronize', headSha: second }),
    );

    expect(writes().map((c) => c.body!['head_sha'])).toEqual([HEAD_SHA, second]);
  });

  it('a 403 — the App without `checks: write` — is SILENT, and the delivery still syncs', async () => {
    const s = await makeScenario('lc-403@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Still synced' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'acme',
        number: 65,
        headRef: 'feat/some-work',
        baseRef: 'main',
        title: 'Still synced',
      },
      s.ctx,
    );
    writeStatus = 403;
    calls = [];

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 65 }),
    );

    // The check was attempted and refused; the delivery's load-bearing effect is
    // untouched. An installation that has not approved the added permission is a
    // deployment state, not an error.
    expect(writes()).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
  });
});

describe('the exemptions — each stated as a rule, each with its own case', () => {
  it('a BOT-authored pull request gets no check', async () => {
    await makeScenario('lc-bot@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 71, authorType: 'Bot', title: 'chore(deps): bump acme from 1 to 2' }),
    );

    expect(writes()).toHaveLength(0);
  });

  it('a DRAFT gets no check until it is marked ready for review', async () => {
    await makeScenario('lc-draft@example.com');

    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 72, draft: true }));
    expect(writes()).toHaveLength(0);

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 72, action: 'ready_for_review', draft: false }),
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ conclusion: 'failure' });
  });

  it(`the \`${NO_WORK_ITEM_LABEL}\` label is the hatch, and it works on the label delivery`, async () => {
    await makeScenario('lc-label@example.com');

    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 73 }));
    expect(writes()).toHaveLength(1);

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 73, action: 'labeled', labels: [NO_WORK_ITEM_LABEL] }),
    );

    // Exempt: no second write at all. The failing run stays where it is until the
    // pull request is pushed to, and a repository that wants it gone can dismiss
    // it — Motir does not delete a person's checks.
    expect(writes()).toHaveLength(1);
  });

  it('a repository CONNECTED but not bound to a project gets no check', async () => {
    // Connected so Motir can read the code is not the same as a repository whose
    // pull requests owe a card. `ProjectRepo` is the distinction.
    await makeScenario('lc-unplanned@example.com', { planned: false });

    await githubWebhookService.handleEvent('pull_request', prPayload({ number: 74 }));

    expect(writes()).toHaveLength(0);
  });

  it('a repository Motir does not know at all gets no check', async () => {
    await makeScenario('lc-unknown@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 75, repoId: 999999 }),
    );

    expect(writes()).toHaveLength(0);
  });

  it('a delivery with NO installation id, and one with no pull request, write nothing', async () => {
    // The two defensive arms. Neither can produce a check — there is nothing to
    // address one to — and neither may throw: the delivery's load-bearing effect
    // is the status sync, and a check that cannot be written must not make GitHub
    // retry a delivery for ever.
    await makeScenario('lc-malformed@example.com');

    const noInstallation = { ...prPayload({ number: 77 }), installation: undefined };
    await expect(
      githubWebhookService.handleEvent('pull_request', noInstallation),
    ).resolves.toBeDefined();

    const noPullRequest = { ...prPayload({ number: 78 }), pull_request: undefined };
    await expect(
      githubWebhookService.handleEvent('pull_request', noPullRequest),
    ).resolves.toBeDefined();

    expect(writes()).toHaveLength(0);
  });

  it('a CLOSED delivery writes nothing — a closed pull request cannot be linked forward', async () => {
    await makeScenario('lc-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ number: 76, action: 'closed' }),
    );

    expect(writes()).toHaveLength(0);
  });
});

// ⚠️ THE URL GUARD, asserted at the leaf rather than through a delivery. Every
// path segment this module interpolates is whitelisted before a URL exists
// (`lib/github/checkRuns.ts`), and the contract is not "the request fails" — it
// is that NO REQUEST IS MADE. A best-effort writer that must never throw is
// exactly the place a malformed segment would otherwise go out silently, so the
// observable is the fetch count, and each case is one segment kind.
describe('a segment that is not a thing GitHub could have named makes no request', () => {
  function fetchCalls(): number {
    return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
  }

  const spec = {
    installationId: INSTALLATION_ID,
    owner: 'acme',
    name: 'web',
    headSha: HEAD_SHA,
    conclusion: 'failure' as const,
    title: 't',
    summary: 's',
  };

  it.each([
    ['an owner that walks the API path', { owner: '..' }],
    ['a NAME that walks it — the other half of the same grammar', { name: '..' }],
    ['an owner carrying a dot, which no GitHub login has', { owner: 'ac.me' }],
    ['a name that truncates the URL with a query', { name: 'web?x=1' }],
    ['a name that truncates it with a fragment', { name: 'web#x' }],
    ['a name carrying its own path separator', { name: 'web/extra' }],
    ['an empty owner', { owner: '' }],
    ['a head sha that is not a hex commit', { headSha: 'HEAD' }],
  ])('%s is refused before the write — %o', async (_label, patch) => {
    const outcome = await writeCheckRun({ ...spec, ...patch });

    expect(outcome).toBe('unavailable');
    expect(fetchCalls()).toBe(0);
  });

  // The number reads as immune because it is arithmetic — but it arrives as JSON,
  // where it is a number only by convention, and `Number.isInteger` admits two
  // values that are integers and still not path segments.
  it.each([
    ['zero', 0],
    ['a negative, which walks a `-` into the path', -5],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an integer so large it stringifies to `1e+21`', 1e21],
  ])('a pull request number that is %s is refused before the read', async (_label, number) => {
    const sha = await readPullRequestHeadSha(INSTALLATION_ID, 'acme', 'web', number);

    expect(sha).toBeNull();
    expect(fetchCalls()).toBe(0);
  });

  it('and a well-formed one still reads the head sha, so the guard is not a wall', async () => {
    const sha = await readPullRequestHeadSha(INSTALLATION_ID, 'acme', 'web', 42);

    expect(sha).toBe(HEAD_SHA);
    expect(fetchCalls()).toBe(1);
  });
});
