import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { shaFor } from '../../helpers/commitShaFixtures';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';

// STORY MOTIR-693's TWO JOINS, end to end below the UI (MOTIR-703;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md`).
//
// The unit suites (`tests/design-approval-switch.test.ts`,
// `tests/design-auto-rerun.test.ts`) prove each half. This file proves they are JOINED:
//
//   · SWITCH OFF → a real publish → the system approval → the card's status → a
//     dependent's READINESS, and on the open-PR arm a real merge webhook writing `done`.
//   · REVISE → the real decide door → its post-commit enqueue → the job's handler → the
//     re-run service → the stubbed hosted start, and the NEXT run's prompt carrying the
//     reviewer's reason.
//
// ONE boundary is stubbed, as the card asks: `hostedRunService.start`, the call that
// boots a container. The design uploader is stubbed as every design-publish test stubs
// it. The job dispatcher is CAPTURED (not run by a worker) so the test can hand the
// captured event to the job's own handler — the seam a worker would call.
//
// Not repeated here (the card's boundary): the decide door's own rules, the approval
// frame, and MOTIR-6070's hand-back.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { designAutoRerun } = await import('@/lib/jobs/definitions/designAutoRerun');
const { DESIGN_AUTO_RERUN_CAP } = await import('@/lib/services/designAutoRerunService');

const REASON = 'tighter spacing, the header is too loud';

let fx: WorkItemFixture;
let design: WorkItem;
let dependent: WorkItem;
let events: CapturedJobEvent[];
let restoreEvents: () => void;
let startSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Design review without a babysitter' },
    fx.ctx,
  );
  const d = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  const b = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Build the frame' },
    fx.ctx,
  );
  await workItemsService.linkWorkItems({ fromId: b.id, toId: d.id, kind: 'is_blocked_by' }, fx.ctx);
  await workItemsService.updateStatus(d.id, 'in_progress', fx.ctx);
  design = await adminDb.workItem.findUniqueOrThrow({ where: { id: d.id } });
  dependent = await adminDb.workItem.findUniqueOrThrow({ where: { id: b.id } });

  ({ events, restore: restoreEvents } = captureJobEvents());
  startSpy = vi
    .spyOn(hostedRunService, 'start')
    .mockImplementation(async () => ({ dispatchRunId: await aRun('hosted'), created: true }));
});

