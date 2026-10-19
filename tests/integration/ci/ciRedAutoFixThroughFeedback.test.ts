import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
} from '@/lib/services/changeRequestCiFeedback';
import type { NormalizedStatusEvent } from '@/lib/git/types';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';

// MOTIR-9054 — A TERMINAL RED DELIVERY HANDS THE FAILURE BACK TO THE CARD'S OWN AGENT,
// behind the project's Agent auto-fix switch. Driven through the real consumer
// (`applyCiStatusFeedback`) and real Postgres; only the agent start is spied, because it
// would otherwise reach a machine. What is pinned: one start per head, none with the
// switch off, and the delivery's own outcome identical either way.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-auto-fix';
const REPO_PROVIDER_ID = '9054';
const SUITE_ID = '87626130152';
const HEAD_SHA = '4eae3f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function makeScenario(email: string) {
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
  const installation = (await adminDb.githubInstallation.findFirst({
    where: { installationId: INSTALLATION_ID },
  }))!;
  const repo = (await adminDb.githubRepo.findFirst({
    where: { installationId: installation.id, repoId: REPO_PROVIDER_ID },
  }))!;
  return { user, workspace, project, ctx, installation, repo };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** A card at `implemented` with its own linked pull request — the shape the
 *  fixture had when the verdict was written. */
async function cardWithPr(s: Scenario, title: string, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-work`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
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
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

function event(name: string, conclusion: 'failure' | 'success'): NormalizedStatusEvent {
  return {
    providerRepoId: REPO_PROVIDER_ID,
    commitSha: HEAD_SHA,
    conclusion,
    context: name,
    prNumbers: [],
    headBranch: null,
    suiteId: SUITE_ID,
  };
}

function deliverer(s: Scenario, prNumber: number) {
  const resolveContext = async (): Promise<CiFeedbackContextResolution> => ({
    kind: 'resolved',
    installation: s.installation,
    repo: s.repo,
    buildChecksUrl: (n: number) => `https://github.com/moooon/acme/pull/${n}/checks`,
  });
  return (name: string, conclusion: 'failure' | 'success') =>
    applyCiStatusFeedback({ ...event(name, conclusion), prNumbers: [prNumber] }, resolveContext);
}

/** A finished run in the owner's running agent over the card — what "the card's own agent" reads. */
async function priorRunInAgent(s: Scenario, cardId: string, cardKey: string) {
  const agent = await adminDb.agentInstance.create({
    data: {
      workspaceId: s.workspace.id,
      organizationId: (await adminDb.workspace.findUniqueOrThrow({ where: { id: s.workspace.id } }))
        .organizationId,
      projectId: s.project.id,
      ownerId: s.user.id,
      name: 'my-agent',
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      region: 'iad',
      state: 'running',
    },
  });
  await adminDb.dispatchRun.create({
    data: {
      workspaceId: s.workspace.id,
      projectId: s.project.id,
      command: 'run',
      origin: 'instance',
      status: 'completed',
      endedAt: new Date(),
      agentInstanceId: agent.id,
      createdById: s.user.id,
      cards: {
        create: [
          {
            workspaceId: s.workspace.id,
            workItemId: cardId,
            workItemKey: cardKey,
            position: 0,
            disposition: 'implemented',
            startedAt: new Date(),
          },
        ],
      },
    },
  });
  return agent;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a terminal red delivery and the Agent auto-fix switch', () => {
  it('starts exactly one fix in the card’s agent, and a second red at the same head starts none', async () => {
    const s = await makeScenario('auto-fix-on@example.com');
    const card = await cardWithPr(s, 'Red card', 9054);
    const agent = await priorRunInAgent(s, card.id, card.identifier);
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { agentAutoFixEnabled: true },
    });
    const calls: Array<{ key: string; idem: string | undefined }> = [];
    vi.spyOn(agentInstanceRunService, 'start').mockImplementation(async (input) => {
      const created = calls.every((c) => c.idem !== input.idempotencyKey);
      calls.push({ key: input.workItemKey, idem: input.idempotencyKey });
      expect(input.command).toBe('fix');
      expect(input.agentInstanceId).toBe(agent.id);
      return { dispatchRunId: 'run-1', created, woke: false };
    });
    const deliver = deliverer(s, 9054);

    const first = await deliver('Vitest', 'failure');
    expect(first.outcome).toBe('failed');
    expect(first.ciState).toBe('failing');
    const second = await deliver('Prettier', 'failure');
    expect(second.outcome).toBe('failed');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBe(card.identifier);
    expect(calls[1]!.idem).toBe(calls[0]!.idem);
    expect(calls[0]!.idem).toMatch(/^auto-fix:.+:4eae3f0a/);
  });

  it('starts nothing with the switch off, and the delivery’s outcome is the same', async () => {
    const s = await makeScenario('auto-fix-off@example.com');
    const card = await cardWithPr(s, 'Red card', 9055);
    await priorRunInAgent(s, card.id, card.identifier);
    const start = vi.spyOn(agentInstanceRunService, 'start');
    const result = await deliverer(s, 9055)('Vitest', 'failure');
    expect(result.outcome).toBe('failed');
    expect(result.ciState).toBe('failing');
    expect(start).not.toHaveBeenCalled();
    expect(await adminDb.dispatchRun.count({ where: { command: 'fix' } })).toBe(0);
  });

  it('still records the verdict when the start throws', async () => {
    const s = await makeScenario('auto-fix-throws@example.com');
    const card = await cardWithPr(s, 'Red card', 9056);
    await priorRunInAgent(s, card.id, card.identifier);
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { agentAutoFixEnabled: true },
    });
    vi.spyOn(agentInstanceRunService, 'start').mockRejectedValue(new Error('no credits'));
    const result = await deliverer(s, 9056)('Vitest', 'failure');
    expect(result.outcome).toBe('failed');
    expect(result.ciState).toBe('failing');
  });
});
