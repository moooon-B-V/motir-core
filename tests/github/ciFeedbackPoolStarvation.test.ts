import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbPool } from '@/lib/db';
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
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// A BURST OF CI DELIVERIES FOR ONE PULL REQUEST MUST NOT TAKE THE WHOLE POOL
// (MOTIR-6788).
//
// What production measured, once MOTIR-7073 made a P2028 report every pool: four
// `maxWait` timeouts — on `POST /api/github/webhook`, `GET /api/notifications/
// unread-count` and `GET /api/plans/[id]` — each with the route-handler pool at
// total 10 / idle 0 / waiting 5–11 / max 10, the event loop at p99 14–17 ms, and
// (on one) the page runtime's pool sitting at 10 IDLE. The database was answering;
// one pool was simply full.
//
// Every CI delivery for a pull request takes row locks on the SAME rows: the pull
// request (`renderFeedbackComments`' fold, `FOR UPDATE`) and each delivered card
// (`recomputeWorkItemCiState` / `recomputeWorkItemFixReason`). So a burst of
// deliveries for one pull request is serialised by Postgres — and each one waits
// for its turn INSIDE an open transaction, holding a pooled connection. With the
// pool at pg's default of 10, ten waiting deliveries leave nothing for any other
// route, whose transaction then gives up after its 2 s `maxWait`.
//
// This file rebuilds that condition against the real Postgres: a sibling holds the
// pull request's and the card's row locks (from the admin client, which has its own
// pool), a burst of terminal deliveries arrives, and an unrelated route's
// transaction asks for a connection.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-pool-starvation';
const REPO_PROVIDER_ID = '6788';
const SUITE_ID = '37078866342';
const HEAD_SHA = '6788f00daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PR_NUMBER = 6788;

/** More deliveries than the pool has connections — the shape of a burst. */
const BURST = 12;

/** Prisma's default `maxWait`: what an ordinary route's transaction waits for a
 *  connection before it throws P2028. */
const ROUTE_MAX_WAIT_MS = 2_000;

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

  const card = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'the card the burst is about' },
    ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', ctx);
  const headRef = `subtask/${card.identifier}-work`;
  await linkPrByIdentifier({
    identifier: card.identifier,
    owner: 'moooon',
    name: 'acme',
    number: PR_NUMBER,
    headRef,
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: PR_NUMBER,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: PR_NUMBER } }))!;
  return { installation, repo, card, pr };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** One terminal check delivery through the real consumer — the GitHub resolver
 *  swapped for the fixture's, exactly as `ciExpectedCheckSet.test.ts` does. */
function deliver(s: Scenario, checkName: string) {
  const event: NormalizedStatusEvent = {
    providerRepoId: REPO_PROVIDER_ID,
    commitSha: HEAD_SHA,
    conclusion: 'success',
    context: checkName,
    prNumbers: [PR_NUMBER],
    headBranch: null,
    suiteId: SUITE_ID,
  };
  const resolveContext = async (): Promise<CiFeedbackContextResolution> => ({
    kind: 'resolved',
    installation: s.installation,
    repo: s.repo,
    buildChecksUrl: (n: number) => `https://github.com/moooon/acme/pull/${n}/checks`,
  });
  return applyCiStatusFeedback(event, resolveContext);
}

/**
 * A sibling that holds the pull request's and the card's row locks until released
 * — the head of the queue every delivery in a burst lines up behind. It runs on the
 * ADMIN client, whose pool is not the one under test, so holding it costs `db`
 * nothing.
 */
function holdRowLocks(s: Scenario) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = adminDb.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM github_pull_request WHERE id = ${s.pr.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM work_item WHERE id = ${s.card.id} FOR UPDATE`;
      locked();
      await released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return { isLocked, release, holder };
}

function busyConnections(): number {
  const pool = dbPool()!;
  return pool.totalCount - pool.idleCount;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a burst of CI deliveries for one pull request, queued behind its row locks', () => {
  it('leaves the pool able to serve another route — every delivery still records', async () => {
    const s = await makeScenario('pool-starvation@example.com');
    const pool = dbPool()!;
    expect(pool.options.max).toBe(10);

    const lock = holdRowLocks(s);
    await lock.isLocked;

    // Settled as they finish, so a delivery that throws is an outcome to assert on
    // rather than an unhandled rejection racing the probe.
    const burst = Array.from({ length: BURST }, (_, i) =>
      deliver(s, `job ${String(i + 1).padStart(2, '0')}`).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      ),
    );
    let failures: (string | null)[] = [];
    try {
      // Let the burst reach the lock queue: deliveries are now waiting behind the
      // sibling, each inside whatever transaction reached the locked rows first.
      await vi.waitFor(() => expect(busyConnections()).toBeGreaterThanOrEqual(2), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // THE OBSERVATION: an unrelated route's transaction asks for a connection
      // with the ordinary budget. Before the fix the burst holds all ten, and this
      // throws `P2028 — Unable to start a transaction in the given time`.
      const probe = await db
        .$transaction(async (tx) => tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`, {
          maxWait: ROUTE_MAX_WAIT_MS,
        })
        .then(
          (rows) => ({ ok: true as const, rows }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(
        probe.ok,
        `an unrelated transaction could not get a connection: ${
          probe.ok ? '' : String((probe.err as Error).message)
        } (pool total ${pool.totalCount} / idle ${pool.idleCount} / waiting ${pool.waitingCount})`,
      ).toBe(true);
      expect(busyConnections()).toBeLessThan(pool.options.max!);
    } finally {
      lock.release();
      await lock.holder;
      failures = await Promise.all(burst);
      // Every connection back, nothing still waiting — so no backend of this test
      // outlives it into the next test's reset.
      await vi.waitFor(
        () => {
          expect(pool.waitingCount).toBe(0);
          expect(pool.idleCount).toBe(pool.totalCount);
        },
        { timeout: 10_000 },
      );
    }

    // Nothing was dropped. A delivery that gave up here is a CI conclusion GitHub
    // never redelivers, so the card's verdict would be folded over a set missing it.
    expect(failures.filter((f) => f !== null)).toEqual([]);
    const recorded = await adminDb.githubCheckRun.count({
      where: { pullRequestId: s.pr.id, commitSha: HEAD_SHA },
    });
    expect(recorded).toBe(BURST);
  }, 90_000);
});
