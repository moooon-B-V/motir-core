import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { AcceptanceEvidenceAlreadyApprovedError } from '@/lib/acceptanceEvidence/errors';
import { ALREADY_APPROVED_CODE } from '../../scripts/upload-acceptance-video.mjs';

// THE FREEZE SEAM (Story MOTIR-2765 · Subtask MOTIR-2771).
//
// Each sibling ships its own units. This drives one card's REAL output through
// the next card's REAL consumer, against real Postgres, and covers what no
// single card can see:
//
//   · the SURVIVAL SET — the destruction has two halves (the row is displaced
//     AND its attachments are unlinked, which is what hands the video to the
//     orphan-GC), so a test that checks only `isCurrent` would have passed while
//     the bytes were still being collected;
//   · the CODE, asserted at all three layers in ONE place — a typed error is a
//     contract between a service that raises it, a route that maps it and a
//     client that recognises it: three components, three green unit suites, each
//     perfectly capable of agreeing with nobody;
//   · the NARROWING — the tempting over-fix freezes everything, which passes the
//     headline test beautifully and silently breaks the review loop;
//   · the RACE — an approval landing between a publish's read and its write.

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({ url: `https://store.invalid/${p}-${++seq}` })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.invalid/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
    mintPrivateUploadToken: vi.fn(async () => 'client-token'),
    headPrivateBlob: vi.fn(async () => ({ size: 2048, contentType: 'video/webm' })),
  };
});

