import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { AcceptanceEvidenceAlreadyApprovedError } from '@/lib/acceptanceEvidence/errors';

// The WIRE code, written out rather than imported — deliberately (MOTIR-4096).
//
// It used to be imported from `scripts/upload-acceptance-video.mjs`, because
// that CI uploader was the third layer: a `.mjs` run by a workflow, which could
// not import the TS class and so carried its own copy of the string. That
// uploader is retired — the receipt is published by the AGENT over the Motir MCP
// surface — and the third layer moved OUT of this repository with it.
//
// So the literal is the join now, and it has to be a literal: every remaining
// client of this code (the agent, and any external CI publishing through the
// HTTP route) recognises it as a STRING off the wire, with nothing to import.
// A test that derived it from the error class would assert the class equals
// itself and could be renamed green while every one of those clients broke.
const ALREADY_APPROVED_CODE = 'ACCEPTANCE_EVIDENCE_ALREADY_APPROVED';

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
//     Closed on BOTH sides now: MOTIR-2764 gave the publish the lock, MOTIR-2851
//     gave `decide` the same one, so the two serialise on one row.

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

/** Publish through the ROUTE a publishing client actually calls. */
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

    // Layer 3 — a CLIENT's recognition keys on that exact string. Nothing
    // outside this repository can import the TS class, so the wire literal is
    // the join (see the constant above; MOTIR-4096 moved that client from the
    // CI uploader to the agent publishing over MCP, and the join is unchanged).
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
    // The lock-before-read-derived-update discipline, on BOTH sides of the seam:
    // the publish reads the current receipt's status under `SELECT … FOR UPDATE`
    // (MOTIR-2764) and so does `decide` (MOTIR-2851), so the two serialise on one
    // row instead of interleaving between a read and its derived write.
    //
    // ⚠️ DRIVEN IN A LOOP, WITH A FRESH STORY PER ROUND. Which side wins is a
    // timing outcome, so a race run ONCE tests whichever path happened to fire
    // that morning — and this defect only ever appeared on the losing one.
    const outcomes: string[] = [];

    for (let round = 0; round < 5; round++) {
      const story = await inReviewStory();
      await publish(story, 'first.webm', `aaa-${round}`);

      const [approveResult, publishResult] = await Promise.allSettled([
        acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx),
        publish(story, 'racing.webm', `bbb-${round}`),
      ]);

      // The approval is never the casualty — a "fix" that serialises by refusing
      // it would pass every invariant below and break the review loop.
      expect(approveResult.status, `round ${round}: the approval was refused`).toBe('fulfilled');
      expect(publishResult.status).toBe('fulfilled');
      const publishStatus = publishResult.status === 'fulfilled' ? publishResult.value.status : -1;
      // 409 = the freeze refused it; 201 = it superseded a still-`pending`
      // receipt. Anything else (a raw P2002, a 500) is a new defect, not a race.
      expect([201, 409]).toContain(publishStatus);

      const rows = await adminDb.acceptanceEvidence.findMany({ where: { workItemId: story.id } });
      const currents = rows.filter((r) => r.isCurrent);
      expect(currents).toHaveLength(1);
      const row = currents[0]!;

      // ⚠️ THE INVARIANT MOTIR-2851 RESTORES, AND THE REASON THIS CARD EXISTS.
      // Before the fix this produced a row `approved` AND `isCurrent: false`
      // whose attachments had been unlinked — an approval whose video the
      // orphan-GC reclaims after the safety window. It is the same evidence loss
      // MOTIR-2764 closed, reached by approving a few hundred ms earlier.
      const stranded = rows.filter((r) => r.status === 'approved' && !r.isCurrent);
      expect(stranded, `round ${round}: an approval landed on a superseded receipt`).toEqual([]);

      // Exactly one approval, it IS the current receipt, and its bytes are still
      // linked — the survival set, checked on whichever row the race elected.
      const approvedRows = rows.filter((r) => r.status === 'approved');
      expect(approvedRows).toHaveLength(1);
      expect(approvedRows[0]!.id).toBe(row.id);
      expect(row.approvedById).not.toBeNull();
      const attachment = await adminDb.attachment.findUniqueOrThrow({
        where: { id: row.attachmentId! },
      });
      expect(attachment.workItemId).toBe(story.id);

      if (publishStatus === 409) {
        // The approval won: the receipt it signed is the one that is frozen.
        expect(row.commitSha).toBe(`aaa-${round}`);
        expect(rows).toHaveLength(1);
        outcomes.push('approval-first');
      } else {
        // The publish won: it superseded a receipt that was still `pending` at
        // the moment it held the lock, which is correct, and the approval then
        // stamped the NEW current row — the recording the reviewer is looking at.
        expect(row.commitSha).toBe(`bbb-${round}`);
        outcomes.push('publish-first');
      }
    }
    // Both outcomes are legal and neither is guaranteed in any given round, so
    // this records what fired rather than requiring it — the deterministic test
    // below is what asserts BOTH interleavings without a timing dependency.
    expect(outcomes).toHaveLength(5);
  });

  it('BOTH legal interleavings, driven deterministically — the approval survives either order', async () => {
    // The race test above cannot assert both orders without a flaky expectation,
    // and "the fix serialises by always refusing the approval" would satisfy one
    // of them. So each order is forced here, and in each the approval SUCCEEDS.

    // ORDER 1 — the approval commits first: the publish is refused, and the
    // signed receipt is the one that stays. (Its full survival set — the stamps,
    // the linked bytes, the unmoved story — is the first test in this file.)
    const approvedFirst = await inReviewStory();
    await publish(approvedFirst, 'first.webm', 'aaa');
    const decidedFirst = await acceptanceEvidenceService.decide(
      { workItemId: approvedFirst.id, decision: 'approve' },
      fx.ctx,
    );
    expect(decidedFirst.evidence.status).toBe('approved');
    expect((await publish(approvedFirst, 'later.webm', 'bbb')).status).toBe(409);
    expect((await acceptanceEvidenceService.getCurrentForStory(approvedFirst.id, fx.ctx))!.id).toBe(
      decidedFirst.evidence.id,
    );

    // ORDER 2 — the publish commits first: the approval is NOT refused, it moves
    // to the new current row. This is the half the missing lock got wrong: it
    // stamped the row the publish had just superseded and unlinked.
    const publishedFirst = await inReviewStory();
    await publish(publishedFirst, 'first.webm', 'ccc');
    const superseded = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: publishedFirst.id, isCurrent: true },
    });
    expect((await publish(publishedFirst, 'second.webm', 'ddd')).status).toBe(201);

    const decidedSecond = await acceptanceEvidenceService.decide(
      { workItemId: publishedFirst.id, decision: 'approve' },
      fx.ctx,
    );
    expect(decidedSecond.storyStatus).toBe('done');
    expect(decidedSecond.evidence.status).toBe('approved');
    expect(decidedSecond.evidence.commitSha).toBe('ddd');
    expect(decidedSecond.evidence.id).not.toBe(superseded.id);
    // …and the displaced receipt was never signed, so nothing approved is left
    // pointing at bytes the orphan-GC will take.
    const displaced = await adminDb.acceptanceEvidence.findUniqueOrThrow({
      where: { id: superseded.id },
    });
    expect(displaced.isCurrent).toBe(false);
    expect(displaced.status).toBe('pending');
    expect(displaced.approvedById).toBeNull();
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
