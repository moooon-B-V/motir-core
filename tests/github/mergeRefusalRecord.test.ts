import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult, MergeRefusalCode } from '@/lib/git/types';
import { classOfMergeRefusal } from '@/lib/mergeQueue/queueExit';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE HOST'S REFUSAL, RECORDED (Story MOTIR-5799 · MOTIR-5833;
// `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, points 2 and 5), on a REAL
// Postgres.
//
// One approval authorizes ONE merge action. Before this card a refusal at the press
// existed only in that request's response: a reload showed a card reading **Approved**
// with nothing anywhere saying the merge had been refused, or why. Now the code, the
// head and the time are a row on the pull request, and the card is settled by the
// refusal's CLASS through the same entry point a queue exit uses.
//
// The seam's `mergeChangeRequest` is the one thing stubbed — it is what leaves the
// process.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-refusal';
const REPO_PROVIDER_ID = '995';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

async function scenario(email: string, mode: 'manual' | 'auto' = 'manual') {
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
  return { user, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

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

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const awaitingGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });
const refusalsOf = async (number: number) =>
  adminDb.githubPullRequestMergeRefusal.findMany({
    where: { pullRequestId: (await prRow(number)).id },
    orderBy: { refusedAt: 'asc' },
  });

const stubHost = (answer: MergeChangeRequestResult) =>
  vi.spyOn(github, 'mergeChangeRequest').mockResolvedValue(answer);

/** A card with ONE green pull request (#41), approved — and the press about to be made. */
async function approvedCard(email: string, mode: 'manual' | 'auto' = 'manual') {
  const s = await scenario(email, mode);
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'One change' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-41`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number: 41,
    headRef,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: 41,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  await ci(41, 'sha-41');
  const [gate] = await awaitingGates(item.id);
  return { s, item, gate: gate ?? null };
}

const press = async (s: Scenario, gateId: string) =>
  pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, source: 'ui' },
    s.ctx,
  );

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the class map answers for the HOST too', () => {
  it.each([
    ['checks_not_green', 'cant_land'],
    ['conflict', 'cant_land'],
    ['branch_protected', 'setting'],
    ['app_permission_missing', 'setting'],
    ['already_merged', 'landed'],
  ] as const)('%s → %s', (code, landingClass) => {
    expect(classOfMergeRefusal(code)).toBe(landingClass);
  });

  it('`subject_changed` is NOT an outcome — nothing was attempted, so nothing was spent', () => {
    expect(classOfMergeRefusal('subject_changed')).toBeNull();
  });

  it('a code this deployment has never seen is RETRYABLE — a person is asked', () => {
    expect(classOfMergeRefusal('some_host_said_this')).toBe('retryable');
  });

  it('is TOTAL over the seam’s union — every member has an answer', () => {
    const every: MergeRefusalCode[] = [
      'checks_not_green',
      'conflict',
      'branch_protected',
      'already_merged',
      'app_permission_missing',
      'subject_changed',
    ];
    for (const code of every) expect(() => classOfMergeRefusal(code)).not.toThrow();
  });
});

describe('a refused press RECORDS the refusal and settles the card by its class', () => {
  it.each([
    ['conflict', 'implemented', 0],
    ['checks_not_green', 'implemented', 0],
    ['branch_protected', 'in_review', 1],
    ['app_permission_missing', 'in_review', 1],
  ] as const)(
    '%s leaves the card at %s with %i awaiting gate(s), and one refusal row',
    async (code, status, gateCount) => {
      const { s, item, gate } = await approvedCard(`refuse-${code}@example.com`);
      stubHost({ outcome: 'refused', refusal: { code } });

      const result = await press(s, gate!.id);

      expect(result.members[0]).toMatchObject({ outcome: 'refused' });
      const rows = await refusalsOf(41);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code,
        headSha: 'sha-41',
        approvalGateId: gate!.id,
        supersededAt: null,
      });
      expect(await statusOf(item.id)).toBe(status);
      expect(await awaitingGates(item.id)).toHaveLength(gateCount);
      // The decided gate is history and is never edited.
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state,
      ).toBe('approved');
    },
  );

  it('`app_permission_missing` keeps the permission the host named, for the surface to say', async () => {
    const { s, gate } = await approvedCard('refuse-permission@example.com');
    stubHost({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing', permission: 'contents: write' },
    });

    await press(s, gate!.id);

    expect((await refusalsOf(41))[0]).toMatchObject({ permission: 'contents: write' });
  });

  it('the SETTING refusal is asked again, and a second refusal records a second row', async () => {
    const { s, item, gate } = await approvedCard('refuse-twice@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);

    const [reasked] = await awaitingGates(item.id);
    expect(reasked).toBeDefined();
    await press(s, reasked!.id);

    expect(await refusalsOf(41)).toHaveLength(2);
    expect(await statusOf(item.id)).toBe('in_review');
    // Still exactly ONE question, over the same commits.
    expect(await awaitingGates(item.id)).toHaveLength(1);
  });

  it('a press that LANDS retires the refusal the pull request carried', async () => {
    const { s, item, gate } = await approvedCard('refuse-then-land@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const [reasked] = await awaitingGates(item.id);

    stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    await press(s, reasked!.id);

    expect((await refusalsOf(41))[0]!.supersededAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('`subject_changed` records NOTHING and moves nothing — the press never happened', async () => {
    const { s, item, gate } = await approvedCard('refuse-stale@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'subject_changed' } });

    const result = await press(s, gate!.id);

    expect(result.members[0]).toMatchObject({ outcome: 'refused' });
    expect(await refusalsOf(41)).toEqual([]);
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a PUSH retires a standing refusal — the head it names is no longer the member’s', async () => {
    const { s, item, gate } = await approvedCard('refuse-then-push@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'conflict' } });
    await press(s, gate!.id);
    expect(await statusOf(item.id)).toBe('implemented');

    // The agent pushed, and the new commits went green: the refusal no longer describes
    // the code, so the card asks about the NEW commits (MOTIR-5604's path).
    await ci(41, 'sha-41b');

    const gates = await awaitingGates(item.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.subjectVersion).toContain('sha-41b');
  });

  it('the member read carries the standing refusal, and drops it once the head moves', async () => {
    const { s, item, gate } = await approvedCard('refuse-read@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);

    const read = async (gateId: string) =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: gateId },
          s.ctx,
        )
      )[0];

    expect(await read(gate!.id)).toMatchObject({
      refusal: { code: 'branch_protected', landingClass: 'setting', permission: null },
    });

    await ci(41, 'sha-41c');
    expect(await read(gate!.id)).toMatchObject({ refusal: null });
  });
});

describe('auto mode records nothing', () => {
  it('an auto project has no approval to spend, so a refused press writes no row', async () => {
    const { s, item } = await approvedCard('refuse-auto@example.com', 'auto');
    // `auto` raises no gate at all, so there is nothing to press — which is the point:
    // the refusal path this card writes is reachable only from a `manual` approval.
    expect(await awaitingGates(item.id)).toEqual([]);
    expect(await refusalsOf(41)).toEqual([]);
    expect(s.ctx.workspaceId).toBeTruthy();
  });
});