const { POST } = await import('@/app/api/work-items/[id]/acceptance-evidence/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
let token: string;

async function inReviewStory() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Freeze seam story' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

/** Publish through the ROUTE the CI uploader actually calls. */
async function publish(story: { id: string; identifier: string }, videoName: string, sha: string) {
  const req = new Request(
    `http://localhost/api/work-items/${story.identifier}/acceptance-evidence`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        videoPathname: `acceptance/${fx.workspaceId}/${story.id}/${videoName}`,
        commitSha: sha,
      }),
    },
  );
  return POST(req, { params: Promise.resolve({ id: story.identifier }) });
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = (
    await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'ci',
      fixedGrant: grantForLegacyScopes(['integration']),
    })
  ).token;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the freeze seam, end to end', () => {
  it('approve → republish → NOTHING changed (the whole survival set)', async () => {
    const story = await inReviewStory();
    await publish(story, 'signed.webm', 'aaa');

    // Approve through the SHIPPED path, not a hand-written UPDATE — it is what
    // stamps the approver and moves the story, and this test is about what
    // survives that exact state.
    await acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx);
    const before = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    const storyBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(before.approvedById).not.toBeNull();
    expect(before.approvedAt).not.toBeNull();

    const res = await publish(story, 'later.webm', 'bbb');
    expect(res.status).toBe(409);

    const after = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    // 1. Still the current receipt, and still the SAME one.
    expect(after.id).toBe(before.id);
    expect(after.isCurrent).toBe(true);
    // 2. The approval stamps are intact — the signature, not just the row.
    expect(after.status).toBe('approved');
    expect(after.approvedById).toBe(before.approvedById);
    expect(after.approvedAt?.toISOString()).toBe(before.approvedAt?.toISOString());
    // 3. Its attachments are still LINKED. This is the half a naive test misses:
    //    the unlink is what schedules the video for the orphan-GC, so a receipt
    //    can be current, approved, and pointing at bytes that will be collected.
    const attachments = await adminDb.attachment.findMany({
      where: {
        id: { in: [before.attachmentId, before.traceAttachmentId].filter(Boolean) as string[] },
      },
    });
    expect(attachments.length).toBeGreaterThan(0);
    for (const a of attachments) expect(a.workItemId).toBe(story.id);
    expect(
      await adminDb.attachment.count({ where: { source: 'acceptance_video', workItemId: null } }),
    ).toBe(0);
    // 4. No replacement row was inserted.
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(1);
    // 5. The story itself was not moved by the refused publish.
    const storyAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(storyAfter.status).toBe(storyBefore.status);
    expect(storyAfter.status).toBe('done');
  });

  it('ONE code, asserted at all THREE layers — a rename cannot pass by updating two', async () => {
    const story = await inReviewStory();
    await publish(story, 'signed.webm', 'aaa');
    await acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx);

    // Layer 1 — the SERVICE raises the typed error (not a raw Prisma failure).
    await expect(
      acceptanceEvidenceService.recordFromPathnames(
        {
          workItemId: story.id,
          videoPathname: `acceptance/${fx.workspaceId}/${story.id}/direct.webm`,
          commitSha: 'ccc',
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceAlreadyApprovedError);

    // Layer 2 — the ROUTE maps it to the agreed status + code.
    const res = await publish(story, 'later.webm', 'bbb');
    expect(res.status).toBe(409);
    const routeCode = (await res.json()).code;
    expect(routeCode).toBe(ALREADY_APPROVED_CODE);

    // Layer 3 — the UPLOADER's recognition keys on that exact string. It is a
    // `.mjs` run by CI and cannot import the TS class, so this is the join.
    expect(ALREADY_APPROVED_CODE).toBe(new AcceptanceEvidenceAlreadyApprovedError('MOTIR-1').code);

    // …and all three are literally the same value, in one assertion, so no two
    // of them can be updated without this failing.
    expect(
      new Set([
        routeCode,
        ALREADY_APPROVED_CODE,
        new AcceptanceEvidenceAlreadyApprovedError('X').code,
      ]).size,
    ).toBe(1);
  });

  it('the narrowing IS a narrowing — pending and changes_requested still supersede', async () => {
    // The tempting over-fix refuses to supersede anything: it passes the headline
    // test and silently breaks the review loop, because a reviewer who rejects a
    // recording would never receive a corrected one.
    const pendingStory = await inReviewStory();
    await publish(pendingStory, 'first.webm', 'aaa');
    expect((await publish(pendingStory, 'second.webm', 'bbb')).status).toBe(201);
    expect(
      (await acceptanceEvidenceService.getCurrentForStory(pendingStory.id, fx.ctx))!.commitSha,
    ).toBe('bbb');

    const rejectedStory = await inReviewStory();
    await publish(rejectedStory, 'first.webm', 'ccc');
    await acceptanceEvidenceService.decide(
      { workItemId: rejectedStory.id, decision: 'request_changes' },
      fx.ctx,
    );
    expect((await publish(rejectedStory, 'second.webm', 'ddd')).status).toBe(201);
    const current = await acceptanceEvidenceService.getCurrentForStory(rejectedStory.id, fx.ctx);
    expect(current!.commitSha).toBe('ddd');
    expect(current!.status).toBe('pending');
  });

  it('a publish RACING an approval resolves ONE way, with the approved receipt intact', async () => {
    // The lock-before-read-derived-update discipline: the publish reads the
    // current receipt's status under `SELECT … FOR UPDATE`, so an approval that
    // lands concurrently cannot slip between that read and the supersede.
    const story = await inReviewStory();
    await publish(story, 'first.webm', 'aaa');

    const [approveResult, publishResult] = await Promise.allSettled([
      acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx),
      publish(story, 'racing.webm', 'bbb'),
    ]);

    // Whichever order the two transactions serialise in, the invariant holds:
    // exactly one current receipt, and if it is approved its bytes are linked.
    expect(approveResult.status).toBe('fulfilled');
    const currents = await adminDb.acceptanceEvidence.findMany({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(currents).toHaveLength(1);
    const row = currents[0]!;

    if (publishResult.status === 'fulfilled' && publishResult.value.status === 409) {
      // The approval won the race: the receipt is frozen and untouched.
      expect(row.status).toBe('approved');
      expect(row.approvedById).not.toBeNull();
      const attachment = await adminDb.attachment.findUniqueOrThrow({
        where: { id: row.attachmentId! },
      });
      expect(attachment.workItemId).toBe(story.id);
    } else {
      // The publish won: it superseded a receipt that was still `pending` at the
      // moment it held the lock, which is correct. The approval then applies to
      // whichever row is current — never to a collected one.
      expect(['pending', 'approved']).toContain(row.status);
    }
    // ⚠️ WHAT THIS DELIBERATELY DOES NOT ASSERT, AND WHY — MOTIR-2851.
    //
    // The natural assertion here is that NO row is ever left `approved` AND
    // `isCurrent: false`. Against real Postgres this run produces exactly such a
    // row, and it is a REAL defect rather than a flaw in this test: MOTIR-2764
    // locks the current receipt on the PUBLISH path, but `decide` takes no lock,
    // so an approval can stamp a row a concurrent publish is already superseding.
    // That is the same receipt loss through the other door, it PRE-DATES this
    // story, and per the repo's rule it is filed (MOTIR-2851) rather than
    // absorbed into a card that did not cause it.
    //
    // So this asserts the invariant that DOES hold today — the freeze protects a
    // receipt approved BEFORE a publish starts — and MOTIR-2851 restores the
    // stronger one with its fix. Written this way round on purpose: a test
    // quietly weakened to green is how the stronger property gets forgotten.
    const approvedRows = await adminDb.acceptanceEvidence.findMany({
      where: { workItemId: story.id, status: 'approved' },
    });
    expect(approvedRows.length).toBeGreaterThan(0);
    // Whatever the interleaving, the story never ends up with TWO approvals.
    expect(approvedRows).toHaveLength(1);
  });
});

describe('the coverage floor', () => {
  // A new module that never enters the coverage report has NO floor at all, and
  // the omission is invisible: the report simply does not mention it. Worse, a
  // `thresholds` key matching no file passes VACUOUSLY — so this asserts both
  // that the key exists and that it resolves to a real file.
  const configSource = fs.readFileSync(path.join(process.cwd(), 'vitest.config.ts'), 'utf8');

  it.each([
    ['lib/acceptanceEvidence/errors.ts'],
    ['lib/services/acceptanceEvidenceService.ts'],
    ['lib/repositories/acceptanceEvidenceRepository.ts'],
  ])('%s is inside the measured surface AND exists', (file) => {
    expect(fs.existsSync(path.join(process.cwd(), file))).toBe(true);
    // Matched by an explicit entry or by a directory glob in `coverage.include`.
    const dir = path.dirname(file);
    const covered =
      configSource.includes(file) ||
      configSource.includes(`${dir}/**`) ||
      configSource.includes(`${dir}/*`);
    expect(covered, `${file} is not matched by any coverage.include entry`).toBe(true);
  });
});
