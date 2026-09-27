// WHICH GATES OFFER A REFUSAL VERDICT — `refusalVerdictOfferFor` (Story MOTIR-6071 ·
// MOTIR-6501; `docs/decisions/acceptance-refusal-verdict.md` §1).
//
// A unit over the function the decide door, the gate read and the handler share. The one
// data read — the story's open deliveries — is mocked here; the door's own use of it is
// walked on real Postgres in `refusalVerdict.test.ts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

const countOpenByWorkItem = vi.fn<(id: string, tx: unknown) => Promise<number>>();
vi.mock('@/lib/repositories/workItemDeliveryRepository', () => ({
  workItemDeliveryRepository: {
    countOpenByWorkItem: (id: string, tx: unknown) => countOpenByWorkItem(id, tx),
  },
}));

const { refusalVerdictOfferFor, hasOpenOwnDelivery } =
  await import('@/lib/approvalGates/verdictOffer');

const tx = {} as Prisma.TransactionClient;

beforeEach(() => {
  countOpenByWorkItem.mockReset();
});

describe('hasOpenOwnDelivery — the run shape', () => {
  it('is true with at least one open delivery of the item’s own, false with none', async () => {
    countOpenByWorkItem.mockResolvedValueOnce(2);
    expect(await hasOpenOwnDelivery('story-1', tx)).toBe(true);
    countOpenByWorkItem.mockResolvedValueOnce(0);
    expect(await hasOpenOwnDelivery('story-1', tx)).toBe(false);
    expect(countOpenByWorkItem).toHaveBeenCalledWith('story-1', tx);
  });
});

describe('refusalVerdictOfferFor', () => {
  it('a design result always offers one, and reads nothing', async () => {
    expect(await refusalVerdictOfferFor({ kind: 'design_result', workItemId: 'd' }, tx)).toBe(true);
    expect(countOpenByWorkItem).not.toHaveBeenCalled();
  });

  it('an acceptance result offers one on a STORY RUN only', async () => {
    countOpenByWorkItem.mockResolvedValueOnce(1);
    expect(
      await refusalVerdictOfferFor({ kind: 'acceptance_result', workItemId: 'story' }, tx),
    ).toBe(true);

    countOpenByWorkItem.mockResolvedValueOnce(0);
    expect(
      await refusalVerdictOfferFor({ kind: 'acceptance_result', workItemId: 'story' }, tx),
    ).toBe(false);
  });

  it('an acceptance gate with no card offers none, without a read', async () => {
    expect(await refusalVerdictOfferFor({ kind: 'acceptance_result', workItemId: null }, tx)).toBe(
      false,
    );
    expect(countOpenByWorkItem).not.toHaveBeenCalled();
  });

  const NONE: ApprovalGateKindDTO[] = [
    'decision_approval',
    'pull_request_approval',
    'pull_request_merge',
    'decision_choice',
    'decision_confirmation',
    'plan_approval',
  ];
  for (const kind of NONE) {
    it(`${kind} offers none`, async () => {
      expect(await refusalVerdictOfferFor({ kind, workItemId: 'x' }, tx)).toBe(false);
      expect(countOpenByWorkItem).not.toHaveBeenCalled();
    });
  }

  it('a kind with no arm is refused loudly rather than answered "not offered"', async () => {
    await expect(
      refusalVerdictOfferFor(
        { kind: 'brand_new_kind' as ApprovalGateKindDTO, workItemId: 'x' },
        tx,
      ),
    ).rejects.toThrow(/no answer for gate kind brand_new_kind/);
  });
});
