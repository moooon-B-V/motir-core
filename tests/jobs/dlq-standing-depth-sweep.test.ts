import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { dlqStandingDepthSweep } from '@/lib/jobs/definitions/dlqStandingDepthSweep';
import { projectsService } from '@/lib/services/projectsService';
import {
  DLQ_STANDING_AGE_DAYS,
  dlqStandingBugTitle,
  dlqStandingDepthService,
} from '@/lib/services/dlqStandingDepthService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { seededBugsFolderId } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';

// The DLQ STANDING-DEPTH filer (MOTIR-5869) — `docs/decisions/
// dead-letter-standing-depth-filing.md`, implemented. Driven through the real
// service and the real filer (`aiWorkItemsService.fileBug` as the system
// principal) against real Postgres. Dead letters are written with `adminDb`
// because `job_run_dlq`'s `system.*` rows are untenanted.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-21T07:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  // `job_run_dlq` and `job_dlq_standing_filing` sit outside the workspace
  // cascade — clear them after too, so nothing leaks into the next file.
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The seed's shape: a workspace, the `MOTIR` meta project, the system principal. */
async function makeMetaTenant(opts: { principal?: boolean } = {}) {
  const owner = await usersService.createUser({
    email: 'dlq-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  if (opts.principal !== false) {
    await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  }
  return { project };
}

/** `count` unreplayed dead letters for one function, the newest `newestDaysAgo`
 *  old and each further one a day older. */
async function deadLetters(functionId: string, count: number, newestDaysAgo: number) {
  await adminDb.jobRunDlq.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      functionId,
      eventName: `scheduled.${functionId}`,
      eventData: {},
      failure: { message: 'boom' },
      attempts: 3,
      firstFailedAt: daysAgo(newestDaysAgo + i),
      lastFailedAt: daysAgo(newestDaysAgo + i),
    })),
  });
}

/** The bugs the filer wrote, oldest first. */
async function filedBugs(projectId: string) {
  return adminDb.workItem.findMany({
    where: { projectId, kind: 'bug' },
    orderBy: { createdAt: 'asc' },
  });
}

const OLD = DLQ_STANDING_AGE_DAYS + 3;

describe('the trigger — one bug per FUNCTION, never per row', () => {
  it('two qualifying functions in one sweep file exactly two bugs, one each', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 5, OLD);
    await deadLetters('system.code-graph-refresh', 1, OLD);

    const summary = await dlqStandingDepthService.sweep(NOW);

    const bugs = await filedBugs(project.id);
    expect(bugs.map((b) => b.title).sort()).toEqual(
      [dlqStandingBugTitle('email.send'), dlqStandingBugTitle('system.code-graph-refresh')].sort(),
    );
    expect(summary).toMatchObject({ standing: 2, qualifying: 2, alreadyFiled: 0, skipped: null });
    expect(summary.filed.sort()).toEqual(bugs.map((b) => b.identifier).sort());
  });

  it('files into the meta project’s BUG DESTINATION, as the system principal', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 1, OLD);

    await dlqStandingDepthService.sweep(NOW);

    const [bug] = await filedBugs(project.id);
    expect(bug?.folderId).toBe(await seededBugsFolderId(project.id));
    expect(bug?.parentId).toBeNull();
    const reporter = await adminDb.user.findUniqueOrThrow({ where: { id: bug!.reporterId } });
    expect(reporter.email).toBe('system@motir.internal');
  });
});

describe('the AGE boundary — age, not count', () => {
  it('a function whose unreplayed rows are all younger than the threshold files nothing, however many', async () => {
    const { project } = await makeMetaTenant();
    // 670 is the embedding backlog one broken deploy produced; its NEWEST row is
    // what the threshold is NOT about, so make every row a day under it.
    await deadLetters('work-item/embedding.requested', 670, 0);
    await adminDb.jobRunDlq.updateMany({
      data: { lastFailedAt: daysAgo(DLQ_STANDING_AGE_DAYS - 1) },
    });

    const summary = await dlqStandingDepthService.sweep(NOW);

    expect(await filedBugs(project.id)).toHaveLength(0);
    expect(summary).toMatchObject({ standing: 1, qualifying: 0, filed: [] });
    expect(await adminDb.jobDlqStandingFiling.count()).toBe(0);
  });

  it('ONE row past the threshold is enough — the OLDEST row decides', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 40, 0); // 40 young rows …
    await deadLetters('email.send', 1, DLQ_STANDING_AGE_DAYS + 1); // … and one old one

    await dlqStandingDepthService.sweep(NOW);

    expect(await filedBugs(project.id)).toHaveLength(1);
  });
});

describe('the DEDUP — one open filing per function, held in a row', () => {
  it('a second sweep with the bug still open files nothing further for that function', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 3, OLD);
    await dlqStandingDepthService.sweep(NOW);

    await deadLetters('email.send', 10, OLD + 5); // the depth grows — still nothing
    const second = await dlqStandingDepthService.sweep(NOW);

    expect(await filedBugs(project.id)).toHaveLength(1);
    expect(second).toMatchObject({ qualifying: 1, filed: [], alreadyFiled: 1 });
  });

  it('two sweeps racing on one new function file exactly ONE bug', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 2, OLD);

    const [a, b] = await Promise.all([
      dlqStandingDepthService.sweep(NOW),
      dlqStandingDepthService.sweep(NOW),
    ]);

    expect(await filedBugs(project.id)).toHaveLength(1);
    expect(a.filed.length + b.filed.length).toBe(1);
    expect(a.alreadyFiled + b.alreadyFiled).toBe(1);
  });
});

