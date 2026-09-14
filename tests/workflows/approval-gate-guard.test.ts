import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { ApprovalGatePendingBoardMoveError } from '@/lib/boards/errors';
import { ApprovalGatePendingError } from '@/lib/workItems/errors';
import { resolveStatusIntent } from '@/lib/workflows/statusIntent';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE APPROVAL-GATE GUARD (Story MOTIR-4887 · Subtask MOTIR-5526; ADR
// `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 1–5), at the seam it
// guards: `applyStatusTransition`, which every status door passes through.
//
// What is proven HERE is the refusal at the service, and that the board service
// and the MCP tool re-shape it into the one payload. The per-door proof across
// every door, and the fixture kind driving the guard, are the story's vitest gate
// (MOTIR-5530). Real Postgres, per the repo convention.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A design subtask in review with a gate on it — the shape the publish path
 *  produces. `kind` / `state` vary it for the rules that turn on them. */
async function gatedItem(
  opts: { kind?: ApprovalGateKind; state?: ApprovalGateState } = {},
): Promise<{ itemId: string; identifier: string; gateId: string }> {
  seq += 1;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `Story ${seq}` },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: `Design ${seq}` },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: opts.kind ?? 'design_result',
        subjectId: `subject-${item.id}`,
      },
      tx,
    ),
  );
  if (opts.state && opts.state !== 'awaiting') {
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: opts.state } });
  }
  return { itemId: item.id, identifier: item.identifier, gateId: gate.id };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

describe('an awaiting gate holds the ONE move it owns', () => {
  it('REFUSES the move into `done` and leaves the row where it was', async () => {
    const { itemId, identifier, gateId } = await gatedItem();

    const err = await workItemsService.updateStatus(itemId, 'done', fx.ctx).catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalGatePendingError);
    const typed = err as ApprovalGatePendingError;
    expect(typed.code).toBe('APPROVAL_GATE_PENDING');
    expect(typed.statusKey).toBe('done');
    expect(typed.gateId).toBe(gateId);
    expect(typed.gateKind).toBe('design_result');
    expect(typed.itemKey).toBe(identifier);
    expect(typed.message).toContain(identifier);
    expect(await statusOf(itemId)).toBe('in_review');
  });

  it.each(['in_progress', 'blocked', 'cancelled'])(
    'every other move stays legal — `→ %s` succeeds',
    async (to) => {
      const { itemId } = await gatedItem();
      await workItemsService.updateStatus(itemId, to, fx.ctx);
      expect(await statusOf(itemId)).toBe(to);
    },
  );

  it.each<ApprovalGateState>(['approved', 'changes_requested', 'superseded'])(
    'a `%s` gate holds nothing — the move into `done` succeeds',
    async (state) => {
      const { itemId } = await gatedItem({ state });
      await workItemsService.updateStatus(itemId, 'done', fx.ctx);
      expect(await statusOf(itemId)).toBe('done');
    },
  );

  it('a SYSTEM write is exempt, like the two sibling gates', async () => {
    const { itemId } = await gatedItem();
    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(itemId, 'done', fx.ctx, tx, { system: true }),
    );
    expect(await statusOf(itemId)).toBe('done');
  });
});

describe('the decide door is let through by NAME, and nothing else is', () => {
  it('approving the gate still writes `done`', async () => {
    const { itemId, gateId } = await gatedItem();

    const result = await approvalGatesService.decide(
      { gateId, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.effect.statusWritten).toBe('done');
    expect(await statusOf(itemId)).toBe('done');
  });

  it('a `decidingGateId` that is NOT the awaiting gate is still refused', async () => {
    const { itemId } = await gatedItem();
    const other = await gatedItem();

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemsService.applyStatusTransition(itemId, 'done', fx.ctx, tx, {
          decidingGateId: other.gateId,
        }),
      ),
    ).rejects.toThrow(ApprovalGatePendingError);
    expect(await statusOf(itemId)).toBe('in_review');
  });
});

describe('a gate that owns NOTHING refuses nothing', () => {
  it('a project whose workflow resolves the intent to no status is not refused', async () => {
    const { itemId } = await gatedItem();
    // Neither a `done` key nor anything in the done category: rename the done
    // status out of the key AND the category, and move the cancelled one out of
    // the category too. The edge `in_review → shipped` is the old `→ done` edge.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'done' },
      data: { key: 'shipped', category: 'in_progress' },
    });
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'cancelled' },
      data: { category: 'in_progress' },
    });

    await workItemsService.updateStatus(itemId, 'shipped', fx.ctx);
    expect(await statusOf(itemId)).toBe('shipped');
  });

  it('an awaiting row of a kind this build does not register refuses nothing, and does not throw', async () => {
    const { itemId } = await gatedItem({ kind: 'pull_request_approval' });

    // `handlerFor` would throw `ApprovalGateKindUnregisteredError` for this row;
    // the guard must never reach it.
    await expect(workItemsService.updateStatus(itemId, 'done', fx.ctx)).resolves.toMatchObject({
      status: 'done',
    });
    expect(await statusOf(itemId)).toBe('done');
  });
});

