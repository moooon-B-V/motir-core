import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shaFor } from '../helpers/commitShaFixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from '../helpers/db';

// WHY A GATE WAS SUPERSEDED (Story MOTIR-5652 · Subtask MOTIR-5659;
// `docs/decisions/design-result.md` AMENDMENT 6 Q5), against a REAL Postgres
// through the real service doors.
//
// ADR §6b makes a supersede write `state` and nothing else. That is right about
// the ACTOR — a withdrawal is a product write and must never read as somebody's
// answer — and it was wrong about the EVENT: six paths retire a gate for six
// different reasons and the row recorded none of them, so no surface could say
// a true sentence about a superseded gate. MOTIR-5586 and MOTIR-5651 are the
// same false sentence on two surfaces ("a newer design was published"), true of
// one path and false of the other five. Both were repaired by making the
// sentence VAGUER, which is the only repair available while the row is silent.
//
// The three merge-gate causes live in `tests/github/pullRequestApprovalGates.test.ts`,
// beside the webhook machinery that drives them. This file covers the two design
// paths, the status funnel, and the two properties that are about the COLUMN
// rather than any one path:
//
//   · `unknown` means the row predates the column, and no live path may write it;
//   · a cause is not an actor — §6b's invariant survives the new field.

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

/** Publish one design version; returns the evidence DTO the publish recorded. */
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

const gateFor = (evidenceId: string) =>
  adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: evidenceId } });

describe('the DESIGN paths record which of the two happened', () => {
  it('a REPUBLISH marks the old version `republished` — the one sentence that was ever true', async () => {
    const v1 = await publish('v1');
    await publish('v2');

    expect(await gateFor(v1.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'republished',
    });
  });

  it('a WITHDRAWAL marks it `withdrawn`, NOT `republished` — nothing replaced it', async () => {
    // This is the pair the two broken surfaces could not tell apart. Asserting
    // `superseded` alone passes with both paths wired to one cause, which is the
    // state MOTIR-5586 and MOTIR-5651 were both filed against.
    const v1 = await publish('v1');

    await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id, reason: 'published onto the wrong card' },
      fx.ctx,
    );

    expect(await gateFor(v1.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'withdrawn',
    });
  });
});

describe('the STATUS funnel records `pulled_back`', () => {
  it('pulling the work back out of review withdraws the question and says the WORK moved', async () => {
    // Neither the design nor any pull request changed here; the card left the
    // state the question was asked in. A surface that told the reviewer "a newer
    // design was published" would be describing an event that did not happen.
    const v1 = await publish('v1');

    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    expect(await gateFor(v1.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'pulled_back',
    });
  });
});

describe('MOTIR-5663 — a pull-back withdraws and raises NOTHING', () => {
  // The one withdrawal that must NOT re-ask. Every other site retires a question
  // because its SUBJECT moved, so the card usually still has something to decide;
  // this one retires it because the WORK was taken back, and re-raising would put
  // the question straight back in somebody's queue.

  it('pulling back out of review leaves no awaiting gate at all', async () => {
    await publish('v1');

    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    expect(
      (await adminDb.approvalGate.findMany({ where: { workItemId: card.id } })).map((g) => [
        g.state,
        g.supersededCause,
      ]),
    ).toEqual([['superseded', 'pulled_back']]);
  });

  it('and so does a move to CANCELLED — a terminal card asks nothing', async () => {
    await publish('v1');
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);

    await workItemsService.updateStatus(card.id, 'cancelled', fx.ctx);

    expect(
      (await adminDb.approvalGate.findMany({ where: { workItemId: card.id } })).map((g) => [
        g.state,
        g.supersededCause,
      ]),
    ).toEqual([['superseded', 'pulled_back']]);
  });
});

describe('the COLUMN itself', () => {
  it('an AWAITING gate carries no cause, and a DECIDED one is never touched by a later supersede', async () => {
    const v1 = await publish('v1');
    expect(await gateFor(v1.id)).toMatchObject({ state: 'awaiting', supersededCause: null });

    await adminDb.approvalGate.update({
      where: { id: (await gateFor(v1.id)).id },
      data: { state: 'approved', decidedAt: new Date(), decidedById: fx.ctx.userId },
    });
    await publish('v2');

    // An answer outlives its subject (§6c): the republish found nothing awaiting,
    // so the decided row keeps its state AND stays causeless — a cause on a
    // decided gate would be the column claiming a withdrawal that never happened.
    expect(await gateFor(v1.id)).toMatchObject({ state: 'approved', supersededCause: null });
  });

  it('`unknown` is reachable at the DATABASE and excluded from the type every live path uses', async () => {
    // The backfill in `20260917200000_add_approval_gate_supersede_cause` is the
    // ONLY writer of `unknown`: it means this row predates the column. The enum
    // must accept it (the backfill has to land) while `LiveSupersedeCause`
    // refuses it, so a seventh call site cannot record "I don't know why I did
    // this" — which is exactly the silence the required argument ends.
    const v1 = await publish('v1');
    const gate = await gateFor(v1.id);
    await adminDb.$executeRawUnsafe(
      `UPDATE "approval_gate" SET state = 'superseded', superseded_cause = 'unknown' WHERE id = $1`,
      gate.id,
    );
    expect(await gateFor(v1.id)).toMatchObject({ supersededCause: 'unknown' });

    const repoSrc = readFileSync(
      join(process.cwd(), 'lib/repositories/approvalGateRepository.ts'),
      'utf8',
    );
    expect(repoSrc).toContain(
      "export type LiveSupersedeCause = Exclude<ApprovalGateSupersedeCause, 'unknown'>;",
    );
  });

  it('the migration BACKFILLS every row superseded before the column existed', async () => {
    // A superseded row left NULL would be indistinguishable from one a future
    // path forgot to describe. `unknown` says which of the two it is, and it says
    // it once, at the moment the column arrives.
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260917200000_add_approval_gate_supersede_cause/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toMatch(/UPDATE "approval_gate"[\s\S]*"superseded_cause" = 'unknown'/);
    expect(sql).toMatch(/WHERE "state" = 'superseded'/);
  });

  it('NO production caller is left on the old 3-argument form', () => {
    // The type checker is the real guard — that is the whole reason the argument
    // is required rather than optional. This asserts the SHAPE rather than a
    // census: a call that still ends `…, tx)` straight after the kind is one the
    // compiler would reject, so a green here and a red build cannot disagree,
    // and an EIGHTH call site added later is measured by the same rule as the
    // seven instead of having to be added to a number.
    const files = execSync("grep -rl 'supersede\\(All\\)\\?AwaitingByWorkItem(' lib/services", {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const call of src.matchAll(/supersede(?:All)?AwaitingByWorkItem\(([\s\S]*?)\);/g)) {
        // Strip comments FIRST — several of these calls carry a prose note that
        // contains commas, and splitting before stripping would count one as an
        // argument.
        const args = call[1]!
          .replace(/\/\/[^\n]*/g, '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        // The cause sits immediately before `tx` in both signatures.
        expect(`${file} → ${args.join(' | ')}`).toMatch(/'[a-z_]+' \| tx$/);
      }
    }
  });
});
