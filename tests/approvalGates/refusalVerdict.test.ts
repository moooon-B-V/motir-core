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
import { connectRepairRepo, deliveredPr } from '../helpers/repairFixtures';

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
      if (kind === 'decision_choice') return null;
      // A person's approve on the review agent's gate is *Continue without the review*,
      // which must say why (`override_needs_a_note`, ADR §12.3).
      return { decision, noteMd: kind === 'agent_review' ? noteMd : null };
    case 'choose':
      return kind === 'decision_choice' ? { decision, optionId: 'no-such-option' } : null;
    case 'request_changes':
      // Only the review agent refuses an `agent_review` gate — a person's is
      // `request_changes_on_agent_review` (ADR §12.3).
      return kind === 'decision_confirmation' || kind === 'plan_approval' || kind === 'agent_review'
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
  // Every gate here is a bare row on a task with NO delivery, so an `acceptance_result`
  // among them is a FINISHED story's — which offers no verdict (MOTIR-6501). The story-run
  // shape has its own block below.
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

    // A person's refusal of the review agent's gate — only the agent refuses one (§12.3).
    const review = await awaitingGate('agent_review');
    await expect(
      approvalGatesService.decide(
        {
          gateId: review.id,
          decision: 'request_changes',
          source: 'ui',
          noteMd: 'x',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'request_changes_on_agent_review' });

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

describe('an ACCEPTANCE refusal offers a verdict by RUN SHAPE (MOTIR-6501; acceptance-refusal-verdict.md §1)', () => {
  /** A story with a pending receipt and its awaiting acceptance gate; `run` gives it an
   *  open delivery of its own — a STORY RUN — and `closed` a delivery that is not open. */
  let repos = 0;
  async function acceptanceGate(shape: 'run' | 'finished' | 'closed') {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: `A ${shape} story` },
      fx.ctx,
    );
    if (shape !== 'finished') {
      const repo = await connectRepairRepo(fx, `web-${shape}-${repos++}`);
      await deliveredPr(fx, story.id, repo, {
        headRef: `parent/${shape}`,
        state: shape === 'run' ? 'open' : 'closed',
        merged: shape === 'closed',
      });
    }
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id },
    });
    return adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: 'v1',
        state: 'awaiting',
      },
    });
  }

  const REASON = 'The empty board should say how to add the first card.';

  for (const source of PRESSED) {
    it(`story run · request_changes · ${source} · no verdict → refusal_verdict_required, nothing written`, async () => {
      const gate = await acceptanceGate('run');
      await expect(
        approvalGatesService.decide(
          {
            gateId: gate.id,
            decision: 'request_changes',
            source,
            noteMd: REASON,
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        ),
      ).rejects.toMatchObject({ reason: 'refusal_verdict_required' });
      expect(await gateRow(gate.id)).toMatchObject({ state: 'awaiting', refusalVerdict: null });
    });

    for (const verdict of ['revise', 're_plan'] as const) {
      it(`story run · request_changes · ${source} · ${verdict} → accepted, stored on the row and the DTO`, async () => {
        const gate = await acceptanceGate('run');
        const decided = await approvalGatesService.decide(
          {
            gateId: gate.id,
            decision: 'request_changes',
            source,
            noteMd: REASON,
            refusalVerdict: verdict,
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        );
        expect(decided.gate).toMatchObject({
          state: 'changes_requested',
          noteMd: REASON,
          refusalVerdict: verdict,
          // A decided gate asks nothing more.
          offersRefusalVerdict: false,
        });
        expect(await gateRow(gate.id)).toMatchObject({
          state: 'changes_requested',
          refusalVerdict: verdict,
        });
      });
    }
  }

  for (const shape of ['finished', 'closed'] as const) {
    it(`${shape === 'finished' ? 'finished story' : 'a story whose only delivery is closed'} · WITH a verdict → refusal_verdict_not_offered`, async () => {
      const gate = await acceptanceGate(shape);
      await expect(
        approvalGatesService.decide(
          {
            gateId: gate.id,
            decision: 'request_changes',
            source: 'ui',
            noteMd: REASON,
            refusalVerdict: 'revise',
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        ),
      ).rejects.toMatchObject({ reason: 'refusal_verdict_not_offered' });
      expect((await gateRow(gate.id)).state).toBe('awaiting');
    });

    it(`${shape === 'finished' ? 'finished story' : 'a story whose only delivery is closed'} · WITHOUT a verdict → accepted, verdict NULL`, async () => {
      const gate = await acceptanceGate(shape);
      const decided = await approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'request_changes',
          source: 'ui',
          noteMd: REASON,
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      );
      expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
    });
  }

  it('story run · request_changes · github · WITH a verdict → not offered; WITHOUT one → accepted verdict-less', async () => {
    const withVerdict = await acceptanceGate('run');
    await expect(
      approvalGatesService.decide(
        {
          gateId: withVerdict.id,
          decision: 'request_changes',
          source: 'github',
          noteMd: null,
          refusalVerdict: 're_plan',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
        SYNCED,
      ),
    ).rejects.toMatchObject({ reason: 'refusal_verdict_not_offered' });

    const bare = await acceptanceGate('run');
    const decided = await approvalGatesService.decide(
      {
        gateId: bare.id,
        decision: 'request_changes',
        source: 'github',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
      SYNCED,
    );
    expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
  });

  it('story run · APPROVE with a verdict → not offered (a verdict belongs to a refusal)', async () => {
    const gate = await acceptanceGate('run');
    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'approve',
          source: 'ui',
          refusalVerdict: 'revise',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'refusal_verdict_not_offered' });
  });

  it('the gate read advertises the offer: true on a story run, false on a finished story, false once decided', async () => {
    const run = await acceptanceGate('run');
    const finished = await acceptanceGate('finished');
    const readOf = (workItemId: string) =>
      approvalGatesService.getForWorkItem({ workItemId, kind: 'acceptance_result' }, fx.ctx);

    expect((await readOf(run.workItemId!)).gate?.offersRefusalVerdict).toBe(true);
    expect((await readOf(finished.workItemId!)).gate?.offersRefusalVerdict).toBe(false);

    await approvalGatesService.decide(
      {
        gateId: run.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: REASON,
        refusalVerdict: 'revise',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );
    expect((await readOf(run.workItemId!)).gate).toMatchObject({
      state: 'changes_requested',
      offersRefusalVerdict: false,
    });
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
