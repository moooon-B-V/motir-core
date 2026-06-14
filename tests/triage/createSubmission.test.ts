import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { triageService } from '@/lib/services/triageService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  InvalidTriageSubmissionKindError,
  InvalidTriageSubmissionTitleError,
  MAX_TRIAGE_TITLE_LENGTH,
} from '@/lib/triage/errors';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Triage submission intake (Subtask 6.11.4) — the in-app member submit + the
// SHARED triage-create authority Story 6.12 reuses. Real Postgres (the standing
// rule). The contract: a submission IS a `work_item` (kind `bug`/`task`) born
// in the `triage` state via `workItemsService.createWorkItem`, so it is hidden
// from every normal read until promoted (6.11.5) and carries a real
// `submittedByUserId`. 6.11.8 ships the comprehensive read-exclusion + action
// matrix; THIS file locks the create path's own contract.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('triageService.createSubmission — the in-app member intake', () => {
  it('creates a triage work_item attributed to the session member, parentless, and INVISIBLE to the tree', async () => {
    const fx = await makeWorkItemFixture();

    const result = await triageService.createSubmission(
      {
        projectKey: fx.projectIdentifier,
        kind: 'bug',
        title: '  Login button does nothing  ',
        descriptionMd: 'Steps: click login.',
      },
      fx.ctx,
    );

    // The result DTO is the thin confirmation.
    expect(result.kind).toBe('bug');
    expect(result.title).toBe('Login button does nothing'); // trimmed
    expect(result.identifier).toMatch(/^PROD-\d+$/);

    // The row is a triage submission: marker set, no parent, reporter +
    // submitter both the member, in the right project.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.triagedAt).not.toBeNull();
    expect(row.parentId).toBeNull();
    expect(row.reporterId).toBe(fx.ownerId);
    expect(row.submittedByUserId).toBe(fx.ownerId);
    expect(row.projectId).toBe(fx.projectId);

    // Read-exclusion (6.11.3): absent from the tree…
    const forest = await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId);
    expect(forest.map((r) => r.id)).not.toContain(result.id);

    // …but present in the triage queue (the ONE inclusion read).
    const page = await triageService.getTriageQueue(fx.projectId, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toContain(result.id);
  });

  it('creates a feature request as kind `task`', async () => {
    const fx = await makeWorkItemFixture();
    const result = await triageService.createSubmission(
      { projectKey: fx.projectIdentifier, kind: 'task', title: 'Add dark mode' },
      fx.ctx,
    );
    expect(result.kind).toBe('task');
    const row = await db.workItem.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.triagedAt).not.toBeNull();
    expect(row.kind).toBe('task');
  });

  it('honours an explicit submittedByUserId distinct from the reporter (the Story 6.12 seam)', async () => {
    // The 6.12 shape: the actor (ctx) is the project intake MEMBER (the reporter),
    // while `submittedByUserId` records the real (here, a second member) submitter.
    const fx = await makeWorkItemFixture();
    const submitter = await createTestUser({ name: 'Submitter' });
    await workspacesService.addMember({ userId: submitter.id, workspaceId: fx.workspaceId });

    const result = await triageService.createSubmission(
      {
        projectKey: fx.projectIdentifier,
        kind: 'bug',
        title: 'Reported on behalf of someone',
        submittedByUserId: submitter.id,
      },
      fx.ctx,
    );

    const row = await db.workItem.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.reporterId).toBe(fx.ownerId); // reporter = the actor
    expect(row.submittedByUserId).toBe(submitter.id); // submitter = the supplied id
  });
});

describe('triageService.createSubmission — guards', () => {
  it('rejects a signed-in NON-member with a no-leak 404 (creates nothing)', async () => {
    // A signed-in non-member of the workspace can't browse the project, so the
    // browse gate fires first and the project reads as not-found (no existence
    // leak) — the labelsService [key] convention. `createWorkItem`'s
    // `ReporterNotInWorkspaceError` is the deeper backstop, but the browse gate
    // is the one a non-member actually hits. Either way: no work item is created.
    const fx = await makeWorkItemFixture();
    const outsider = await createTestUser({ name: 'Outsider' });

    await expect(
      triageService.createSubmission(
        { projectKey: fx.projectIdentifier, kind: 'bug', title: 'Sneaky' },
        { userId: outsider.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // No work item was created.
    const count = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(0);
  });

  it('rejects a non-bug/task kind with a typed 422 error', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      triageService.createSubmission(
        // `epic` is not a request-grammar kind.
        { projectKey: fx.projectIdentifier, kind: 'epic' as 'bug', title: 'Nope' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidTriageSubmissionKindError);
  });

  it('rejects a blank title', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      triageService.createSubmission(
        { projectKey: fx.projectIdentifier, kind: 'bug', title: '   ' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidTriageSubmissionTitleError);
  });

  it('rejects an over-long title', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      triageService.createSubmission(
        {
          projectKey: fx.projectIdentifier,
          kind: 'bug',
          title: 'x'.repeat(MAX_TRIAGE_TITLE_LENGTH + 1),
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidTriageSubmissionTitleError);
  });

  it('reads an unknown project key as 404 (ProjectNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      triageService.createSubmission(
        { projectKey: 'NOSUCH', kind: 'bug', title: 'Anywhere?' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
