import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateLinkCheck } from '@/lib/services/pullRequestLinkCheckService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { LinkCheckSubject } from '@/lib/services/pullRequestLinkCheckService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  OTHER_PROVIDER_REPO_ID,
  PROVIDER_REPO_ID,
  seedControlOrg,
  seedSiblingWorkspaceRepo,
} from '../helpers/siblingWorkspaceRepo';

// MOTIR-4840 (bug MOTIR-4835) — the UNLINKED-PULL-REQUEST CHECK on a repository
// whose link lives in a SIBLING workspace.
//
// ⚠️ THIS FILE PINS BEHAVIOUR THAT ALREADY WORKS. It was written as a failing
// repro and every assertion PASSED against unfixed code, which falsified the
// card's premise. MOTIR-4835 named three services; only two were affected.
//
// WHY THIS ONE SURVIVED, and it is not luck. MOTIR-4669 made a repository
// ORG-owned, so the `project_repository` row now routinely belongs to a SIBLING
// workspace of the one the service binds. What admits it is
// `project_repository_org_read`, whose predicate resolves the organisation's
// workspaces through a subquery over `workspace` — and this block runs under
// `withSystemContext`, so `workspace_system_read` admits EVERY workspace row to
// that subquery while `app_caller_organization_id()` reads the caller's own bound
// workspace to name the organisation. The set comes back whole.
//
// `ciMinutesMeterService` and `ciRunnerProvisioningService` ask the same question
// from `withWorkspaceServiceContext`, which sets no system flag, so the same
// subquery collapsed to one workspace and both returned null (MOTIR-4839). Three
// call sites, one question, two different context shapes, and only the two
// without the flag were broken.
//
// ⚠️ SO THE VALUE HERE IS THE PIN, not a fix. The dependency is INVISIBLE in the
// policy names — nothing about `project_repository_org_read` says it needs a
// system flag, because it does not: it needs its `workspace` subquery to be
// answerable, which the flag happens to guarantee. Anyone narrowing this block's
// context to "just a workspace bind, like the CI services" would reintroduce
// MOTIR-4839 here, silently, since the failure is an EXEMPTION rather than an
// error. These assertions are what would go red.
//
// Real Postgres, real RLS contexts (`motir_app`, non-BYPASSRLS — pinned by
// `tests/app-role-harness.test.ts`).

// `writeCheckRun` is the GitHub HTTP boundary — the only thing mocked, per the
// shipped convention. Everything below it (RLS, the reads, the decision) is real.
vi.mock('@/lib/github/checkRuns', () => ({
  writeCheckRun: vi.fn(async () => ({ outcome: 'written' })),
  readPullRequestHeadSha: vi.fn(async () => 'deadbeef'),
}));

const HEAD_SHA = 'a'.repeat(40);

async function subjectFor(providerRepoId: string, number: number): Promise<LinkCheckSubject> {
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: providerRepoId },
    include: { installation: true },
  });
  return { repoRow, number, headSha: HEAD_SHA };
}

/** Mirror a pull request on a repo, as the webhook would. */
async function seedPullRequest(githubRepoId: string, number: number): Promise<string> {
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: githubRepoId,
      number,
      title: `PR ${number}`,
      state: 'open',
      headRef: 'feature',
      baseRef: 'main',
    },
  });
  return pr.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

describe('the link check on a repository planned from a SIBLING workspace', () => {
  it('does NOT exempt it as `repo_not_planned` — the repository IS planned', async () => {
    const fx = await seedSiblingWorkspaceRepo();
    await seedPullRequest(fx.githubRepoId, 11);

    const outcome = await evaluateLinkCheck(await subjectFor(PROVIDER_REPO_ID, 11));

    // Before the fix this is `{ decision: 'exempt', reason: 'repo_not_planned' }`
    // — the check silently switching itself off for the whole repository.
    expect(outcome).not.toMatchObject({ decision: 'exempt' });
    // Nothing links it, so the check EVALUATES and fails, which is the whole
    // point: a repository that is planned owes its pull requests a card.
    expect(outcome).toMatchObject({ decision: 'unlinked' });
  });

  it('reports `linked` for a delivery owned by that sibling workspace — UNCHANGED by this fix', async () => {
    // ⚠️ The pin for the comment correction this card also makes. `work_item_delivery`
    // has a `app.system_admin` arm and this block runs under `withSystemContext`,
    // so the delivery read was never the broken half — asserting it here is what
    // makes that a statement about behaviour rather than about a migration file.
    const fx = await seedSiblingWorkspaceRepo();
    const prId = await seedPullRequest(fx.githubRepoId, 12);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.linkProjectId, kind: 'task', title: 'Delivered by the sibling PR' },
      { userId: fx.userId, workspaceId: fx.linkWorkspaceId },
    );
    await adminDb.workItemDelivery.create({
      data: {
        workItemId: item.id,
        githubPullRequestId: prId,
        repoId: fx.githubRepoId,
        // The LINKING project's workspace — a sibling of the repository's.
        workspaceId: fx.linkWorkspaceId,
      },
    });

    const outcome = await evaluateLinkCheck(await subjectFor(PROVIDER_REPO_ID, 12));

    expect(outcome).toMatchObject({ decision: 'linked' });
  });

  it('still exempts a repository NO project plans — the exemption is not lost', async () => {
    const fx = await seedSiblingWorkspaceRepo();
    await adminDb.projectRepo.delete({ where: { id: fx.projectRepoId } });
    await seedPullRequest(fx.githubRepoId, 13);

    const outcome = await evaluateLinkCheck(await subjectFor(PROVIDER_REPO_ID, 13));

    expect(outcome).toEqual({ decision: 'exempt', reason: 'repo_not_planned' });
  });

  it('does not widen past the organisation — another org’s repository is judged on its own', async () => {
    await seedSiblingWorkspaceRepo();
    const other = await seedControlOrg();
    await seedPullRequest(other.githubRepoId, 14);

    const outcome = await evaluateLinkCheck(await subjectFor(OTHER_PROVIDER_REPO_ID, 14));

    // Its own link is same-workspace and has always been visible, so it is
    // evaluated (and unlinked) — never exempted, and never attributed elsewhere.
    expect(outcome).toMatchObject({ decision: 'unlinked' });
  });
});
