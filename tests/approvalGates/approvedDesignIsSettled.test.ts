import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from '../helpers/db';

// AN APPROVED DESIGN IS SETTLED (Story MOTIR-5652 · Subtask MOTIR-5661;
// `docs/decisions/design-result.md` AMENDMENT 6 Q3), against a REAL Postgres.
//
// MOTIR-5552 makes a design final by testing the card's STATUS, and under the
// two-gate model an approved design card is NOT yet `done` — the merge writes
// `done`. AMENDMENT 5 Q2 named the window that leaves in its own words: "a card
// at `approved` with an open pull request is not yet `done`, so a publish in
// that window supersedes the approved version and the merge would leave `done`
// with a version nobody approved." That is the ordinary shape of a failed merge:
// the queue ejects the pull request, an agent comes back to the card, and
// re-publishing the asset looks like a reasonable thing to do.
//
// The three conditions are asserted SEPARATELY, because each one is a different
// way to get this wrong and a suite that only drove the happy refusal would pass
// with any two of them:
//
//   · approved, NOT merely decided — `changes_requested` ASKS for a new version;
//   · over the card's CURRENT result — an approval of v1 closes nothing on v2;
//   · at or above the review band — the pull-back is the door back.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'A design question' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(card.id, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
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
}

const mint = () =>
  designEvidenceService.createUploadTokens(
    {
      workItemId: card.id,
      files: [
        { kind: 'mock', sourcePath: 'design/work-items/v2.mock.html', contentType: 'text/html' },
      ],
    },
    fx.ctx,
  );

const withdraw = () =>
  designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx);

const gateFor = (evidenceId: string) =>
  adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: evidenceId } });

/** The refusal, typed — `rejects.toMatchObject` cannot assert on the message. */
async function refusalFrom(run: () => Promise<unknown>) {
  const err = await run().then(
    () => null,
    (e: Error & { code?: string; status?: number }) => e,
  );
  if (!err) throw new Error('expected a refusal, got a result');
  return err;
}

/**
 * Link an OPEN pull request to the card — the delivery row `link_pull_request`
 * writes. It is what makes the window a WINDOW: a merge is what would ship the
 * unapproved version, and with nothing open there is nothing to ship.
 */
async function openPullRequest(number = 7) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5661-${number}`,
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
      repoId: `repo-5661-${number}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number,
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
      workItemId: card.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
}

/**
 * Link an open pull request, publish v1, and approve it through the REAL decide
 * door — leaving the card in review with an approved design and a merge pending.
 *
 * That is the whole window, and it became reachable through the doors with
 * MOTIR-5662: before it, a publish onto a card with an open pull request raised no
 * design gate at all (AMENDMENT 4 Q8), so there was nothing to approve. With the
 * gate raised again the approval is NOT terminal — the merge writes `done` (§8) —
 * so the card stays where it is, which is exactly the state under test.
 */
async function publishAndApprove(label = 'v1') {
  await openPullRequest();
  const v = await publish(label);
  const gate = await gateFor(v.id);
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
    fx.ctx,
  );
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  return v;
}

/** MOTIR-5552's copy, which this card re-keys and does not replace. */
const WAY_FORWARD = /reopen the card by hand|propose a new design card/;

describe('the window: an APPROVED design on a card that is not yet `done`', () => {
  for (const status of ['in_review', 'approved'] as const) {
    describe(`with the card at \`${status}\``, () => {
      beforeEach(async () => {
        await publishAndApprove();
        if (status === 'approved') {
          await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'approved' } });
          card = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
        }
        expect(card.status).toBe(status);
      });

      it('refuses a PUBLISH', async () => {
        await expect(publish('v2')).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
      });

      it('refuses an upload-token MINT — no bytes are uploaded for a publish that cannot land', async () => {
        await expect(mint()).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
      });

      it('refuses a WITHDRAWAL — taking the approved design away is the same defect, sign flipped', async () => {
        await expect(withdraw()).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
      });

      it('says WHY and both ways forward, in MOTIR-5552 vocabulary — no new error code', async () => {
        const err = await refusalFrom(() => publish('v2'));
        expect(err).toMatchObject({ code: 'DESIGN_CARD_CLOSED', status: 409 });
        expect(err.message).toContain('APPROVED design result');
        expect(err.message).toMatch(WAY_FORWARD);
        // The false sentence this factory exists to avoid: the card is NOT
        // `done`, so "is done, so its design is decided" would be a lie.
        expect(err.message).not.toContain(`is ${card.status}, so its design is decided`);
      });
    });
  }
});

