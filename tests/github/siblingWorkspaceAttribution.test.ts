import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerProvisioningService } from '@/lib/services/ciRunnerProvisioningService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { NormalizedWorkflowJobEvent, NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  INSTALLATION_ID,
  MOTIR_ORG,
  OTHER_INSTALLATION_ID,
  OTHER_PROVIDER_REPO_ID,
  OTHER_REPO_NAME,
  PROVIDER_REPO_ID,
  REPO_NAME,
  STARTER_BILLABLE_MINUTES,
  seedControlOrg,
  seedSiblingWorkspaceRepo,
  stubGithub,
} from '../helpers/siblingWorkspaceRepo';

// MOTIR-4839 (bug MOTIR-4835) — CI ATTRIBUTION for a repository whose link lives
// in a SIBLING workspace.
//
// MOTIR-4669 made a repository ORG-owned: connected once, usable by a project in
// any workspace of the organisation. So `project_repository.workspace_id` — the
// LINKING project's — is now routinely different from `github_repo.workspace_id`.
// Both CI attribution reads still open `withWorkspaceServiceContext(repo
// .workspaceId)`, which binds `app.workspace_id` and nothing else, and neither
// arm on `project_repository` admits a sibling workspace's row from there:
// `project_repository_active_workspace` wants the row's own workspace, and
// `project_repository_org_read` resolves the organisation's workspaces through
// `workspace`, which is RLS-forced.
//
// ⚠️ RLS DENIES BY RETURNING FEWER ROWS, NEVER BY RAISING, so each service meets
// its own already-reasoned "no rows" branch: the meter charges NOBODY (§5.4's
// unattributed bucket) and provisioning REFUSES the job. Nothing reads as broken.
//
// ⚠️ AND THE EXISTING SUITES CANNOT FAIL ON IT. Every fixture in them puts the
// repository and its link in ONE workspace, where the defective code and the
// fixed code are indistinguishable — which is why this shipped green. That is
// what `tests/helpers/siblingWorkspaceRepo.ts` exists for, and why the control
// organisation below is part of the fixture rather than an extra.
//
// Real Postgres, real RLS contexts (`motir_app`, non-BYPASSRLS), the GitHub HTTP
// boundary stubbed — the shipped convention for these suites.

const RUN_COMPLETED_AT = new Date('2026-07-30T12:00:00.000Z');
const QUEUED_AT = new Date('2026-07-30T11:00:00.000Z');

function runEvent(overrides: Partial<NormalizedWorkflowRunEvent> = {}): NormalizedWorkflowRunEvent {
  return {
    providerRepoId: PROVIDER_REPO_ID,
    runId: '7901',
    attempt: 1,
    repoOwner: MOTIR_ORG,
    repoName: REPO_NAME,
    workflowName: 'CI',
    completedAt: RUN_COMPLETED_AT,
    ...overrides,
  };
}

