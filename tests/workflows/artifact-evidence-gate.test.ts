import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { IllegalBoardMoveError } from '@/lib/boards/errors';
import { MissingArtifactEvidenceError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE CLOSE-OUT ARTIFACT-EVIDENCE GATE (MOTIR-2709) at the seam it actually
// guards: `applyStatusTransition`, which every close-out passes through.
//
// The rule's own logic is unit-tested against literals in
// `tests/workItems/artifactEvidence.test.ts`. What is proven HERE is the part
// that could only ever be wrong in the service — that the refusal fires on a
// real transition, that it leaves the row untouched, that `cancelled` still
// works, and that the two exemptions are the ones intended.
//
// Real Postgres, per the repo convention.

beforeEach(async () => {
  // The transition paths emit `work-item/transitioned` post-commit (5.4.5) and
  // the test env has no Inngest key.
  spyOnJobDispatch();
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  itemId: string;
}

let seq = 0;

/** A leaf carrying `type`, parked in `in_review` — one legal hop from `done`. */
async function makeItem(type: 'deploy' | 'code'): Promise<Fixture> {
  seq += 1;
  const user = await usersService.createUser({
    email: `ae-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'AE User',
  });
  const ws = await workspacesService.createWorkspace({
    name: `AE WS ${seq}`,
    ownerUserId: user.id,
  });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: `Cut the release (${type})`, type },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await workItemsService.updateStatus(item.id, 'in_review', ctx);
  return { ctx, projectId: project.id, itemId: item.id };
}

async function statusOf(fx: Fixture): Promise<string> {
  return (await workItemsService.getWorkItem(fx.itemId, fx.ctx)).status;
}

/** A minimal per-status board for the project, for the drag path. */
async function makeBoard(fx: Fixture): Promise<{ boardId: string; doneColumnId: string }> {
  const { workspaceId } = fx.ctx;
  const statuses = await workflowsService.listStatusesByProject(fx.projectId, workspaceId);
  const board = await adminDb.board.create({
    data: {
      workspaceId,
      projectId: fx.projectId,
      name: 'Board',
      type: 'kanban',
      position: 'a0',
    },
  });
  let doneColumnId = '';
  let n = 0;
  for (const status of statuses) {
    n += 1;
    const column = await adminDb.boardColumn.create({
      data: {
        workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        name: status.label,
        position: `c${n.toString(36)}`,
      },
    });
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        columnId: column.id,
        statusId: status.id,
      },
    });
    if (status.key === 'done') doneColumnId = column.id;
  }
  return { boardId: board.id, doneColumnId };
}

describe('a `deploy` card cannot reach done with nothing recorded (AC1)', () => {
  it('REFUSES the move and leaves the item exactly where it was', async () => {
    const fx = await makeItem('deploy');

    await expect(workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).rejects.toThrow(
      MissingArtifactEvidenceError,
    );
    // The refusal precedes the write, so this is not merely "the status is
    // wrong" — nothing about the row moved.
    expect(await statusOf(fx)).toBe('in_review');
  });

  it('names the three accepted forms and the exemption, so the fix is one hop', async () => {
    const fx = await makeItem('deploy');
    const err = await workItemsService
      .updateStatus(fx.itemId, 'done', fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingArtifactEvidenceError);
    const { message } = err as MissingArtifactEvidenceError;
    expect(message).toContain('sha256:');
    expect(message).toContain('sha512-');
    expect(message).toContain('NO ARTIFACT:');
  });

  it('ALLOWS it once a comment records the version (the inverse)', async () => {
    const fx = await makeItem('deploy');
    await commentsService.addComment(
      fx.itemId,
      { bodyMd: 'Released `@motir/cli@0.3.0`; `npx @motir/cli@0.3.0` pulls back clean.' },
      fx.ctx,
    );

    const updated = await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx);
    expect(updated.status).toBe('done');
  });

  it('ALLOWS it on a digest recorded in a REPLY, not just a root comment', async () => {
    const fx = await makeItem('deploy');
    const root = await commentsService.addComment(
      fx.itemId,
      { bodyMd: 'Did this actually publish?' },
      fx.ctx,
    );
    await commentsService.addComment(
      fx.itemId,
      {
        bodyMd: 'Yes — `motir-ci-runner@sha256:446c692d1f0a3b5c7e9d` pulled anonymously.',
        parentCommentId: root.id,
      },
      fx.ctx,
    );

    expect((await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).status).toBe('done');
  });

  it('does not fire on a non-`deploy` card, however empty its discussion', async () => {
    const fx = await makeItem('code');
    expect((await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).status).toBe('done');
  });
});

describe('`cancelled` is unaffected (AC2)', () => {
  it('an evidence-less `deploy` card still cancels', async () => {
    // A cancelled release card published nothing ON PURPOSE — the one
    // done-CATEGORY status where "nothing was published" is the correct claim.
    const fx = await makeItem('deploy');
    const updated = await workItemsService.updateStatus(fx.itemId, 'cancelled', fx.ctx);
    expect(updated.status).toBe('cancelled');
  });
});

describe('the exemption is stated, and identifiable afterwards (AC3)', () => {
  it('a declared `NO ARTIFACT:` comment closes the card', async () => {
    const fx = await makeItem('deploy');
    await commentsService.addComment(
      fx.itemId,
      { bodyMd: 'NO ARTIFACT: DNS cutover at the registrar — nothing is published anywhere.' },
      fx.ctx,
    );

    expect((await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).status).toBe('done');
  });

  it('a comment that merely MENTIONS the marker does not exempt the card', async () => {
    const fx = await makeItem('deploy');
    await commentsService.addComment(
      fx.itemId,
      { bodyMd: 'Not sure whether to use NO ARTIFACT: here or record something.' },
      fx.ctx,
    );

    await expect(workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).rejects.toThrow(
      MissingArtifactEvidenceError,
    );
  });

  it('an exempted card is FINDABLE afterwards — the declaration is a durable record', async () => {
    // The escape hatch is not a mute: it leaves an authored, timestamped comment
    // carrying a fixed literal, so the set of cards that claimed it can be
    // enumerated later. That is what keeps it from becoming a silent bypass.
    const fx = await makeItem('deploy');
    await commentsService.addComment(
      fx.itemId,
      { bodyMd: 'NO ARTIFACT: console toggle in the provider dashboard.' },
      fx.ctx,
    );
    await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx);

    const declarations = await adminDb.comment.findMany({
      where: { workItemId: fx.itemId, bodyMd: { contains: 'NO ARTIFACT:' } },
      select: { id: true, authorId: true, createdAt: true },
    });
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.authorId).toBe(fx.ctx.userId);
  });
});

describe('the board SNAPS BACK rather than 500-ing', () => {
  it('dragging an evidence-less `deploy` card into a done column is a board-shaped refusal', async () => {
    // The drag is how a person actually closes a card, so this path must reach
    // the 409 the 3.2 UI branches on — not an opaque internal error. The reason
    // carries the whole refusal message, so the card returns to its column with
    // the three accepted forms named.
    const fx = await makeItem('deploy');
    const { boardId, doneColumnId } = await makeBoard(fx);

    const err = await boardsService
      .moveCard(boardId, fx.itemId, { toColumnId: doneColumnId }, fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IllegalBoardMoveError);
    expect((err as IllegalBoardMoveError).reason).toContain('NO ARTIFACT:');
    expect(await statusOf(fx)).toBe('in_review');
  });
});

describe('the system lane is exempt, deliberately', () => {
  it('an imported closed `deploy` issue is not refused', async () => {
    // The issue importer (MOTIR-941) brings a closed source issue in as closed;
    // it was resolved in the source tool, and this repository's release
    // discipline has no claim on it. Same `system` bypass the manual-provenance
    // stamp already carves out.
    const fx = await makeItem('deploy');
    const updated = await workItemsService.setImportedStatus(fx.itemId, 'done', fx.ctx);
    expect(updated.status).toBe('done');
  });
});