describe('what the refusal must NOT close', () => {
  it('an AWAITING gate still accepts a republish — a question nobody answered is what it is for', async () => {
    const v1 = await publish('v1');
    expect(await gateFor(v1.id)).toMatchObject({ state: 'awaiting' });

    const v2 = await publish('v2');

    expect(v2.id).not.toBe(v1.id);
    expect(await gateFor(v1.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'republished',
    });
  });

  it('CHANGES REQUESTED still accepts a republish — the verb exists to ask for one', async () => {
    // AMENDMENT 6 Q3 was written as "decided", which would have refused exactly
    // the republish `request_changes` asks for. Correction 1 on that Q.
    const v1 = await publish('v1');
    const gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: 'the fold is wrong',
        // A Motir-pressed design refusal carries its verdict (MOTIR-6421).
        refusalVerdict: 'revise',
      },
      fx.ctx,
    );

    // The refusal sends the card back to To do (MOTIR-6423) — and that is exactly the
    // state a revised publish must still land in, raising a FRESH question on it.
    const v2 = await publish('v2');
    expect(v2).toMatchObject({ workItemId: card.id });
    expect(v2.id).not.toBe(v1.id);
    expect(await gateFor(v2.id)).toMatchObject({ state: 'awaiting' });
    expect(await gateFor(v1.id)).toMatchObject({ state: 'changes_requested' });
  });

  it('an approval of v1 closes nothing once v2 is current', async () => {
    // Reached by approving v1, pulling back, publishing v2 — so the approved
    // gate is real and simply no longer names the current result.
    const v1 = await publishAndApprove();
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    const v2 = await publish('v2');
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
    card = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(v2.id).not.toBe(v1.id);

    await expect(publish('v3')).resolves.toMatchObject({ workItemId: card.id });
  });
});

describe('the door back is a person', () => {
  it('refused, then reopened by hand, then published and RE-APPROVED — the first approval left standing', async () => {
    const v1 = await publishAndApprove();
    await expect(publish('v2')).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });

    // THE REOPEN. The ordinary hand pull-back out of the review band — which is
    // also what withdraws every awaiting question on the card, so no merge gate
    // survives it to carry an unapproved design to `done`.
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    const v2 = await publish('v2');
    expect(v2.id).not.toBe(v1.id);
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
    const gate2 = await gateFor(v2.id);
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate2.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    // Two approvals, ACCUMULATING (§6d), each naming its own version — and the
    // first is untouched. A decided row is frozen by
    // `trg_approval_gate_decided_immutable`, and it is the record of what somebody
    // agreed to; AMENDMENT 5 Q2 arm (a) reads it until the second lands.
    expect(await gateFor(v1.id)).toMatchObject({ state: 'approved', supersededCause: null });
    expect(await gateFor(v2.id)).toMatchObject({ state: 'approved' });
  });

  it('a DECIDED gate cannot be superseded at all — the guard the re-open does not route around', async () => {
    // Measured rather than argued: this is the refusal that falsified AMENDMENT 6
    // Q3's original sentence ("reopening withdraws the decided design gate").
    const v1 = await publishAndApprove();
    const gate = await gateFor(v1.id);

    await expect(
      adminDb.$executeRawUnsafe(
        `UPDATE "approval_gate" SET state = 'superseded' WHERE id = $1`,
        gate.id,
      ),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
  });
});

describe('the status-keyed refusal MOTIR-5552 shipped is untouched', () => {
  it('a card in the done category still refuses, and still says so in its own words', async () => {
    // Through the real decide door: with no open pull request an approval IS
    // terminal, so this is the ordinary way a design card reaches `done`.
    const v1 = await publish('v1');
    const gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    card = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(card.status).toBe('done');

    const err = await refusalFrom(() => publish('v2'));
    expect(err).toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
    expect(err.message).toContain('is done, so its design is decided');
  });
});
