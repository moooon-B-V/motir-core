import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { triageService } from '@/lib/services/triageService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  InvalidTriageSubmissionKindError,
  InvalidTriageSubmissionTitleError,
} from '@/lib/triage/errors';
import {
  MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
} from '@/lib/publicProjects/errors';
import { truncateAuthTables } from '../helpers/db';

// Service-layer tests for Story 6.12 · Subtask 6.12.5 — the public submit-to-
// triage path + the duplicate-detection pre-check. Real Postgres, no DB mocks;
// the truncate helper CASCADE-resets between tests. The in-memory submission
// throttle is module-level (NOT reset by truncate), but every test mints fresh
// random-id users, so the per-account counters never collide across tests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A fixture whose project is set PUBLIC (the make-public toggle is 6.12.8, not
 *  yet wired through the service, so the test sets the column directly — the
 *  same shortcut `project-access-service.test.ts` uses). */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

describe('publicProjectsService.submitPublicRequest', () => {
  it('attributes a cross-org submission: owner is reporter, submitter rides submittedByUserId, born in triage', async () => {
    const fx = await makePublicProjectFixture();
    const crossOrg = await createTestUser(); // a fresh account, NOT a member of fx.workspace

    const result = await publicProjectsService.submitPublicRequest(fx.projectId, crossOrg.id, {
      kind: 'task',
      title: 'Dark mode please',
      descriptionMd: 'A dark theme would be lovely.',
    });

    expect(result.kind).toBe('task');
    expect(result.title).toBe('Dark mode please');
    expect(result.identifier).toMatch(/^PROD-\d+$/);

    const row = await db.workItem.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    // Reporter = the workspace OWNER (the member intake reporter); the real
    // cross-org submitter is on submittedByUserId (the 6.11.4 seam).
    expect(row!.reporterId).toBe(fx.ownerId);
    expect(row!.submittedByUserId).toBe(crossOrg.id);
    expect(row!.projectId).toBe(fx.projectId);
    expect(row!.kind).toBe('task');
    // Born in triage → excluded from every normal read until promoted.
    expect(row!.triagedAt).not.toBeNull();
    expect(row!.parentId).toBeNull();

    // It shows in the project's triage queue (the only read that returns it).
    const queue = await triageService.getTriageQueueByKey(fx.projectIdentifier, {}, fx.ctx);
    expect(queue.items.map((i) => i.id)).toContain(result.id);
  });

  it('gates on canSubmitToTriage — a NON-public project reads as 404 (no existence leak)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private Co' }); // default access (not public)
    const crossOrg = await createTestUser();

    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, crossOrg.id, {
        kind: 'bug',
        title: 'Should be rejected',
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // ...and nothing was created.
    const count = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(0);
  });

  it('rejects a non-bug/task kind (422) and a blank title (422)', async () => {
    const fx = await makePublicProjectFixture('Kind Co');
    const crossOrg = await createTestUser();

    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, crossOrg.id, {
        // 'epic' is not a request-grammar kind.
        kind: 'epic' as never,
        title: 'Not a request kind',
      }),
    ).rejects.toBeInstanceOf(InvalidTriageSubmissionKindError);

    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, crossOrg.id, {
        kind: 'task',
        title: '   ',
      }),
    ).rejects.toBeInstanceOf(InvalidTriageSubmissionTitleError);
  });

  it('rejects an over-long body (the abuse-guard size cap, 422)', async () => {
    const fx = await makePublicProjectFixture('Size Co');
    const crossOrg = await createTestUser();

    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, crossOrg.id, {
        kind: 'task',
        title: 'Huge body',
        descriptionMd: 'a'.repeat(MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(PublicRequestDescriptionTooLongError);
  });

  it('throttles a single account after the per-account submission limit (429)', async () => {
    const fx = await makePublicProjectFixture('Throttle Co');
    const spammer = await createTestUser(); // a dedicated account so the counter is isolated

    // The first SUBMISSION_RATE_LIMIT (5) succeed.
    for (let i = 0; i < 5; i++) {
      await publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
        kind: 'task',
        title: `Request ${i}`,
      });
    }
    // The next one trips the throttle.
    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
        kind: 'task',
        title: 'One too many',
      }),
    ).rejects.toBeInstanceOf(PublicSubmissionRateLimitedError);
  });
});

describe('publicProjectsService.findDuplicateRequests', () => {
  it('surfaces an existing matching (in-triage) public request for "upvote this instead"', async () => {
    const fx = await makePublicProjectFixture('Dedupe Co');
    const submitter = await createTestUser();
    const seeker = await createTestUser();

    const existing = await publicProjectsService.submitPublicRequest(fx.projectId, submitter.id, {
      kind: 'task',
      title: 'Dark mode toggle in settings',
    });

    // A token-subset draft matches (Jira-style tokenisation): "dark mode".
    const match = await publicProjectsService.findDuplicateRequests(
      fx.projectId,
      seeker.id,
      'dark mode',
    );
    expect(match.candidates).toHaveLength(1);
    expect(match.candidates[0]).toMatchObject({
      id: existing.id,
      kind: 'task',
      identifier: existing.identifier,
      title: 'Dark mode toggle in settings',
      voteCount: 0,
    });
    expect(typeof match.candidates[0]!.status).toBe('string');

    // An unrelated draft matches nothing.
    const noMatch = await publicProjectsService.findDuplicateRequests(
      fx.projectId,
      seeker.id,
      'completely unrelated thing',
    );
    expect(noMatch.candidates).toHaveLength(0);

    // A blank draft short-circuits to no candidates (no query issued).
    const blank = await publicProjectsService.findDuplicateRequests(fx.projectId, seeker.id, '   ');
    expect(blank.candidates).toHaveLength(0);
  });

  it('is scoped to the project — a matching request in another public project is NOT returned', async () => {
    const fxA = await makePublicProjectFixture('Project A');
    const fxB = await makePublicProjectFixture('Project B');
    const submitter = await createTestUser();
    const seeker = await createTestUser();

    await publicProjectsService.submitPublicRequest(fxB.projectId, submitter.id, {
      kind: 'task',
      title: 'Shared keyword widget',
    });

    const inA = await publicProjectsService.findDuplicateRequests(
      fxA.projectId,
      seeker.id,
      'shared keyword',
    );
    expect(inA.candidates).toHaveLength(0);
  });

  it('gates on canSubmitToTriage — dedupe on a NON-public project reads as 404', async () => {
    const fx = await makeWorkItemFixture({ name: 'Closed Co' });
    const seeker = await createTestUser();

    await expect(
      publicProjectsService.findDuplicateRequests(fx.projectId, seeker.id, 'anything'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  // The service short-circuits a blank draft BEFORE it reaches the repository,
  // so exercise the repo's own token-less guard directly (the gated
  // workItemRepository file must keep its branch coverage).
  it('repository.findPublicRequestMatches returns [] for a token-less query', async () => {
    const fx = await makeWorkItemFixture({ name: 'Repo Guard Co' });
    expect(await workItemRepository.findPublicRequestMatches(fx.projectId, '   ', 5)).toEqual([]);
  });
});
