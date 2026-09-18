import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

/** The one external a design publish touches; mocked as a STORE so the publish's
 *  authoritative size/type read answers what was put. */
const blobs = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => blobs.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { designEvidenceService, designPrefix } from '@/lib/services/designEvidenceService';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { shaFor } from '../helpers/commitShaFixtures';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE EJECTION ARM (Story MOTIR-5461 · MOTIR-5632; `docs/decisions/approval-gates.md`
// §4 THIRD AMENDMENT, decisions 1–4, 6 and 9), on a REAL Postgres, through the real
// webhook service — the door a GitHub delivery walks. The `dequeued` bodies are the
// REAL deliveries MOTIR-5627 captured (`tests/fixtures/github/merge-queue/`), with only
// the installation, the repository id, the number and the head re-pointed at this
// fixture's rows.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-queue-exit';
const REPO_PROVIDER_ID = '993';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';

type Captured = 'dequeued-ci-failure' | 'dequeued-manual' | 'dequeued-merge';

function captured(name: Captured): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

/** A captured `dequeued` body, re-pointed at one of this fixture's pull requests. */
function dequeued(
  from: Captured,
  opts: { number: number; headSha: string; reason?: string | null },
): Record<string, unknown> {
  const body = captured(from);
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = opts.number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: opts.headSha };
  return {
    ...body,
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    number: opts.number,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID), full_name: 'moooon/acme' },
    pull_request: pr,
  };
}

const eject = (body: Record<string, unknown>, deliveryId: string) =>
  githubWebhookService.handleEvent('pull_request', body, deliveryId);

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto' = 'manual') {
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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: mode } });
  const ctx = { userId: user.id, workspaceId: workspace.id };
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
  return { user, workspace, project, ctx };
}