afterEach(() => {
  restoreEvents();
  startSpy.mockRestore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function publish(label: string): Promise<string> {
  const pathname = `${designPrefix(fx.workspaceId, design.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, design.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(design.id, fx);
  const evidence = await designEvidenceService.recordFromPathnames(
    {
      workItemId: design.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
  return evidence.id;
}

const gateOf = (evidenceId: string) =>
  adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result' },
  });

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

async function readinessOf(item: WorkItem) {
  const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
  return detail.readiness;
}

/** A dispatch run that carried the design card. */
async function aRun(origin: 'hosted' | 'local'): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin,
      model: 'claude-opus-5-5',
      createdById: fx.ctx.userId,
      cards: {
        create: {
          workspaceId: fx.workspaceId,
          workItemId: design.id,
          workItemKey: design.identifier,
          position: 0,
        },
      },
    },
  });
  return run.id;
}

/** Press Request changes → Revise (or Re-plan) through the REAL decide door. */
async function refuse(gateId: string, verdict: 'revise' | 're_plan') {
  await approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision: 'request_changes',
      noteMd: REASON,
      refusalVerdict: verdict,
      source: 'ui',
    },
    fx.ctx,
  );
}

/** Hand every captured re-run event to the JOB'S OWN handler, as a worker would. */
async function drainRerunJobs() {
  const pending = events.filter((e) => e.name === 'design/auto-rerun.requested');
  events.length = 0;
  for (const event of pending) {
    const outcome = await new JobTestEngine({
      function: designAutoRerun,
      events: [event],
    }).execute();
    if (outcome.error) throw outcome.error;
  }
  return pending.length;
}

/** Publish → Revise → drain, once. Returns the refused gate's id. */
async function publishAndRevise(label: string): Promise<string> {
  const gate = await gateOf(await publish(label));
  await refuse(gate.id, 'revise');
  await drainRerunJobs();
  return gate.id;
}

describe('1 · switch OFF, no pull request — approved on the record, the card done, a dependent ready', () => {
  it('publishes, and the whole chain moves without a press', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { designApprovalGate: false },
    });
    expect((await readinessOf(dependent)).ready).toBe(false);

    const gate = await gateOf(await publish('frame'));

    expect(gate).toMatchObject({
      state: 'approved',
      decidedById: null,
      decisionSource: 'system',
      decidedUnderAuthority: 'project_setting',
    });
    expect(await statusOf(design.id)).toBe('done');
    expect((await readinessOf(dependent)).ready).toBe(true);
  });
});

describe('2 · switch OFF, open pull request — approved, not done, and the MERGE writes done', () => {
  it('holds at the approval and closes on the merge webhook', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { designApprovalGate: false },
    });
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-703',
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
        repoId: '703',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 703,
        title: 'draw the frame',
        state: 'open',
        headRef: 'design/frame',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: design.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    const gate = await gateOf(await publish('frame'));
    expect(gate.state).toBe('approved');
    expect(gate.decisionSource).toBe('system');
    expect(await statusOf(design.id)).not.toBe('done');
    expect((await readinessOf(dependent)).ready).toBe(false);

    // The merge, through the real webhook door.
    const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
    await githubWebhookService.handleEvent('pull_request', {
      action: 'closed',
      installation: { id: 'inst-703', account: { login: 'acme', type: 'Organization' } },
      repository: { id: 703 },
      pull_request: {
        number: 703,
        state: 'closed',
        merged: true,
        title: 'draw the frame',
        head: { ref: 'design/frame' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    expect(await statusOf(design.id)).toBe('done');
  });
});

describe('3 · switch ON (the default) — nothing is decided by the system', () => {
  it('leaves the gate awaiting a person', async () => {
    const gate = await gateOf(await publish('frame'));
    expect(gate.state).toBe('awaiting');
    expect(gate.decisionSource).toBeNull();
    expect(await statusOf(design.id)).toBe('in_review');
  });
});

describe('4 · Revise on a HOSTED design — one run, as the previous dispatcher, carrying the reason', () => {
  it('the press enqueues, the job starts exactly one run, and the next prompt quotes the reviewer', async () => {
    await aRun('hosted');
    const gateId = await publishAndRevise('frame');

    expect(startSpy).toHaveBeenCalledTimes(1);
    const [input, ctx] = startSpy.mock.calls[0]!;
    expect(input).toMatchObject({ workItemKey: design.identifier, model: 'claude-opus-5-5' });
    expect(ctx).toEqual({ userId: fx.ctx.userId, workspaceId: fx.workspaceId });
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row).toMatchObject({ outcome: 'started', skipReason: null, ordinal: 1 });

    // The reason reaches the run through MOTIR-6070's prompt, not a copy made here.
    expect(await statusOf(design.id)).toBe('todo');
    const prompt = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      design.identifier,
      fx.ctx,
    );
    expect(prompt.prompt).toContain(REASON);
  });

  it('a redelivered event dispatches nothing more', async () => {
    await aRun('hosted');
    const gateId = await publishAndRevise('frame');
    const redelivered = await new JobTestEngine({
      function: designAutoRerun,
      events: [
        {
          name: 'design/auto-rerun.requested',
          data: { workspaceId: fx.workspaceId, gateId, idempotencyKey: gateId },
        },
      ],
    }).execute();
    expect(redelivered.error).toBeUndefined();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(await adminDb.designAutoRerun.count({ where: { gateId } })).toBe(1);
  });
});

describe('5 · no dispatch — at the cap, on a BYOK design, with a Re-plan', () => {
  it(`at the cap: the ${DESIGN_AUTO_RERUN_CAP + 1}th Revise records cap_reached`, async () => {
    await aRun('hosted');
    let last = '';
    for (let i = 0; i <= DESIGN_AUTO_RERUN_CAP; i += 1) {
      // The card is back at To do after each Revise; a person (or the re-run) picks it up.
      await workItemsService.updateStatus(design.id, 'in_progress', fx.ctx);
      last = await publishAndRevise(`v${i}`);
    }

    expect(startSpy).toHaveBeenCalledTimes(DESIGN_AUTO_RERUN_CAP);
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId: last } });
    expect(row).toMatchObject({ outcome: 'skipped', skipReason: 'cap_reached' });
  });

  it('on a BYOK design: nothing starts, nothing is recorded, and the card is never moved to the hosted lane', async () => {
    await aRun('local');
    const gateId = await publishAndRevise('frame');

    expect(startSpy).not.toHaveBeenCalled();
    expect(await adminDb.designAutoRerun.count({ where: { gateId } })).toBe(0);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: design.id } });
    expect(card.implementationSource).not.toBe('hosted');
  });

  it('with a Re-plan verdict: nothing is even enqueued', async () => {
    await aRun('hosted');
    const gate = await gateOf(await publish('frame'));
    await refuse(gate.id, 're_plan');

    expect(await drainRerunJobs()).toBe(0);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
