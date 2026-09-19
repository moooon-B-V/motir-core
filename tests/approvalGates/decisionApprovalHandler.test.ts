import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionDocOutcome } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { decisionApprovalGateHandler } from '@/lib/approvalGates/decisionApprovalHandler';
import type { DecisionDocumentResolver } from '@/lib/approvalGates/decisionDocumentResolver';
import { ApprovalGateDecisionUnresolvableError } from '@/lib/approvalGates/errors';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  decisionDocumentService,
  setDecisionDocumentResolver,
} from '@/lib/services/decisionDocumentService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `decision_approval` HANDLER over real Postgres (Story MOTIR-4907 · Subtask
// MOTIR-5676; `approval-gates.md` §8's FIFTH AMENDMENT). Every seam reads the CAPTURE
// on the card's pull requests (MOTIR-5674) and nothing else, so these tests seed that
// capture directly and never stub a host.
//
// ⚠️ THE TWO ASSERTIONS THAT MATTER MOST: an unresolvable decision cannot be APPROVED
// through the real door (and can be sent back), and a SECOND resolver changes what a
// person reads and NOTHING about how the gate raises, decides or refuses — which is
// what makes a later pages domain a resolver swap.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

let restoreResolver: DecisionDocumentResolver | null = null;
afterEach(() => {
  if (restoreResolver) setDecisionDocumentResolver(restoreResolver);
  restoreResolver = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Capture {
  outcome: DecisionDocOutcome | null;
  path?: string | null;
  blobSha?: string | null;
  headSha?: string | null;
  state?: 'open' | 'closed';
}

/** A decision card in review, delivered by one pull request per capture given. */
async function decisionCard(
  captures: Capture[],
  card: { type?: 'decision' | 'code'; executor?: 'coding_agent' | 'human' } = {},
) {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: card.type ?? 'decision',
      executor: card.executor ?? 'coding_agent',
    },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-decision-${seq}`,
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
      repoId: `repo-decision-${seq}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  for (const [index, capture] of captures.entries()) {
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: seq * 10 + index,
        title: 'Decide',
        state: capture.state ?? 'open',
        headRef: `docs/decide-${seq}-${index}`,
        baseRef: 'main',
        provider: 'github',
        decisionDocOutcome: capture.outcome,
        decisionDocPath: capture.path ?? null,
        decisionDocBlobSha: capture.blobSha ?? null,
        decisionDocHeadSha: capture.headSha ?? null,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
  }
  return item;
}

const ONE: Capture = {
  outcome: 'one',
  path: 'docs/decisions/page-model.md',
  blobSha: 'blob-1',
  headSha: 'head-1',
};

/** An awaiting decision gate on `itemId`, as MOTIR-5677's raise will write it. */
function awaitingGate(itemId: string, subjectVersion: string | null = null) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: itemId,
      kind: 'decision_approval',
      subjectId: itemId,
      subjectVersion,
      routedToId: fx.ownerId,
    },
  });
}

const decide = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, decision, source: 'ui' },
    fx.ctx,
  );

const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

describe('currentSubject — who is asked the decision question at all (clause 10)', () => {
  it('an agent’s decision card with a captured head is asked, about ITSELF', async () => {
    const item = await decisionCard([ONE]);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await decisionApprovalGateHandler.currentSubject({
          item: await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }),
          ctx: fx.ctx,
          tx,
        }),
      ).toBe(item.id);
    });
  });

  it.each([
    ['a HUMAN decision card — a choice, not this gate', { executor: 'human' as const }, [ONE]],
    ['a CODE card whose pull request edits an ADR', { type: 'code' as const }, [ONE]],
    ['a decision card with no pull request', {}, []],
    [
      'a decision card whose only pull request is closed',
      {},
      [{ ...ONE, state: 'closed' as const }],
    ],
    ['a decision card whose pull request was never captured', {}, [{ outcome: null }]],
  ])('%s is asked nothing', async (_label, card, captures) => {
    const item = await decisionCard(captures, card);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await decisionApprovalGateHandler.currentSubject({
          item: await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }),
          ctx: fx.ctx,
          tx,
        }),
      ).toBeNull();
    });
  });
});