function jobEvent(overrides: Partial<NormalizedWorkflowJobEvent> = {}): NormalizedWorkflowJobEvent {
  return {
    providerRepoId: PROVIDER_REPO_ID,
    runId: '7901',
    runAttempt: 1,
    jobId: '44901',
    jobName: 'build',
    workflowName: 'CI',
    repoOwner: MOTIR_ORG,
    repoName: REPO_NAME,
    requestedLabels: [MOTIR_RUNNER_LABEL],
    queuedAt: QUEUED_AT,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  // The metering gate (§1) and the owner-login qualifier (§5.1) — the same two
  // the shipped meter suite sets. Neither is what this file is about; without
  // them `meterWorkflowRun` returns `disabled` before it reaches attribution.
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ciMinutesMeterService — a link in a sibling workspace of the same organisation', () => {
  it('ATTRIBUTES the run to the linking project, rather than metering it to nobody', async () => {
    const fx = await seedSiblingWorkspaceRepo();
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    // The attribution, not a row count: what this card is about is WHO IS
    // CHARGED, and `unattributed` is a legitimate-looking outcome that a count
    // assertion would not distinguish from a wrong tenant.
    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: fx.organizationId,
      // The LINKING project's workspace — the repository is connected in the other.
      workspaceId: fx.linkWorkspaceId,
      projectId: fx.linkProjectId,
      billableMinutes: STARTER_BILLABLE_MINUTES,
    });
    expect(fx.linkWorkspaceId).not.toBe(fx.repoWorkspaceId);

    const row = await adminDb.ciWorkflowRunUsage.findFirstOrThrow({ where: { runId: '7901' } });
    expect(row).toMatchObject({
      workspaceId: fx.linkWorkspaceId,
      organizationId: fx.organizationId,
      projectId: fx.linkProjectId,
      githubRepoId: fx.githubRepoId,
    });
  });

  it('leaves the SAME-workspace case exactly as it was', async () => {
    // The fix widens the read to the organisation; it must not change the shape
    // that already worked. Re-point the link at the repository's own workspace and
    // its own project, which is the ordinary pre-MOTIR-4669 arrangement.
    const fx = await seedSiblingWorkspaceRepo();
    const sameWsProject = await projectsService.createProject({
      workspaceId: fx.repoWorkspaceId,
      actorUserId: fx.userId,
      name: 'Same',
      identifier: 'SAMEWS',
    });
    await adminDb.projectRepo.update({
      where: { id: fx.projectRepoId },
      data: { workspaceId: fx.repoWorkspaceId, projectId: sameWsProject.id },
    });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: fx.organizationId,
      workspaceId: fx.repoWorkspaceId,
      projectId: sameWsProject.id,
    });
  });

  it('does NOT widen past the organisation — another org’s repository is untouched', async () => {
    // ⚠️ THE DISCRIMINATOR. A fixture in which the caller can see everything
    // cannot tell a scoped read from an unscoped one. This org's rows exist, are
    // linked, and must attribute to THEMSELVES — never to the org under test.
    const fx = await seedSiblingWorkspaceRepo();
    const other = await seedControlOrg();
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({
        providerRepoId: OTHER_PROVIDER_REPO_ID,
        runId: '7902',
        repoName: OTHER_REPO_NAME,
      }),
      OTHER_INSTALLATION_ID,
    );

    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: other.organizationId,
      workspaceId: other.workspaceId,
      projectId: other.projectId,
    });
    expect(other.organizationId).not.toBe(fx.organizationId);
  });
});

describe('ciRunnerProvisioningService — the same shape, one service over', () => {
  it('PROVISIONS the job rather than refusing it as unattributed', async () => {
    const fx = await seedSiblingWorkspaceRepo();

    const outcome = await ciRunnerProvisioningService.recordQueuedJob(jobEvent(), INSTALLATION_ID);

    expect(outcome).toMatchObject({ outcome: 'recorded' });

    const intents = await adminDb.ciRunnerProvisioningIntent.findMany();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      organizationId: fx.organizationId,
      workspaceId: fx.linkWorkspaceId,
      projectId: fx.linkProjectId,
      githubRepoId: fx.githubRepoId,
      status: 'pending',
    });
  });

  it('answers the SAME question the meter does — the two must not diverge', async () => {
    // `ciRunnerProvisioningService.ts` says so in its own words: "the SAME
    // disposition as the meter's (MOTIR-4648) — the two sites ask one question and
    // must not answer it differently." This asserts the pair, on one fixture,
    // because a change that lands in one and not the other fails silently: both
    // sides of the divergence are legitimate-looking null returns.
    const fx = await seedSiblingWorkspaceRepo();
    stubGithub();

    const metered = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);
    const provisioned = await ciRunnerProvisioningService.recordQueuedJob(
      jobEvent(),
      INSTALLATION_ID,
    );

    expect(metered).toMatchObject({ outcome: 'metered', organizationId: fx.organizationId });
    expect(provisioned).toMatchObject({ outcome: 'recorded' });
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow();
    expect(intent.workspaceId).toBe((metered as { workspaceId: string }).workspaceId);
    expect(intent.organizationId).toBe((metered as { organizationId: string }).organizationId);
    expect(intent.projectId).toBe((metered as { projectId: string | null }).projectId);
  });
});
