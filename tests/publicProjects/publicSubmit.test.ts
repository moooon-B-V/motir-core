import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../helpers/db';
import { ALIGNED_WINDOW_MS, waitForWindowBoundary } from '../helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';

// Service-layer tests for Story 6.12 · Subtask 6.12.5 — the public submit-to-
// triage path + the duplicate-detection pre-check. Real Postgres, no DB mocks;
// the truncate helper CASCADE-resets between tests. The per-account submission
// throttle counts through the SHARED store since MOTIR-2598, so its state is a
// TABLE and gets truncated between cases like every other row; every test also
// still mints fresh random-id users, so the per-account counters never collide.

/** The budget env pair `publicSubmitBudget()` reads — cleared around every case. */
const SUBMIT_BUDGET_ENVS = [
  'MOTIR_PUBLIC_SUBMIT_RATE_LIMIT',
  'MOTIR_PUBLIC_SUBMIT_RATE_LIMIT_WINDOW_MS',
];

/**
 * The window the SIX-submission case aligns against — its own, larger than the
 * shared `ALIGNED_WINDOW_MS` the two-submission cases use.
 *
 * Sized from measurement, the way `rateLimitWindow.ts` sizes its own: the
 * six-submission section is **276 ms worst-of-5** against a real Postgres
 * (2026-08-10, MOTIR-2598) — each submission is a full triage create, so this is
 * the heaviest counted section in either converted suite. 8 s is a ~29× margin
 * over that worst case: the remaining failure would need a runner 29× slower
 * than measured, not an unlucky phase.
 *
 * The ceiling on this number is `testTimeout` (15 s): aligning costs up to a
 * whole window, so a larger one would trade a rare flake for a routine timeout.
 */
const SIX_SUBMISSION_WINDOW_MS = 8_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // ⚠️ PIN THE STORE DEADLINE (MOTIR-3067). The submission throttle counts through the SHARED
  // Postgres store, whose production deadline is 250 ms for one increment — and
  // `consumeSharedRateLimit` FAILS OPEN when that expires, serving the call this
  // suite expects to be refused. On a CI shard running thousands of tests against
  // one database that is a real outcome, and it presents as a refusal assertion
  // failing on a diff that touched no rate-limiting code. See
  // `tests/helpers/rateLimitStore.ts`.
  pinSharedRateLimitStoreDeadline();
  for (const key of SUBMIT_BUDGET_ENVS) delete process.env[key];
});

afterEach(() => {
  for (const key of SUBMIT_BUDGET_ENVS) delete process.env[key];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A fixture whose project is set PUBLIC (the make-public toggle is 6.12.8, not
 *  yet wired through the service, so the test sets the column directly — the
 *  same shortcut `project-access-service.test.ts` uses). */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
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

    const row = await adminDb.workItem.findUnique({ where: { id: result.id } });
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
    const count = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
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
    // ⚠️ PIN THE WINDOW, THEN ALIGN TO IT. The throttle counts through the shared
    // store, which buckets on an EPOCH-ALIGNED grid, so the window does not open
    // at the first submission: six submissions that straddle a boundary reset the
    // counter mid-case and the sixth is accepted. That flake needs unlucky PHASE
    // rather than a slow runner — invisible locally, green on every rerun
    // (MOTIR-2101 / MOTIR-2224). The shipped window is ten MINUTES, which no test
    // can align against, so the case shrinks it through the same env pair a
    // deployment uses and keeps the shipped limit of 5.
    process.env['MOTIR_PUBLIC_SUBMIT_RATE_LIMIT_WINDOW_MS'] = String(SIX_SUBMISSION_WINDOW_MS);
    const fx = await makePublicProjectFixture('Throttle Co');
    const spammer = await createTestUser(); // a dedicated account so the counter is isolated

    // The first DEFAULT_PUBLIC_SUBMIT_RATE_LIMIT (5) succeed.
    await waitForWindowBoundary(SIX_SUBMISSION_WINDOW_MS);
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

  it('the throttle counts in the SHARED table, and Retry-After names the window’s end', async () => {
    // Two claims in one case because they are the same swap: the tally is a row
    // (so a second Fly machine inherits it — the `limit x instances` defect
    // MOTIR-2598 closes), and the header the route sends is now derived from the
    // fixed window's reset rather than from the oldest attempt's age.
    process.env['MOTIR_PUBLIC_SUBMIT_RATE_LIMIT'] = '1';
    process.env['MOTIR_PUBLIC_SUBMIT_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const fx = await makePublicProjectFixture('Shared Co');
    const spammer = await createTestUser();

    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    await publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
      kind: 'task',
      title: 'The one allowed',
    });

    const refused = await publicProjectsService
      .submitPublicRequest(fx.projectId, spammer.id, { kind: 'task', title: 'Refused' })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PublicSubmissionRateLimitedError);
    // Never below 1 (the route puts it straight into `Retry-After`), and never
    // beyond the window it names.
    const retryAfter = (refused as PublicSubmissionRateLimitedError).retryAfterSeconds;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(ALIGNED_WINDOW_MS / 1000));

    // The counter is a row, not this process's memory: clearing the table restores
    // the budget. Under the module-level Map it replaced, it would not have.
    const keys = await adminDb.$queryRawUnsafe<Array<{ key: string }>>(
      'SELECT key FROM "rate_limit_counter"',
    );
    expect(keys.some((r) => r.key.startsWith('public-submit:'))).toBe(true);
    // ...and the submitting account is hashed into it, never stored in the clear.
    for (const row of keys) expect(row.key).not.toContain(spammer.id);

    await truncateRateLimitCounters();
    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
        kind: 'task',
        title: 'Allowed again',
      }),
    ).resolves.toBeTruthy();
  });

  it('is keyed per ACCOUNT — one spammer does not spend another submitter’s budget', async () => {
    process.env['MOTIR_PUBLIC_SUBMIT_RATE_LIMIT'] = '1';
    process.env['MOTIR_PUBLIC_SUBMIT_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const fx = await makePublicProjectFixture('Per Account Co');
    const spammer = await createTestUser();
    const bystander = await createTestUser();

    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    await publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
      kind: 'task',
      title: 'Mine',
    });
    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, spammer.id, {
        kind: 'task',
        title: 'Mine again',
      }),
    ).rejects.toBeInstanceOf(PublicSubmissionRateLimitedError);
    await expect(
      publicProjectsService.submitPublicRequest(fx.projectId, bystander.id, {
        kind: 'task',
        title: 'Someone else entirely',
      }),
    ).resolves.toBeTruthy();
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