describe('the decide door over a decision gate', () => {
  it('APPROVE over one document records the blob version and writes NO status — the merge writes `done`', async () => {
    const item = await decisionCard([ONE]);
    const statusBefore = (await itemRow(item.id)).status;
    const gate = await awaitingGate(item.id);

    const result = await decide(gate.id, 'approve');

    expect(result.gate.state).toBe('approved');
    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'merge_writes_done',
    });
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.subjectVersion).toBe('acme/web:docs/decisions/page-model.md@blob-1');
    expect((await itemRow(item.id)).status).toBe(statusBefore);
  });

  it.each([
    ['none', [{ outcome: 'none' as const, headSha: 'h' }]],
    ['several', [{ outcome: 'several' as const, headSha: 'h' }]],
    ['unreadable', [{ outcome: 'unreadable' as const, headSha: null }]],
    ['several', [ONE, { ...ONE, path: 'docs/decisions/other.md', blobSha: 'blob-2' }]],
  ] as const)(
    'APPROVE is REFUSED when the document is %s, and the gate stays awaiting',
    async (reason, captures) => {
      const item = await decisionCard([...captures]);
      const gate = await awaitingGate(item.id);

      const refused = await decide(gate.id, 'approve').catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(ApprovalGateDecisionUnresolvableError);
      expect((refused as ApprovalGateDecisionUnresolvableError).reason).toBe(reason);
      expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
        'awaiting',
      );
    },
  );

  it('APPROVE with nothing captured at all is refused as `none`', async () => {
    const item = await decisionCard([]);
    const gate = await awaitingGate(item.id);
    await expect(decide(gate.id, 'approve')).rejects.toMatchObject({ reason: 'none' });
  });

  it('REQUEST CHANGES is allowed on an unresolvable decision, and moves nothing', async () => {
    const item = await decisionCard([{ outcome: 'none', headSha: 'head-9' }]);
    const gate = await awaitingGate(item.id);

    const result = await decide(gate.id, 'request_changes');

    expect(result.gate.state).toBe('changes_requested');
    expect(result.effect.statusWritten).toBeNull();
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).subjectVersion,
    ).toBe('acme/web:unresolvable:none@head-9');
  });
});

describe('the RESOLVER is the only thing a second implementation changes (clause 8)', () => {
  const fake: DecisionDocumentResolver = {
    async resolve(identity) {
      return identity.resolvable
        ? {
            outcome: 'resolved',
            repo: identity.repo,
            path: identity.path,
            blobSha: identity.blobSha,
            markdown: '# From the pages domain\n\nThe page model is a tree.',
          }
        : { outcome: 'unresolvable', reason: identity.reason };
    },
  };

  /** Everything the gate DOES for a card: its subject, its approve, its refusal. */
  async function gateBehaviour() {
    const good = await decisionCard([ONE]);
    const bad = await decisionCard([{ outcome: 'several', headSha: 'h' }]);
    const subject = await withWorkspaceContext(fx.ctx, async (tx) =>
      decisionApprovalGateHandler.currentSubject({
        item: await tx.workItem.findUniqueOrThrow({ where: { id: good.id } }),
        ctx: fx.ctx,
        tx,
      }),
    );
    const approved = await decide((await awaitingGate(good.id)).id, 'approve');
    const refused = await decide((await awaitingGate(bad.id)).id, 'approve').catch(
      (err: ApprovalGateDecisionUnresolvableError) => err.code,
    );
    return {
      subject: subject === good.id,
      approved: [approved.gate.state, approved.effect],
      refused,
    };
  }

  it('raises, decides and refuses identically under the production resolver and a fake one', async () => {
    const withProduction = await gateBehaviour();
    restoreResolver = setDecisionDocumentResolver(fake);
    const withFake = await gateBehaviour();

    expect(withFake).toEqual(withProduction);
    expect(withProduction.refused).toBe('APPROVAL_GATE_DECISION_UNRESOLVABLE');
  });

  it('what a person READS comes from the registered resolver', async () => {
    const item = await decisionCard([ONE]);
    restoreResolver = setDecisionDocumentResolver(fake);

    const read = await decisionDocumentService.readForWorkItem(item.id, fx.ctx);

    expect(read.identity).toMatchObject({ resolvable: true, path: 'docs/decisions/page-model.md' });
    expect(read.content).toMatchObject({
      outcome: 'resolved',
      markdown: expect.stringContaining('From the pages domain'),
    });
  });

  it('a card with nothing captured reads as nothing, and no resolver is asked', async () => {
    const item = await decisionCard([]);
    let asked = false;
    restoreResolver = setDecisionDocumentResolver({
      async resolve() {
        asked = true;
        return { outcome: 'unresolvable', reason: 'none' };
      },
    });

    expect(await decisionDocumentService.readForWorkItem(item.id, fx.ctx)).toEqual({
      identity: null,
      content: null,
    });
    expect(asked).toBe(false);
  });
});

describe('the subject summary — a row names the document from the capture, with no host call', () => {
  it('a document gets its path and a title from its file name; an unresolvable one says why', async () => {
    const good = await decisionCard([ONE]);
    const bad = await decisionCard([{ outcome: 'several', headSha: 'h' }]);
    const bare = await decisionCard([]);
    const gates = [
      { id: 'g-good', kind: 'decision_approval' as const, subjectId: good.id },
      { id: 'g-bad', kind: 'decision_approval' as const, subjectId: bad.id },
      { id: 'g-bare', kind: 'decision_approval' as const, subjectId: bare.id },
    ];

    const summaries = await withWorkspaceContext(fx.ctx, (tx) => summarizeGateSubjects(gates, tx));

    expect(summaries.get('g-good')).toEqual({
      kind: 'decision_approval',
      outcome: 'one',
      repo: 'acme/web',
      number: expect.any(Number),
      path: 'docs/decisions/page-model.md',
      title: 'Page model',
      // The row's `title` names the blob; a `several` row counts documents (MOTIR-5679).
      blobSha: 'blob-1',
      documentCount: 1,
    });
    expect(summaries.get('g-bad')).toMatchObject({
      kind: 'decision_approval',
      outcome: 'several',
      path: null,
      title: null,
    });
    // Nothing captured: the subject does not resolve, and the row says so.
    expect(summaries.get('g-bare')).toBeNull();
  });
});
