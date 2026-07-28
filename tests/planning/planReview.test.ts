import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
} from '@/lib/planning/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

// The helpers EVERY AI-planning surface shares (MOTIR-1747). They are small, and
// that is the point: the rail, the item-scoped dock and the `/ready` nudge must
// answer "is there a proposal pending?" identically, or the three entrances drift
// into three different ideas of what a settled run means.

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('readPendingProposal', () => {
  it('returns the review when the plan is `planned` AND carries items', async () => {
    respond(planReview([planReviewItem({ title: 'A proposed story' })]));

    const pending = await readPendingProposal('plan_1');

    expect(pending?.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/plans/plan_1', expect.anything());
  });

  // `generating` is still filling its frontier; `approved` / `declined` is
  // history, not a review.
  it.each(['generating', 'approved', 'declined'] as const)(
    'returns null for a `%s` plan',
    async (status) => {
      respond(planReview([planReviewItem()], { status }));

      expect(await readPendingProposal('plan_1')).toBeNull();
    },
  );

  it('returns null for a `planned` plan with NO proposals — the empty run', async () => {
    // The case the old delta read reported for EVERY run. It is still a real
    // outcome (a planner can genuinely propose nothing); it just has to be rare
    // rather than universal.
    respond(planReview([]));

    expect(await readPendingProposal('plan_1')).toBeNull();
  });

  it('propagates a failed read as a typed error rather than a null', async () => {
    // "Nothing pending" and "we could not tell" are different states; a surface
    // that cannot distinguish them silently swallows an outage.
    respond({ code: 'PLAN_NOT_FOUND' }, 404);

    await expect(readPendingProposal('plan_1')).rejects.toBeInstanceOf(PlanRequestError);
  });
});

describe('summarizePlanApproval', () => {
  it('reports created / updated / removed from the materialized plan', () => {
    const plan = {
      items: [
        { id: 'pi_1', op: 'add', workItemId: 'wi_1' },
        { id: 'pi_2', op: 'add', workItemId: null },
        { id: 'pi_3', op: 'modify', workItemId: 'wi_9' },
        { id: 'pi_4', op: 'remove', workItemId: 'wi_8' },
      ],
    } as unknown as PlanWithItemsDto;

    expect(summarizePlanApproval(plan)).toEqual({
      // A materialized `add` names the work item it BECAME; one that somehow has
      // no id falls back to the proposal id rather than dropping out of the count.
      created: ['wi_1', 'pi_2'],
      updated: ['wi_9'],
      removed: ['wi_8'],
    });
  });
});

describe('planDecisionErrorCode', () => {
  it('names the refusal the persist gate raises', () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_TARGET_IMMUTABLE'))).toBe(
      'immutable',
    );
  });

  it('names an already-decided plan, by code or by 404', () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_NOT_IN_EXPECTED_STATUS'))).toBe(
      'decided',
    );
    expect(planDecisionErrorCode(new PlanRequestError(404, null))).toBe('decided');
  });

  it('falls back for anything else, so no raw server code reaches the screen', () => {
    expect(planDecisionErrorCode(new PlanRequestError(500, 'BOOM'))).toBe('APPROVE_ERROR');
    expect(planDecisionErrorCode(new Error('network'))).toBe('APPROVE_ERROR');
    expect(planDecisionErrorCode(new Error('network'), 'discard')).toBe('discard');
  });
});