describe('the rule is resolved ONCE — `resolveStatusIntent`', () => {
  const statuses = [
    { key: 'todo', category: 'todo' as const },
    { key: 'in_review', category: 'in_progress' as const },
    { key: 'shipped', category: 'done' as const },
  ];

  it('prefers the key, then the category, then answers null', () => {
    expect(resolveStatusIntent(statuses, { key: 'in_review', category: 'in_progress' })).toBe(
      'in_review',
    );
    expect(resolveStatusIntent(statuses, { key: 'done', category: 'done' })).toBe('shipped');
    expect(
      resolveStatusIntent(
        statuses.filter((s) => s.category !== 'done'),
        { key: 'done', category: 'done' },
      ),
    ).toBeNull();
  });

  it('`workflowsService.resolveStatusKey` gives the same answer on a real project', async () => {
    const live = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const intent = { key: 'done', category: 'done' } as const;
    expect(await workflowsService.resolveStatusKey(fx.projectId, fx.workspaceId, intent)).toBe(
      resolveStatusIntent(live, intent),
    );
  });
});

describe('the refusal carries ONE payload out of the service', () => {
  it('`describePendingRefusal` names the item, the kind, whose decision it is, and whether the caller may make it', async () => {
    const { itemId, identifier } = await gatedItem();
    const err = (await workItemsService
      .updateStatus(itemId, 'done', fx.ctx)
      .catch((e) => e)) as ApprovalGatePendingError;

    const gate = await approvalGatesService.describePendingRefusal(err, fx.ctx);

    // The fixture owner reported the item and holds `approval:decide_any`.
    expect(gate).toMatchObject({ itemKey: identifier, kind: 'design_result', canDecide: true });
    expect(typeof gate.routedToLabel).toBe('string');
  });

  it('the board service re-raises it board-shaped, with the payload, after rolling the move back', async () => {
    const { itemId, identifier } = await gatedItem();
    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const board = await adminDb.board.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Board',
        type: 'kanban',
        position: 'a0',
      },
    });
    let doneColumnId = '';
    for (const [n, status] of statuses.entries()) {
      const column = await adminDb.boardColumn.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          boardId: board.id,
          name: status.label,
          position: `c${n.toString(36)}`,
        },
      });
      await adminDb.boardColumnStatus.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          boardId: board.id,
          columnId: column.id,
          statusId: status.id,
        },
      });
      if (status.key === 'done') doneColumnId = column.id;
    }

    const err = await boardsService
      .moveCard(board.id, itemId, { toColumnId: doneColumnId }, fx.ctx)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalGatePendingBoardMoveError);
    const typed = err as ApprovalGatePendingBoardMoveError;
    expect(typed.code).toBe('APPROVAL_GATE_PENDING');
    expect(typed.gate).toMatchObject({ itemKey: identifier, kind: 'design_result' });
    expect(await statusOf(itemId)).toBe('in_review');
  });

  it('MCP `transition_status` answers a tool error with the code, naming the pending decision', async () => {
    const { identifier } = await gatedItem();

    const res = await runTransitionStatus({ key: identifier, status: 'done' }, fx.ctx);

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('APPROVAL_GATE_PENDING');
    expect(text).toContain('design result approval');
  });
});

describe('an APPROVED gate still holds `done` while its pull request is open (rule 2b)', () => {
  /** Link an OPEN (or merged) pull request to the item — the delivery row
   *  `link_pull_request` writes, which is what makes the merge the writer of Done. */
  async function linkPullRequest(itemId: string, state: 'open' | 'closed') {
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-${itemId}`,
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
        repoId: `repo-${itemId}`,
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 7,
        title: 'draw the frame',
        state,
        merged: state === 'closed',
        headRef: 'design/frame',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    return pr;
  }

  it('approving with an open pull request writes no Done, and a hand move to Done is then REFUSED — waiting on the merge', async () => {
    const { itemId, identifier, gateId } = await gatedItem();
    await linkPullRequest(itemId, 'open');

    const decided = await approvalGatesService.decide(
      { gateId, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    expect(decided.gate.state).toBe('approved');
    expect(await statusOf(itemId)).toBe('in_review');

    const err = (await workItemsService
      .updateStatus(itemId, 'done', fx.ctx)
      .catch((e) => e)) as ApprovalGatePendingError;

    expect(err).toBeInstanceOf(ApprovalGatePendingError);
    expect(err.waitingOn).toBe('merge');
    expect(err.gateId).toBe(gateId);
    expect(await statusOf(itemId)).toBe('in_review');

    // No approve door is offered for a decision that has already been made.
    const gate = await approvalGatesService.describePendingRefusal(err, fx.ctx);
    expect(gate).toMatchObject({ itemKey: identifier, waitingOn: 'merge', canDecide: false });
  });

  it('every other move stays open — `→ in_progress` and `→ cancelled`', async () => {
    for (const to of ['in_progress', 'cancelled']) {
      const { itemId, gateId } = await gatedItem();
      await linkPullRequest(itemId, 'open');
      await approvalGatesService.decide({ gateId, decision: 'approve', source: 'ui' }, fx.ctx);
      await workItemsService.updateStatus(itemId, to, fx.ctx);
      expect(await statusOf(itemId)).toBe(to);
    }
  });

  it('once the pull request is no longer open (merged), the move to Done passes — the merge path', async () => {
    const { itemId, gateId } = await gatedItem();
    const pr = await linkPullRequest(itemId, 'open');
    await approvalGatesService.decide({ gateId, decision: 'approve', source: 'ui' }, fx.ctx);

    // What the merge sync commits BEFORE it transitions the card.
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });

    await workItemsService.updateStatus(itemId, 'done', fx.ctx);
    expect(await statusOf(itemId)).toBe('done');
  });

  it('an open pull request with NO approved gate does not hold Done on this rule', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'No gate' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Plain' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await linkPullRequest(item.id, 'open');

    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    expect(await statusOf(item.id)).toBe('done');
  });
});
