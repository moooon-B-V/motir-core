import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resetDatabase } from '@/tests/e2e/_helpers/db-reset';
import { makeWorkItemFixture } from '@/tests/fixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { adminDb } from './helpers/adminDb';

// DB-reset CASCADE audit (Subtask 1.4.8). The Playwright suite's
// `resetDatabase()` truncates only the auth-root tables (user / workspace /
// session / account / verification). work_item, work_item_link, and
// work_item_revision all FK to workspace (and user), so they must cascade-
// truncate with those roots — otherwise a work-item row from one spec could
// leak into the next. This test PROVES the cascade empirically, so the next
// reader doesn't have to wonder whether resetDatabase() needs a work-item
// sibling. Verdict: it does NOT — the FK CASCADE is sufficient; resetDatabase()
// is unchanged.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('resetDatabase() clears work-item tables via FK CASCADE', () => {
  it('removes work_item / work_item_link / work_item_revision rows', async () => {
    const fx = await makeWorkItemFixture();
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const y = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Y' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // Sanity: rows exist before the reset. Counted through the ADMIN client —
    // the claim is about what is STORED, and a tenant-scoped count taken with no
    // workspace bound would read zero for a reason that has nothing to do with
    // the cascade under test.
    const before = {
      items: await adminDb.workItem.count(),
      links: await adminDb.workItemLink.count(),
      revisions: await adminDb.workItemRevision.count(),
    };
    expect(before.items).toBeGreaterThan(0);
    expect(before.links).toBeGreaterThan(0);
    expect(before.revisions).toBeGreaterThan(0);

    await resetDatabase();

    // Cascade verdict: every work-item table is empty after truncating auth roots.
    const after = {
      items: await adminDb.workItem.count(),
      links: await adminDb.workItemLink.count(),
      revisions: await adminDb.workItemRevision.count(),
    };
    expect(after.items).toBe(0);
    expect(after.links).toBe(0);
    expect(after.revisions).toBe(0);
  });
});

// ── THE PULL-REQUEST ARM (Bug MOTIR-3248) ───────────────────────────────────
//
// Same question, asked of the table that caused an actual cross-spec failure.
// `github_pull_request` is @@unique([repoId, number]) and `repoId` is the
// MIRRORED repo row, which two specs SHARE: `seedGithubInstallation` seeds one
// fixed provider installation and `github_installation.installation_id` is
// @unique, so a second spec's seed upserts the same installation and the same
// repo row — inheriting the first spec's pull requests. A per-spec tenant does
// not isolate them, which is why three acceptance specs colliding on 6101/6102
// went red the day MOTIR-3001 added a file and moved the shard partition.
//
// The remedy those specs took is `resetDatabase()`, and that remedy rests
// entirely on a cascade nobody had measured: github_pull_request → github_repo →
// github_installation → workspace, three hops from the truncated root. Reading
// three `onDelete: Cascade` annotations off the schema is not the same as
// watching the row go, so this proves it — the reason the specs may rely on it
// is a MEASUREMENT, in the file whose whole purpose is to hold measurements of
// exactly this kind.
describe('resetDatabase() clears github pull-request rows via FK CASCADE (MOTIR-3248)', () => {
  it('removes github_installation / github_repo / github_pull_request rows', async () => {
    const fx = await makeWorkItemFixture();
    const installation = await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'cascade-audit-installation',
        accountLogin: 'moooon-cascade-audit',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: 'cascade-audit-repo',
          owner: 'moooon-cascade-audit',
          name: 'demo',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    // The row a colliding spec would inherit. Written through the ADMIN client
    // for the same reason the counts are read through it: the claim is about
    // what is STORED.
    const repo = await adminDb.githubRepo.findFirstOrThrow({
      where: { installationId: installation.id },
    });
    await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 6101,
        state: 'open',
        merged: false,
        headRef: 'subtask/MOTIR-3248-cascade-audit',
      },
    });

    const before = {
      installations: await adminDb.githubInstallation.count(),
      repos: await adminDb.githubRepo.count(),
      pullRequests: await adminDb.githubPullRequest.count(),
    };
    expect(before.installations).toBeGreaterThan(0);
    expect(before.repos).toBeGreaterThan(0);
    expect(before.pullRequests).toBeGreaterThan(0);

    await resetDatabase();

    // Cascade verdict: the pull-request row is gone, so a spec that resets does
    // NOT inherit its predecessor's `(repoId, number)` pairs.
    const after = {
      installations: await adminDb.githubInstallation.count(),
      repos: await adminDb.githubRepo.count(),
      pullRequests: await adminDb.githubPullRequest.count(),
    };
    expect(after.installations).toBe(0);
    expect(after.repos).toBe(0);
    expect(after.pullRequests).toBe(0);
  });
});
