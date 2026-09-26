// A DESIGN SENT BACK IS A VERDICT — the decide door stores and enforces it (Story MOTIR-6070 ·
// Subtask MOTIR-6421; ADR `approval-gates.md` §10d, amended by `design-refusal-verdict.md`).
//
// `refusalVerdict` (`revise` | `re_plan`) is REQUIRED on a `request_changes` a person presses
// on a `design_result` gate and REFUSED everywhere else — every other kind, every other verb,
// and a `github` source, which nobody pressed and which is recorded verdict-less exactly as
// before. The rule is TOTAL over kind × verb × source, so this file walks that product
// rather than sampling it. The gates are bare `awaiting` rows, as in `refusalReason.test.ts`
// beside it: the refusal fires at step 3c, after the lock, authority and state checks and
// before any kind's effect, so what is under test is the door.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { APPROVAL_GATE_HANDLERS } from '@/lib/approvalGates/registry';
import { designResultGateHandler } from '@/lib/approvalGates/designResultHandler';
import type { GateDecision } from '@/lib/dto/approvalGate';
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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

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

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

/** A GitHub review synced into the door — the one source nobody pressed in Motir. */
const SYNCED = { synced: { reviewerGithubUserId: '999001', reviewerLogin: 'octo-reviewer' } };

type PressedSource = 'ui' | 'api';
const PRESSED: readonly PressedSource[] = ['ui', 'api'];

/**
 * A decision that would pass every OTHER step-3c refusal, per kind × verb — the note a
 * refusal or an overturn needs, and an option id for a choice — so that the only thing a
 * test varies is the verdict. Null where the verb is refused for its own reason before the
 * verdict is looked at (`approve_on_choice`, `request_changes_on_plan`, …): those combos
 * never reach the verdict rule, and the matrix below asserts that too.
 */
function pressFor(kind: ApprovalGateKind, decision: GateDecision) {
  const noteMd = 'Because the empty state is missing.';
  switch (decision) {
    case 'approve':
      return kind === 'decision_choice' ? null : { decision, noteMd: null };
    case 'choose':
      return kind === 'decision_choice' ? { decision, optionId: 'no-such-option' } : null;
    case 'request_changes':
      return kind === 'decision_confirmation' || kind === 'plan_approval'
        ? null
        : { decision, noteMd };
    case 'overturn':
      return kind === 'decision_confirmation' ? { decision, noteMd } : null;
    case 'decline':
      return null;
  }
}

/** Every registered card kind — the plan gate is card-less and offers `decline`, which the
 *  last block covers on its own. */
const CARD_KINDS = (Object.keys(APPROVAL_GATE_HANDLERS) as ApprovalGateKind[]).filter(
  (k) => k !== 'plan_approval',
);
const VERBS: readonly GateDecision[] = ['approve', 'choose', 'request_changes', 'overturn'];