describe('the RE-ARM asymmetry — only a drained queue re-arms', () => {
  it('closing the bug with rows still standing files NOTHING on the next sweep', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 3, OLD);
    await dlqStandingDepthService.sweep(NOW);
    const [bug] = await filedBugs(project.id);
    await adminDb.workItem.update({ where: { id: bug!.id }, data: { status: 'done' } });

    const next = await dlqStandingDepthService.sweep(NOW);

    expect(await filedBugs(project.id)).toHaveLength(1);
    expect(next).toMatchObject({ filed: [], alreadyFiled: 1, rearmed: 0 });
  });

  it('draining the rows to ZERO re-arms, and a later qualifying row files again', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 3, OLD);
    await dlqStandingDepthService.sweep(NOW);
    const [first] = await filedBugs(project.id);

    // The disposal rule's verb: export, then DELETE. The bug is left OPEN —
    // draining without closing re-arms too.
    await adminDb.jobRunDlq.deleteMany({ where: { functionId: 'email.send' } });
    const drained = await dlqStandingDepthService.sweep(NOW);
    expect(drained).toMatchObject({ standing: 0, rearmed: 1, filed: [] });
    expect(await filedBugs(project.id)).toHaveLength(1);

    await deadLetters('email.send', 1, OLD);
    const again = await dlqStandingDepthService.sweep(NOW);

    const bugs = await filedBugs(project.id);
    expect(bugs).toHaveLength(2);
    expect(again.filed).toEqual([bugs[1]!.identifier]);
    // The create path turns the key into a link (and a `relates_to` mention
    // edge), so the re-file points at the card before it.
    expect(bugs[1]!.descriptionMd).toContain(
      `Filed again: the queue drained to zero after [${first!.identifier}]`,
    );
  });

  it('a REPLAYED row counts as disposed — replaying everything re-arms like deleting', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 2, OLD);
    await dlqStandingDepthService.sweep(NOW);

    await adminDb.jobRunDlq.updateMany({ data: { replayedAt: NOW } });
    expect(await dlqStandingDepthService.sweep(NOW)).toMatchObject({ standing: 0, rearmed: 1 });
    expect(await filedBugs(project.id)).toHaveLength(1);
  });

  it('a depth that shrinks but never reaches zero does NOT re-arm', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('email.send', 3, OLD);
    await dlqStandingDepthService.sweep(NOW);

    const [keep] = await adminDb.jobRunDlq.findMany({ take: 1 });
    await adminDb.jobRunDlq.deleteMany({ where: { id: { not: keep!.id } } });
    const next = await dlqStandingDepthService.sweep(NOW);

    expect(next).toMatchObject({ standing: 1, rearmed: 0, filed: [], alreadyFiled: 1 });
    expect(await filedBugs(project.id)).toHaveLength(1);
  });
});

describe('the filed bug — a chore to dispose of, never a fault report', () => {
  it('names the function, the standing count and the oldest last_failed_at, and points at the disposal rule', async () => {
    const { project } = await makeMetaTenant();
    await deadLetters('system.daily-health-check', 35, OLD);
    const oldest = daysAgo(OLD + 34);

    await dlqStandingDepthService.sweep(NOW);

    const [bug] = await filedBugs(project.id);
    const body = bug!.descriptionMd ?? '';
    expect(body).toContain('`system.daily-health-check`');
    expect(body).toContain('**35 dead-lettered runs**');
    expect(body).toContain(oldest.toISOString());
    expect(body).toContain('*Disposing of a standing dead letter*');
    expect(body).toContain('`docs/jobs.md`');
    expect(body).toContain('closing this card does not re-arm it');
  });

  it('never says the job is FAILING — that is the event path’s sentence', () => {
    expect(dlqStandingBugTitle('email.send')).not.toMatch(/fail/i);
    expect(dlqStandingBugTitle('email.send').length).toBeLessThanOrEqual(200);
  });
});

describe('who files — the system principal, and a deployment without one', () => {
  it('no system principal ⇒ nothing is filed, the result says why, and nothing throws', async () => {
    const { project } = await makeMetaTenant({ principal: false });
    await deadLetters('email.send', 1, OLD);

    const summary = await dlqStandingDepthService.sweep(NOW);

    expect(summary).toMatchObject({ qualifying: 1, filed: [], skipped: 'no-system-principal' });
    expect(await filedBugs(project.id)).toHaveLength(0);
    // Nothing was claimed, so the function is still armed for the day a
    // principal exists.
    expect(await adminDb.jobDlqStandingFiling.count()).toBe(0);
  });

  it('an EMPTY queue never resolves the principal', async () => {
    // No tenant at all: resolving the principal would be the only thing that
    // could fail, and it must not be reached.
    expect(await dlqStandingDepthService.sweep(NOW)).toEqual({
      standing: 0,
      qualifying: 0,
      filed: [],
      alreadyFiled: 0,
      rearmed: 0,
      skipped: null,
    });
  });
});

describe('system.dlq-standing-depth-sweep — the scheduled job', () => {
  it('is its own job, not the daily health check, and files through the service', async () => {
    const { project } = await makeMetaTenant();
    await adminDb.jobRunDlq.create({
      data: {
        functionId: 'email.send',
        eventName: 'email.send',
        eventData: {},
        failure: { message: 'boom' },
        attempts: 3,
        lastFailedAt: new Date(Date.now() - (DLQ_STANDING_AGE_DAYS + 1) * DAY_MS),
      },
    });

    expect(dlqStandingDepthSweep.id).toBe('system.dlq-standing-depth-sweep');
    const { result, error } = await new JobTestEngine({
      function: dlqStandingDepthSweep,
    }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ qualifying: 1, filed: [expect.stringMatching(/^MOTIR-\d+$/)] });
    expect(await filedBugs(project.id)).toHaveLength(1);
  });
});