const ci = (number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

/** ANOTHER check completing green at a commit that already has one — a fresh row, so
 *  the verdict is recomputed (a repeat of the same check is idempotent and would wake
 *  nothing). */
const laterCheck = (number: number, headSha: string, name: string) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name,
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `subtask/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function card(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) await openLinked(item.identifier, number);
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const pr = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
const awaitingGates = async (workItemId: string) =>
  (await gates(workItemId)).filter((g) => g.state === 'awaiting');
const exits = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findMany({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'asc' },
  });

/** Record that Motir enqueued a pull request — what `recordMotirMerge` writes. */
async function markQueued(number: number) {
  await adminDb.githubPullRequest.update({
    where: { id: (await pr(number)).id },
    data: { mergeAuthority: 'gate', mergeOutcomeRef: `queue:entry-${number}` },
  });
}

/**
 * A `manual` card with pull requests #11 and #12, green at `sha-a` / `sha-b`, APPROVED
 * by a person, and both enqueued — the state a queue ejects from.
 */
async function approvedAndQueued(email: string) {
  const s = await makeScenario(email);
  const item = await card(s, 'Two pull requests', [11, 12]);
  await ci(11, 'sha-a');
  await ci(12, 'sha-b');
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate] = await awaitingGates(item.id);
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
    s.ctx,
  );
  expect(await statusOf(item.id)).toBe('approved');
  await markQueued(11);
  await markQueued(12);
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved };
}

beforeEach(async () => {
  blobs.clear();
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a FAILURE removal', () => {
  it('in a manual project: one exit row, the queued record cleared, the card back at implemented, the approval untouched', async () => {
    const { item, approved } = await approvedAndQueued('fail-manual@example.com');
    sent.length = 0;

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-fail-1',
    );

    expect(result).toMatchObject({
      event: 'pull_request_dequeued',
      outcome: 'recorded',
      disposition: 'failure',
      rawReason: 'CI_FAILURE',
      moved: [item.identifier],
      clearedQueuedOutcome: true,
    });
    const [row, ...more] = await exits(11);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      deliveryId: 'guid-fail-1',
      rawReason: 'CI_FAILURE',
      disposition: 'failure',
      headSha: 'sha-a',
      requeuedAt: null,
    });
    expect((await pr(11)).mergeOutcomeRef).toBeNull();
    // The authority is still true: a person asked for this enqueue.
    expect((await pr(11)).mergeAuthority).toBe('gate');
    // The sibling approved at its own head stays in the queue.
    expect((await pr(12)).mergeOutcomeRef).toBe('queue:entry-12');
    expect(await statusOf(item.id)).toBe('implemented');

    // The decided gate is a record: byte-for-byte what it was.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } });
    expect(after).toEqual(approved);
    expect(await awaitingGates(item.id)).toEqual([]);

    // One transition event, after commit.
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          workItemId: item.id,
          fromStatusKey: 'approved',
          toStatusKey: 'implemented',
        }),
      }),
    ]);
  });

  it('in an auto project: the card moves from in_review to implemented', async () => {
    const s = await makeScenario('fail-auto@example.com', 'auto');
    const item = await card(s, 'Auto merged', [21]);
    await ci(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await gates(item.id)).toEqual([]);
    await markQueued(21);

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 21, headSha: 'sha-auto' }),
      'guid-auto-1',
    );

    expect(result).toMatchObject({ outcome: 'recorded', moved: [item.identifier] });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it.each([
    'CI_TIMEOUT',
    'MERGE_CONFLICT',
    'INVALID_MERGE_COMMIT',
    'GIT_TREE_INVALID',
    'BRANCH_PROTECTIONS',
  ])('%s is a failure too', async (reason) => {
    const { item } = await approvedAndQueued(`fail-${reason}@example.com`);
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason }),
      `guid-${reason}`,
    );
    expect(await statusOf(item.id)).toBe('implemented');
    expect((await exits(11))[0]).toMatchObject({ rawReason: reason, disposition: 'failure' });
  });

  it('moves only a card at the enqueued status, and names the rest', async () => {
    const { s, item } = await approvedAndQueued('scope@example.com');
    const other = await card(s, 'Also delivered, still being worked', []);
    // A second delivery row for #11, written directly: the link door would also
    // re-sync the pull request's cards, and this test is about the arm's own scope.
    const row = await pr(11);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: other.id,
        githubPullRequestId: row.id,
        repoId: row.repoId,
      },
    });
    expect(await statusOf(other.id)).toBe('in_progress');
    expect(await statusOf(item.id)).toBe('approved');

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-scope',
    );

    expect(result).toMatchObject({
      moved: [item.identifier],
      skipped: [{ key: other.identifier, status: 'in_progress', reason: 'not_enqueued_status' }],
    });
    expect(await statusOf(other.id)).toBe('in_progress');
  });

  it('a pull request that delivers no card records the exit and moves nothing, without error', async () => {
    const s = await makeScenario('unlinked@example.com');
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 31,
        state: 'open',
        merged: false,
        title: 'Nobody linked me',
        head: { ref: 'feature/unlinked' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    void s;

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 31, headSha: 'sha-u' }),
      'guid-unlinked',
    );

    expect(result).toMatchObject({ outcome: 'recorded', moved: [], skipped: [] });
    expect(await exits(31)).toHaveLength(1);
  });
});

describe('NEUTRAL, UNKNOWN and LANDED removals', () => {
  it('a manual removal writes a neutral row, clears the queued record and leaves the card approved', async () => {
    const { item } = await approvedAndQueued('manual@example.com');

    const result = await eject(
      dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }),
      'guid-manual',
    );

    expect(result).toMatchObject({ outcome: 'recorded', disposition: 'neutral', moved: [] });
    expect((await exits(11))[0]).toMatchObject({ rawReason: 'MANUAL', disposition: 'neutral' });
    expect((await pr(11)).mergeOutcomeRef).toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('an unrecognised reason is recorded neutral, moves nothing, and is logged raw once', async () => {
    const { item } = await approvedAndQueued('unknown@example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: 'failed_checks' }),
      'guid-unknown',
    );

    expect(result).toMatchObject({ outcome: 'recorded', disposition: 'neutral', moved: [] });
    expect(await statusOf(item.id)).toBe('approved');
    const logged = warn.mock.calls.filter((call) =>
      String(call[0]).includes('unrecognised merge-queue removal reason'),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toMatchObject({ rawReason: 'failed_checks' });
  });

  it('a MERGE removal writes nothing and changes nothing', async () => {
    const { item } = await approvedAndQueued('landed@example.com');

    const result = await eject(
      dequeued('dequeued-merge', { number: 11, headSha: 'sha-a' }),
      'guid-landed',
    );

    expect(result).toMatchObject({ outcome: 'landed', disposition: 'landed' });
    expect(await exits(11)).toEqual([]);
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:entry-11');
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a delivery with no X-GitHub-Delivery header is refused rather than recorded without a key', async () => {
    await approvedAndQueued('no-guid@example.com');
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
    );
    expect(result).toMatchObject({ outcome: 'malformed' });
    expect(await exits(11)).toEqual([]);
  });
});

describe('IDEMPOTENCY — keyed on the delivery GUID', () => {
  it('the same delivery twice writes one row, and the second answers duplicate', async () => {
    const { item } = await approvedAndQueued('dup@example.com');
    const body = dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' });

    await eject(body, 'guid-same');
    const second = await eject(body, 'guid-same');

    expect(second).toMatchObject({ outcome: 'duplicate' });
    expect(await exits(11)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('two deliveries at the same head and reason are two exits', async () => {
    await approvedAndQueued('two@example.com');
    const body = dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' });

    await eject(body, 'guid-first');
    const second = await eject(body, 'guid-second');

    expect(second).toMatchObject({ outcome: 'recorded' });
    expect(await exits(11)).toHaveLength(2);
  });
});

describe('the PROMOTION HOLD (decision 6)', () => {
  it('after a failure exit, a green check at the SAME head leaves the card implemented with no awaiting gate', async () => {
    const { item } = await approvedAndQueued('hold@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-hold');

    const result = await laterCheck(11, 'sha-a', 'lint');
    expect(result).toMatchObject({ event: 'ci', ciState: 'passing' });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('the card ARRIVING at implemented by hand is held too', async () => {
    const { s, item } = await approvedAndQueued('hold-edge2@example.com');
    await eject(dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }), 'guid-neutral');
    await eject(dequeued('dequeued-ci-failure', { number: 12, headSha: 'sha-b' }), 'guid-fail-12');
    expect(await statusOf(item.id)).toBe('implemented');

    // A person moves it out and back in: the latch (edge 2) must not promote it.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a push to a NEW head re-arms: green promotes to in_review with exactly ONE fresh awaiting gate', async () => {
    const { item, approved } = await approvedAndQueued('rearm@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-rearm');

    await ci(11, 'sha-a2');

    expect(await statusOf(item.id)).toBe('in_review');
    const fresh = await awaitingGates(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    expect(fresh[0]!.id).not.toBe(approved.id);
  });
});

describe('NO SECOND GATE over approved commits (guard b)', () => {
  it('a green check on an approved card whose member is still queued raises nothing', async () => {
    const { item } = await approvedAndQueued('queued-green@example.com');

    const result = await laterCheck(12, 'sha-b', 'lint');
    expect(result).toMatchObject({ event: 'ci', ciState: 'passing' });

    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingGates(item.id)).toEqual([]);
  });
});

// ── MOTIR-5666: the merge question comes back ALONE, and the design cannot be
// swapped underneath it (`design-result.md` AMENDMENT 6 Q2 and Q3) ───────────────
describe('a DESIGN card the queue ejects', () => {
  /** Publish a design result onto `item`. */
  async function designed(s: Scenario, item: { id: string }) {
    await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
    const prefix = designPrefix(s.workspace.id, item.id);
    blobs.set(`${prefix}v1.mock.html`, { contentType: 'text/html', size: 2048 });
    blobs.set(`${prefix}v1.design-notes.md`, { contentType: 'text/markdown', size: 512 });
    return designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/work-items/v1.mock.html',
            pathname: `${prefix}v1.mock.html`,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            pathname: `${prefix}v1.design-notes.md`,
          },
        ],
        commitSha: shaFor('v1'),
      },
      s.ctx,
    );
  }

  /** Approve the card's design gate through the decide door. */
  async function approveDesign(s: Scenario, item: { id: string }) {
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: item.id, kind: 'design_result' },
    });
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );
    return { gate: await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } }) };
  }

  /**
   * `approvedAndQueued`, with a published and APPROVED design on the card.
   *
   * ⚠️ THE ORDER IS GREEN FIRST, THEN BOTH DECISIONS. A design approved BEFORE the
   * set goes green is held and carried by `settleGreenVerdict` (AMENDMENT 6 Q4), so
   * no merge gate is ever raised and there is nothing to enqueue from — a true
   * behaviour, and a different scenario from the one this block is about. Deciding
   * each gate through the DOOR rather than through `approveAndMerge` keeps the host
   * out of it: what is under test is the ejection, not the merge.
   */
  async function designedAndQueued(email: string) {
    const s = await makeScenario(email);
    const item = await card(s, 'A design that ships as code', [11, 12]);
    await designed(s, item);
    await ci(11, 'sha-a');
    await ci(12, 'sha-b');
    const design = await approveDesign(s, item);
    const [merge] = await awaitingGates(item.id);
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: merge!.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );
    await markQueued(11);
    await markQueued(12);
    return { s, item, design };
  }

  it('leaves the DESIGN gate decided and holds the card with no awaiting gate', async () => {
    const { item, design } = await designedAndQueued('mq-design-eject@example.com');

    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-d1');

    // Decision 6's hold is UNCHANGED: the merge question comes back through Queue
    // again and through a push, not as a second ask about commits already approved.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    // And the design decision is exactly as it was. Nobody is asked a second time
    // whether the design is right, because nothing about the design changed.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: design.gate.id } });
    expect(after).toMatchObject({ state: 'approved', supersededCause: null });
    expect(after.decidedAt?.toISOString()).toBe(design.gate.decidedAt?.toISOString());
    expect(
      await adminDb.approvalGate.count({ where: { workItemId: item.id, kind: 'design_result' } }),
    ).toBe(1);
  });

  it('REFUSES a republish and a withdrawal after the ejection — the failure is about the COMMITS', async () => {
    // The shape MOTIR-5661 was written for, driven end to end here rather than in
    // its unit context: the queue ejects, an agent comes back to the card, and
    // re-publishing the asset is a reasonable-looking thing for it to do. It would
    // turn a commits problem into a shipped design nobody approved.
    const { s, item } = await designedAndQueued('mq-design-republish@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-d2');
    expect(await statusOf(item.id)).toBe('implemented');

    const prefix = designPrefix(s.workspace.id, item.id);
    blobs.set(`${prefix}v2.mock.html`, { contentType: 'text/html', size: 2048 });
    blobs.set(`${prefix}v2.design-notes.md`, { contentType: 'text/markdown', size: 512 });
    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: item.id,
          assets: [
            {
              kind: 'mock',
              sourcePath: 'design/work-items/v2.mock.html',
              pathname: `${prefix}v2.mock.html`,
            },
            {
              kind: 'note_file',
              sourcePath: 'design/work-items/design-notes.md',
              pathname: `${prefix}v2.design-notes.md`,
            },
          ],
          commitSha: shaFor('v2'),
        },
        s.ctx,
      ),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });

    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: item.id }, s.ctx),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });

    await expect(
      designEvidenceService.createUploadTokens(
        {
          workItemId: item.id,
          files: [
            {
              kind: 'mock',
              sourcePath: 'design/work-items/v2.mock.html',
              contentType: 'text/html',
            },
          ],
        },
        s.ctx,
      ),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
  });

  it('a PUSH after the ejection re-arms the merge question and leaves the design alone', async () => {
    const { item, design } = await designedAndQueued('mq-design-push@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-d3');

    await ci(11, 'sha-a2');

    // A new head is a new question — exactly ONE fresh merge gate over it.
    const fresh = await awaitingGates(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    // …and the design gate is untouched by a push, as by an ejection.
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: design.gate.id } }),
    ).toMatchObject({ state: 'approved', supersededCause: null });
  });
});
