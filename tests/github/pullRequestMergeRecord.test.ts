import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { toPullRequestMergeRecordDto } from '@/lib/mappers/githubMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PULL REQUEST'S MERGE RECORD (Story MOTIR-4882 · MOTIR-5520), against a REAL
// Postgres. Two columns on `github_pull_request` — what AUTHORISED a merge Motir
// performed and what it PRODUCED — written only by Motir's own merge paths. The gate
// entry point and auto mode write them in later cards; this suite pins the columns,
// the idempotent write and the read.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One pull-request row on a connected repository — the shape a webhook ingests. */
async function pullRequest(number = 7) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5520-${number}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-5520-${number}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  return adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number,
      title: 'merge the seam',
      state: 'open',
      headRef: 'parent/MOTIR-4882-merge-seam',
      baseRef: 'main',
      provider: 'github',
    },
  });
}

const record = (
  mergeAuthority: 'gate' | 'auto_mode',
  mergeOutcomeRef: string,
): { mergeAuthority: 'gate' | 'auto_mode'; mergeOutcomeRef: string } => ({
  mergeAuthority,
  mergeOutcomeRef,
});

describe('recordMotirMerge — the merge record on the pull request (MOTIR-5520)', () => {
  it('a row nobody merged through Motir reads NULL on both columns', async () => {
    const pr = await pullRequest();
    const row = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
    expect(row.mergeAuthority).toBeNull();
    expect(row.mergeOutcomeRef).toBeNull();
    expect(toPullRequestMergeRecordDto(row)).toEqual({
      mergeAuthority: null,
      mergeOutcomeRef: null,
    });
  });

  it('writes the authority and the outcome it produced', async () => {
    const pr = await pullRequest();

    const count = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('gate', 'a1b2c3d4e5f6'), tx),
    );
    expect(count).toBe(1);

    const row = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
    expect(row.mergeAuthority).toBe('gate');
    expect(row.mergeOutcomeRef).toBe('a1b2c3d4e5f6');
    // The webhook owns `merged` — recording Motir's merge does not claim it landed.
    expect(row.merged).toBe(false);
  });

  it('re-recording the SAME values changes nothing — not even updatedAt', async () => {
    const pr = await pullRequest();
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('auto_mode', 'queue:QE_1'), tx),
    );
    const before = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });

    const count = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('auto_mode', 'queue:QE_1'), tx),
    );

    const after = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
    expect(count).toBe(0);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.mergeOutcomeRef).toBe('queue:QE_1');
  });

  it('a DIFFERENT record overwrites, and says so by its count', async () => {
    const pr = await pullRequest();
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('gate', 'queue:QE_1'), tx),
    );

    // Same authority, different outcome — and different authority, same outcome.
    const outcomeMoved = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('gate', 'f00dfeed'), tx),
    );
    const authorityMoved = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('auto_mode', 'f00dfeed'), tx),
    );

    expect(outcomeMoved).toBe(1);
    expect(authorityMoved).toBe(1);
    const row = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
    expect({ mergeAuthority: row.mergeAuthority, mergeOutcomeRef: row.mergeOutcomeRef }).toEqual({
      mergeAuthority: 'auto_mode',
      mergeOutcomeRef: 'f00dfeed',
    });
  });

  it('a vanished row is a count of 0, never a throw', async () => {
    const count = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge('no-such-row', record('gate', 'abc'), tx),
    );
    expect(count).toBe(0);
  });

  it('the repository read and its mapper return both fields', async () => {
    const pr = await pullRequest();
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(pr.id, record('gate', 'queue:QE_9'), tx),
    );

    const read = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestRepository.findByIdWithInstallation(pr.id, tx),
    );
    expect(read).not.toBeNull();
    expect(toPullRequestMergeRecordDto(read!)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'queue:QE_9',
    });
  });
});

describe('approval_gate.outcome_ref keeps its ONE writer (MOTIR-5520)', () => {
  it('`git grep outcomeRef -- lib` names exactly the shipped writer, reader, mapper and types', () => {
    // A merge's outcome lives on the pull request precisely so this column keeps
    // meaning "the status key the decision applied" — the item page paints it as a
    // status. So the set of lines under `lib/` that mention it is pinned, and any new
    // WRITER shows up here as a line nobody expected.
    const out = execFileSync('git', ['grep', '-n', 'outcomeRef', '--', 'lib'], {
      encoding: 'utf8',
    });
    const assignments = out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^([^:]+):\d+:\s*/, '$1: '))
      .filter(
        (line) => /outcomeRef\s*:\s*[a-zA-Z]/.test(line) && !/:\s*string\s*\|\s*null/.test(line),
      );

    expect(assignments.sort()).toEqual(
      [
        'lib/mappers/approvalGateMappers.ts: outcomeRef: row.outcomeRef,',
        // Still ONE writer. Its expression changed for ONE kind, by decision (Story
        // MOTIR-4914 · MOTIR-5893; `approval-gates.md` §1's MOTIR-5887 amendment, point
        // 7): a CHOICE records the OPTION it picked, because Workflow A always writes
        // `done` and the status is implied by the kind. The item page therefore no longer
        // paints `outcomeRef` as a status — it reads the decision's `statusWritten`
        // (`DecidedGateStatusBridge`, MOTIR-5896). Every other kind is unchanged.
        'lib/services/approvalGatesService.ts: outcomeRef: effect.chosenOption ? effect.chosenOption.optionId : effect.statusWritten,',
      ].sort(),
    );
  });
});
