import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the `server-only` pre-plan read the
// repo-set derivation's SECONDARY signal arrives over. Every project, plan, work
// item and set row below is real Postgres, per the repo's no-mocks convention.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The plan → repository ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by
// bug MOTIR-4924) over real Postgres, end to end through `approvePlan`.
//
// ── What was wrong ──────────────────────────────────────────────────────────
// motir-ai has emitted `targetRepositoryRef` on a proposal's `proposedFields`
// since MOTIR-3045, and motir-core READ NOTHING off it until this bug: the pin
// was persisted onto the plan-item row and dropped at approve, so a leaf pinned
// ONLY by row ref materialized with `targetRepo: null`, `targetRepos: []` and NO
// `work_item_repo` row — unrouted, and indistinguishable from a leaf the planner
// could not classify. The failure is silent: nothing errors, the plan looks
// complete, and the pin is gone.
//
// ── Why the ROW-ID spelling matters more than an optional field ─────────────
// A role resolves to NOTHING on a project where two rows share it (by design —
// the label that distinguishes them is never a resolution key). On precisely the
// projects the row pin was built for — two `api` services, a web client and an
// admin client — the row pin is the ONLY expressible pin. So the case below that
// proves the fix is the one the role pin cannot serve.
//
// ── What this file pins, and why each case is here ──────────────────────────
//   1. An `add` carrying `targetRepositoryRef` and NOTHING ELSE on the
//      repository axis materializes a work item whose `work_item_repo` names
//      that row — the field is READ, not merely declared (AC1).
//   2. It resolves on a project where TWO rows share a role — the case the role
//      pin cannot serve and the whole reason the ref exists (AC2).
//   3. An explicit `null` ref is UNPINNED, not an error — the sparse contract.
//   4. A ref naming a row of ANOTHER project resolves to nothing — the ref is
//      validated as belonging to this project, and an out-of-set ref lands
//      unrouted and honest rather than guessed.

/** A pre-plan wire body carrying §0.1.2's signal (silent → roles/refs only). */
function preplanWith(): RawPreplanStateResponse {
  return { session: null, docs: [], catalog: null };
}

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** The work items an approved plan materialized, by title. */
async function itemsByTitle(fx: WorkItemFixture) {
  const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
  return new Map(rows.map((r) => [r.title, r]));
}

/** One item's stored REFERENCES, as repository NAMES. */
async function refNames(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRepo.findMany({
    where: { workItemId },
    include: { projectRepo: true },
  });
  return rows.map((r) => r.projectRepo.name);
}

/** Add a repository ROW to the project's set (not realized — a row is enough
 *  for the pin to point at; realization is the establish step's concern). */
async function addRepoRow(fx: WorkItemFixture, name: string, role: string): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: role as 'api', name },
    fx.ctx,
  );
  return row.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
  // No pre-plan `platform`: the derivation's secondary signal is silent, so the
  // rows below are the only repositories in play.
  vi.mocked(getPreplanState).mockResolvedValue(preplanWith());
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('approvePlan — a proposal pinned ONLY by `targetRepositoryRef` materializes its row (AC1)', () => {
  it('reads the ROW pin and writes the reference the row names', async () => {
    const fx = await makeWorkItemFixture();
    const api = await addRepoRow(fx, 'acme-api', 'api');
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'The API half', kind: 'task', targetRepositoryRef: api },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const item = (await itemsByTitle(fx)).get('The API half')!;
    expect(await refNames(item.id)).toEqual(['acme-api']);
  });

  it('treats an explicit `null` ref as UNPINNED, not as an error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unpinned', kind: 'task', targetRepositoryRef: null } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const item = (await itemsByTitle(fx)).get('Unpinned')!;
    expect(item.targetRepo).toBeNull();
    expect(await adminDb.workItemRepo.findMany({ where: { workItemId: item.id } })).toEqual([]);
  });

  it('a ref naming a row of ANOTHER project resolves to nothing — honest, never a guess', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const otherRow = await addRepoRow(other, 'other-repo', 'api');
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Foreign ref', kind: 'task', targetRepositoryRef: otherRow },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const item = (await itemsByTitle(fx)).get('Foreign ref')!;
    expect(await adminDb.workItemRepo.findMany({ where: { workItemId: item.id } })).toEqual([]);
  });
});

describe('approvePlan — the row pin resolves where TWO rows share a role (AC2)', () => {
  it('names the exact row the role pin cannot distinguish', async () => {
    // The case MOTIR-3045 built the row pin for: two `api` services, and no way
    // for a role to say which one. The ref names the row; approve must keep it.
    const fx = await makeWorkItemFixture();
    const apiOne = await addRepoRow(fx, 'acme-billing-api', 'api');
    const apiTwo = await addRepoRow(fx, 'acme-payments-api', 'api');
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Billing service',
          kind: 'task',
          targetRepositoryRef: apiOne,
        },
      },
      {
        op: 'add',
        proposedFields: {
          title: 'Payments service',
          kind: 'task',
          targetRepositoryRef: apiTwo,
        },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const items = await itemsByTitle(fx);
    // Each leaf names ITS row, not "the api repo" — a role could not have said
    // which of the two, and the ref is what did.
    expect(await refNames(items.get('Billing service')!.id)).toEqual(['acme-billing-api']);
    expect(await refNames(items.get('Payments service')!.id)).toEqual(['acme-payments-api']);
  });
});