describe('a design refusal pressed in Motir REQUIRES a verdict', () => {
  for (const source of PRESSED) {
    it(`design_result · request_changes · ${source} · no verdict → refusal_verdict_required, nothing written`, async () => {
      const gate = await awaitingGate('design_result');

      const refused = await approvalGatesService
        .decide(
          {
            gateId: gate.id,
            decision: 'request_changes',
            source,
            noteMd: 'The empty state is missing.',
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        )
        .catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
      expect(refused).toMatchObject({
        code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
        reason: 'refusal_verdict_required',
      });
      expect(await gateRow(gate.id)).toMatchObject({
        state: 'awaiting',
        decidedById: null,
        noteMd: null,
        refusalVerdict: null,
      });
    });

    for (const verdict of ['revise', 're_plan'] as const) {
      it(`design_result · request_changes · ${source} · ${verdict} → stored on the row and the DTO, frozen`, async () => {
        const gate = await awaitingGate('design_result');

        const decided = await approvalGatesService.decide(
          {
            gateId: gate.id,
            decision: 'request_changes',
            source,
            noteMd: 'The empty state is missing.',
            refusalVerdict: verdict,
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        );

        expect(decided.gate).toMatchObject({
          state: 'changes_requested',
          noteMd: 'The empty state is missing.',
          decisionSource: source,
          refusalVerdict: verdict,
        });
        expect(await gateRow(gate.id)).toMatchObject({
          state: 'changes_requested',
          refusalVerdict: verdict,
        });
        // Written IN the deciding write: the decided-row trigger refuses any amendment.
        await expect(
          adminDb.approvalGate.update({
            where: { id: gate.id },
            data: { refusalVerdict: verdict === 'revise' ? 're_plan' : 'revise' },
          }),
        ).rejects.toThrow();
        await expect(
          adminDb.approvalGate.update({ where: { id: gate.id }, data: { refusalVerdict: null } }),
        ).rejects.toThrow();
      });
    }
  }

  it('a value outside the vocabulary is refused as not offered, nothing written', async () => {
    const gate = await awaitingGate('design_result');
    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'request_changes',
          source: 'ui',
          noteMd: 'x',
          refusalVerdict: 'scrap' as never,
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'refusal_verdict_not_offered' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('the rule is TOTAL over kind × verb × source for a pressed decision', () => {
  for (const kind of CARD_KINDS) {
    for (const decision of VERBS) {
      const press = pressFor(kind, decision);
      if (!press) continue;
      const offers = kind === 'design_result' && decision === 'request_changes';
      if (offers) continue; // the block above
      for (const source of PRESSED) {
        it(`${kind} · ${decision} · ${source} · WITH a verdict → refusal_verdict_not_offered, nothing written`, async () => {
          const gate = await awaitingGate(kind);

          const refused = await approvalGatesService
            .decide(
              {
                gateId: gate.id,
                ...press,
                source,
                refusalVerdict: 'revise',
                stamp: DECIDED_WITHOUT_A_READER,
              },
              fx.ctx,
            )
            .catch((err: unknown) => err);

          expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
          expect(refused).toMatchObject({ reason: 'refusal_verdict_not_offered' });
          expect(await gateRow(gate.id)).toMatchObject({
            state: 'awaiting',
            decidedById: null,
            refusalVerdict: null,
          });
        });
      }
    }
  }

  it('a verb refused for its OWN reason is refused for that reason first, verdict or not', async () => {
    const choice = await awaitingGate('decision_choice');
    await expect(
      approvalGatesService.decide(
        {
          gateId: choice.id,
          decision: 'approve',
          source: 'ui',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'approve_on_choice' });

    const confirmation = await awaitingGate('decision_confirmation');
    await expect(
      approvalGatesService.decide(
        {
          gateId: confirmation.id,
          decision: 'request_changes',
          source: 'ui',
          noteMd: 'x',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'request_changes_on_confirmation' });

    // And the reason still comes before the verdict on a design refusal.
    const design = await awaitingGate('design_result');
    await expect(
      approvalGatesService.decide(
        {
          gateId: design.id,
          decision: 'request_changes',
          source: 'ui',
          noteMd: '  ',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'request_changes_needs_a_note' });
  });

  it('a refusal on a kind that offers no verdict, WITHOUT one, is accepted exactly as before', async () => {
    const gate = await awaitingGate('pull_request_approval');
    const decided = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'api',
        noteMd: 'The retry loop never backs off.',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );
    expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
    expect((await gateRow(gate.id)).refusalVerdict).toBeNull();
  });

  it('an APPROVE on a design, without a verdict, stores none', async () => {
    const gate = await awaitingGate('design_result');
    await workItemsService.updateStatus(gate.workItemId!, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(gate.workItemId!, 'in_review', fx.ctx);
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect(decided.gate).toMatchObject({ state: 'approved', refusalVerdict: null });
  });
});

describe('a GITHUB-sourced refusal carries no verdict — nobody was asked', () => {
  it('design_result · request_changes · github · no verdict → accepted, verdict NULL', async () => {
    const gate = await awaitingGate('design_result');
    const decided = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'github',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
      SYNCED,
    );
    expect(decided.gate).toMatchObject({
      state: 'changes_requested',
      decisionSource: 'github',
      refusalVerdict: null,
    });
    expect((await gateRow(gate.id)).refusalVerdict).toBeNull();
  });

  for (const kind of ['design_result', 'pull_request_approval'] as const) {
    for (const decision of ['request_changes', 'approve'] as const) {
      it(`${kind} · ${decision} · github · WITH a verdict → refusal_verdict_not_offered`, async () => {
        const gate = await awaitingGate(kind);
        await expect(
          approvalGatesService.decide(
            {
              gateId: gate.id,
              decision,
              source: 'github',
              noteMd: null,
              refusalVerdict: 're_plan',
              stamp: DECIDED_WITHOUT_A_READER,
            },
            fx.ctx,
            SYNCED,
          ),
        ).rejects.toMatchObject({ reason: 'refusal_verdict_not_offered' });
        expect((await gateRow(gate.id)).state).toBe('awaiting');
      });
    }
  }
});

describe('the verdict reaches the HANDLER — `GateEffectArgs.refusalVerdict`', () => {
  it('designResultGateHandler.requestChanges is handed the verdict the press carried', async () => {
    const spy = vi.spyOn(designResultGateHandler, 'requestChanges');
    const gate = await awaitingGate('design_result');

    await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: 'Wrong frame.',
        refusalVerdict: 're_plan',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      gate: { id: gate.id },
      refusalVerdict: 're_plan',
    });
  });

  it('a verdict-less refusal (GitHub) hands the handler null', async () => {
    const spy = vi.spyOn(designResultGateHandler, 'requestChanges');
    const gate = await awaitingGate('design_result');

    await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'github',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
      SYNCED,
    );

    expect(spy.mock.calls[0]![0]).toMatchObject({ refusalVerdict: null });
  });
});

describe('what the column holds before anybody decides', () => {
  it('an existing / awaiting row reads NULL, and the plan gate’s DECLINE is refused a verdict too', async () => {
    const gate = await awaitingGate('design_result');
    expect((await gateRow(gate.id)).refusalVerdict).toBeNull();

    // `decline` is the plan kind's verb; on a card kind it is refused for its own reason
    // first, and with a verdict it still never reaches a write.
    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'decline',
          source: 'ui',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});
