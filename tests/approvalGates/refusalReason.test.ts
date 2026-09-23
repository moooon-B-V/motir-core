// A REFUSAL SAYS WHY — the decide door requires a reason on every refusal a person
// presses (Story MOTIR-6067 · Subtask MOTIR-6074; ADR `approval-gates.md` §10a).
//
// The rule lives in the ONE door, beside Overturn's (`overturn_needs_a_note`), so it is
// true of every surface at once — the item page, the overlay, the REST route and any
// caller not written yet. It keys on the SOURCE: `ui` and `api` are pressed by a person
// and owe the reason; `github` is a review that already happened on the host, and the
// sync records its body instead (§10b — `tests/github/reviewEvaluator.test.ts`).
//
// The gates here are bare `awaiting` rows: the refusal fires at step 3c, after the lock,
// the authority check and the state check, and before any kind's effect runs — so what
// is under test is the door, for every kind that offers the verb, and nothing else.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every kind whose refusal is `request_changes` — *None of these* on a choice included,
 *  because that verb IS `request_changes` (§1's MOTIR-5887 amendment, point 5). */
const REFUSING_KINDS: readonly ApprovalGateKind[] = [
  'design_result',
  'acceptance_result',
  'decision_approval',
  'pull_request_approval',
  'decision_choice',
];

async function awaitingGate(kind: ApprovalGateKind) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `A ${kind} waiting for a person` },
    fx.ctx,
  );
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${kind}`,
      subjectVersion: 'v1',
      state: 'awaiting',
    },
  });
}

describe('the door refuses a refusal with no reason (ADR §10a)', () => {
  for (const kind of REFUSING_KINDS) {
    for (const source of ['ui', 'api'] as const) {
      for (const noteMd of [undefined, null, '', '   \n\t']) {
        it(`${kind} · ${source} · note ${JSON.stringify(noteMd)} → request_changes_needs_a_note, nothing written`, async () => {
          const gate = await awaitingGate(kind);

          const refused = await approvalGatesService
            .decide(
              {
                gateId: gate.id,
                decision: 'request_changes',
                source,
                noteMd,
                stamp: DECIDED_WITHOUT_A_READER,
              },
              fx.ctx,
            )
            .catch((err: unknown) => err);

          expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
          expect(refused).toMatchObject({
            code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
            reason: 'request_changes_needs_a_note',
          });
          // A request-shape refusal: the question is still open, and nobody decided it.
          expect(
            await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } }),
          ).toMatchObject({ state: 'awaiting', decidedById: null, noteMd: null });
        });
      }
    }
  }
});

describe('a refusal WITH a reason is recorded, as written', () => {
  it('stores the reason verbatim on the decided row, which then refuses a second decision', async () => {
    const gate = await awaitingGate('pull_request_approval');
    const reason = '  The migration drops a column the importer still reads.\n';

    const decided = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'api',
        noteMd: reason,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );

    expect(decided.gate).toMatchObject({
      state: 'changes_requested',
      noteMd: reason,
      decisionSource: 'api',
    });
    // The decided row is frozen: the reason cannot be rewritten after the fact.
    await expect(
      adminDb.approvalGate.update({ where: { id: gate.id }, data: { noteMd: 'rewritten' } }),
    ).rejects.toThrow();
  });
});

describe('what the rule does NOT touch', () => {
  it('Approve keeps its OPTIONAL note — a yes needs no justification', async () => {
    const gate = await awaitingGate('pull_request_approval');
    // Where a card waiting on this gate stands: its approval writes `approved`, which the
    // workflow reaches from review, never from To do.
    await workItemsService.updateStatus(gate.workItemId, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(gate.workItemId, 'in_review', fx.ctx);
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect(decided.gate).toMatchObject({ state: 'approved', noteMd: null });
  });

  it('Overturn keeps its own refusal, unchanged', async () => {
    const gate = await awaitingGate('decision_confirmation');
    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'overturn',
          source: 'ui',
          noteMd: ' ',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'overturn_needs_a_note' });
  });
});
