import type { GithubPullRequest, GithubRepo } from '@/generated/prisma/client';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from './adminDb';
import { organizationIdOf } from './organizationOf';
import { linkProjectRepo } from './projectRepoLink';
import { randomToken } from './random';

// Fixtures for the REPAIR claim (Story MOTIR-5460): a repository in the project's
// set, a pull request DELIVERING a card, and the check rows its CI verdict is
// derived from. Written through `adminDb` because the claim under test READS
// these; how they come to exist (webhooks, `link_pull_request`) has its own suites.

/** A connected repository in the fixture project's repository set. */
export async function connectRepairRepo(fx: WorkItemFixture, name: string): Promise<GithubRepo> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `repo-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
  return repo;
}

export interface DeliveredPrOptions {
  headRef: string;
  /** Check rows at the head commit, as `name → conclusion`. */
  checks?: Record<string, 'success' | 'failure' | 'pending'>;
  state?: 'open' | 'closed';
  merged?: boolean;
  baseRef?: string;
}

let prNumber = 100;

/** A pull request that DELIVERS `workItemId`, with its check rows. */
export async function deliveredPr(
  fx: WorkItemFixture,
  workItemId: string,
  repo: GithubRepo,
  opts: DeliveredPrOptions,
): Promise<GithubPullRequest> {
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: prNumber++,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      headRef: opts.headRef,
      baseRef: opts.baseRef ?? 'main',
      title: 'A change',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId,
      githubPullRequestId: row.id,
      repoId: repo.id,
    },
  });
  const head = 'c'.repeat(40);
  for (const [checkName, conclusion] of Object.entries(opts.checks ?? {})) {
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: row.id, commitSha: head, checkName, conclusion },
    });
  }
  return row;
}

/** Put a card at a status directly — the claim reads the status, not its history. */
export async function setStatus(workItemId: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status } });
}
