// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { PrismaPg } from '@prisma/adapter-pg';
import { $Enums, PrismaClient, type Prisma } from '@/generated/prisma/client';
import en from '@/messages/en.json';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { PLAN_STATUS_DTO_VALUES, type WorkItemPlanHistoryEntryDto } from '@/lib/dto/plans';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { createTestProject, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  PlanHistorySection,
  relationSentence,
} from '@/app/(authed)/items/[key]/_components/PlanHistorySection';
import { PLAN_HISTORY_FIRST_PAGE } from '@/app/(authed)/items/[key]/_components/planHistoryPaging';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — a work item shows every plan that shaped it
// (Story MOTIR-5542 · Subtask MOTIR-5548)
// ═══════════════════════════════════════════════════════════════════════════
//
// Each card proved its own piece against input it built itself: the read
// (MOTIR-5546, `planHistoryRead.test.ts`) asserts DTOs, the section (MOTIR-5547,
// `tests/components/plan-history-section.test.tsx`) renders hand-built DTOs. This
// file stands at the JOIN and adds the guards a coverage number cannot see:
//
//   1. THE SEAM. Plans driven through `plansService` (create → append → approve /
//      decline, so `materialize`'s write-back is the real one), read through the
//      SERVICE, and that exact DTO rendered by the shipped section.
//   2. CROSS-TENANT. A plan in another project or another workspace that names
//      this card through `parentRef` never surfaces.
//   3. THE NO-PLAN PATH. Nearly every card is this case, so its cost is pinned:
//      the row read is never reached, and the page probe is ONE statement.
//   4. TOTALITY. Every `PlanStatus` value — read from the Prisma enum, not
//      listed — maps to a relation sentence, and the three tenses never share one.
//
// ⚠️ happy-dom + REAL POSTGRES in one file, deliberately: the seam ends at a
// screen (`tests/permissions/customRolesStoryGate.integration.test.tsx` and
// `tests/integration/approvals/approval-overlay-story-gate.test.tsx` are the
// precedent). The capability gate is not repeated here — the service refusal is
// `planHistoryRead.test.ts`'s and the page's skipped read is
// `tests/components/item-detail-reads.test.tsx`'s.

const NOW = new Date(Date.UTC(2026, 0, 1, 12));

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Status = (typeof PLAN_STATUS_DTO_VALUES)[number];
type Proposals = Parameters<typeof plansService.addProposals>[1];

// Every plan gets its own creation second, in the order a test creates it: the
// read orders by `plan.createdAt` and back-to-back plans can share a millisecond.
const BASE = Date.UTC(2025, 11, 1);
let tick = 0;
async function stamp(planId: string): Promise<void> {
  tick += 1;
  await adminDb.plan.update({
    where: { id: planId },
    data: { createdAt: new Date(BASE + tick * 1000) },
  });
}

async function seed(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

async function planWith(
  fx: WorkItemFixture,
  proposals: Proposals,
  status: Exclude<Status, 'stale' | 'generating'>,
  title: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  await stamp(plan.id);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  if (status === 'declined') await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

const children = (parent: string, n: number): Proposals =>
  Array.from({ length: n }, (_, i) => ({
    op: 'add' as const,
    proposedFields: { title: `Child ${i + 1}`, kind: 'subtask' as const },
    parentRef: parent,
  }));

async function createdBy(planId: string, title: string): Promise<string> {
  const rows = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const row = rows.find((r) => (r.proposedFields as { title?: string } | null)?.title === title);
  if (!row?.workItemId) throw new Error(`no materialized add titled ${title} on ${planId}`);
  return row.workItemId;
}

const history = (fx: WorkItemFixture, card: string, limit = PLAN_HISTORY_FIRST_PAGE) =>
  plansService.listPlanHistoryForWorkItem(fx.projectId, card, { limit }, fx.ctx);

describe('SEAM — plans driven through plansService, read through the service, rendered by the section', () => {
  it('shows the rows the database holds, oldest first, one per plan, with the fold and the child count', async () => {
    const fx = await makeWorkItemFixture();
    const a = await planWith(
      fx,
      [{ op: 'add', proposedFields: { title: 'The card', kind: 'task' } }],
      'approved',
      'Plan A',
    );
    const card = await createdBy(a, 'The card');
    const b = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'Renamed' } }],
      'approved',
      'Plan B',
    );
    const c = await planWith(fx, children(card, 3), 'declined', 'Plan C');
    // ONE plan holding a change AND two children — the fold.
    const d = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'Renamed again' } }, ...children(card, 2)],
      'planned',
      'Plan D',
    );

    const page = await history(fx, card);
    expect(page.nextCursor).toBeNull();
    expect(
      page.items.map((e) => [e.planId, e.planStatus, e.relation.op, e.relation.childCount]),
    ).toEqual([
      [a, 'approved', 'add', 0],
      [b, 'approved', 'modify', 0],
      [c, 'declined', null, 3],
      [d, 'planned', 'modify', 2],
    ]);
    expect(page.items[3]!.proposalIds.children).toHaveLength(2);

    renderWithIntl(<PlanHistorySection itemId={card} identifier="PROD-9" initial={page} />, {
      now: NOW,
    });
    const list = screen.getByRole('list', { name: 'Plans that shaped PROD-9' });
    const rows = within(list).getAllByRole('link');
    // One row per PLAN — eight proposals, four rows.
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(
      [a, b, c, d].map((id) => `/plans/${id}`),
    );
    expect(rows.map((row) => within(row).getByText(/^Plan [A-D]$/).textContent)).toEqual([
      'Plan A',
      'Plan B',
      'Plan C',
      'Plan D',
    ]);
    expect(within(rows[0]!).getByText('Created this item')).toBeTruthy();
    expect(within(rows[0]!).getByText('Approved')).toBeTruthy();
    expect(within(rows[1]!).getByText('Changed this item')).toBeTruthy();
    // The declined plan's children never became work — the sentence says so.
    expect(
      within(rows[2]!).getByText('Proposed 3 work items under this item — not added'),
    ).toBeTruthy();
    expect(within(rows[2]!).getByText('Declined')).toBeTruthy();
    expect(
      within(rows[3]!).getByText('Proposes changes to this item, and 2 work items under it'),
    ).toBeTruthy();
    expect(within(rows[3]!).getByText('Planned')).toBeTruthy();
  });
});

describe('CROSS-TENANT — a plan elsewhere that names this card through parentRef never surfaces', () => {
  it('another project in the workspace, and another workspace, stay out of the history', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'Home card');
    const mine = await planWith(fx, children(card, 1), 'planned', 'Mine');

    // Both foreign rows are unreachable through `addProposals`, which validates
    // `parentRef` against the plan's own project — so they are written directly,
    // exactly the rows a bug in that validation (or a hand edit) would leave.
    const two = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'TWO',
    });
    const otherProject = await adminDb.plan.create({
      data: { workspaceId: fx.workspaceId, projectId: two.id, status: 'planned', title: 'Two' },
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: otherProject.id,
        op: 'add',
        parentRef: card,
        proposedFields: { title: 'Foreign child', kind: 'subtask' },
      },
    });
    const globex = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    const otherWorkspace = await adminDb.plan.create({
      data: {
        workspaceId: globex.workspaceId,
        projectId: globex.projectId,
        status: 'approved',
        title: 'Globex',
      },
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: globex.workspaceId,
        planId: otherWorkspace.id,
        op: 'add',
        parentRef: card,
        proposedFields: { title: 'Foreign child', kind: 'subtask' },
      },
    });

    const page = await history(fx, card);
    expect(page.items.map((e) => e.planId)).toEqual([mine]);
    expect(page.items[0]!.relation.childCount).toBe(1);

    // And the other way round: the foreign tenant, asking about this card's id,
    // never sees this workspace's plan.
    const theirs = await plansService.listPlanHistoryForWorkItem(
      globex.projectId,
      card,
      {},
      globex.ctx,
    );
    expect(theirs.items.map((e) => e.planId)).not.toContain(mine);
  });
});

describe('THE NO-PLAN PATH — what nearly every item page pays', () => {
  it('never reaches the row read, and the page probe is ONE statement', async () => {
    const fx = await makeWorkItemFixture();
    const untouched = await seed(fx, 'Untouched');
    const other = await seed(fx, 'Planned elsewhere');
    // Noise: the project HAS plans, just none naming the untouched card.
    await planWith(fx, children(other, 2), 'planned', 'Elsewhere');

    const rowRead = vi.spyOn(planItemRepository, 'findHistoryByWorkItemId');
    expect(await history(fx, untouched)).toEqual({ items: [], nextCursor: null });
    expect(rowRead).not.toHaveBeenCalled();
    // The positive control: a card WITH a plan does reach it, once.
    await history(fx, other);
    expect(rowRead).toHaveBeenCalledTimes(1);

    // The probe itself, on a client that logs its statements. Bound the way the
    // service binds it (the same GUCs `withWorkspaceServiceContext` sets), and
    // run as the app role `DATABASE_URL` carries in a worker — running it as the
    // owner would take the code under test off the restricted role.
    const loggedDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: string[] = [];
    loggedDb.$on('query', (e) => queries.push(e.query));
    let plans: unknown;
    try {
      plans = await loggedDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${fx.ownerId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.project_id', ${''}, true)`;
        queries.length = 0; // the binding is setup, not the read under measurement
        return planRepository.findPageRelatedToWorkItem(
          untouched,
          fx.workspaceId,
          fx.projectId,
          PLAN_HISTORY_FIRST_PAGE + 1,
          null,
          tx as unknown as Prisma.TransactionClient,
        );
      });
    } finally {
      await loggedDb.$disconnect();
    }
    expect(plans).toEqual([]);
    const reads = queries.filter((q) => !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(q));
    expect(reads).toHaveLength(1);
  });
});

describe('TOTALITY — every PlanStatus maps to a relation sentence', () => {
  // The population is the PRISMA ENUM, not a list in this file: a sixth status
  // added to the schema appears here on its own and must render a sentence.
  const STATUSES = Object.values($Enums.PlanStatus);
  const t = createTranslator({
    locale: 'en',
    messages: en,
    namespace: 'issueViews',
  } as never) as unknown as Parameters<typeof relationSentence>[1];
  const RELATIONS: WorkItemPlanHistoryEntryDto['relation'][] = [
    { op: 'modify', childCount: 0 },
    { op: 'modify', childCount: 2 },
    { op: 'remove', childCount: 0 },
    { op: 'remove', childCount: 2 },
    { op: null, childCount: 2 },
  ];
  const entryOf = (
    planStatus: Status,
    relation: WorkItemPlanHistoryEntryDto['relation'],
  ): WorkItemPlanHistoryEntryDto => ({
    planId: 'p',
    planTitle: null,
    planStatus,
    createdAt: NOW.toISOString(),
    plannedAt: null,
    decidedAt: null,
    decidedById: null,
    decidedByName: null,
    author: { source: null, harness: null, model: null },
    relation,
    proposalIds: { self: null, children: [] },
  });

  it('the DTO status vocabulary IS the schema enum', () => {
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual([...STATUSES].sort());
  });

  const planHistorySentences = new Set(
    Object.entries(en.issueViews)
      .filter(([key]) => key.startsWith('planHistory'))
      .map(([, value]) => value),
  );

  for (const status of STATUSES) {
    it(`${status}: every relation renders a real sentence from the catalog`, () => {
      for (const relation of RELATIONS) {
        const sentence = relationSentence(entryOf(status, relation), t);
        // A missing mapping or key comes back as the key path (next-intl's
        // fallback) or `undefined` — never as copy.
        expect(typeof sentence, `${status} ${JSON.stringify(relation)}`).toBe('string');
        expect(sentence).not.toMatch(/issueViews|planHistory/);
        expect(sentence.length).toBeGreaterThan(10);
      }
    });
  }

  it('the three tenses never share a sentence — a declined plan never reads as a change', () => {
    expect(planHistorySentences.size).toBeGreaterThan(0);
    for (const relation of RELATIONS) {
      const sentence = (status: Status) => relationSentence(entryOf(status, relation), t);
      const tenses = new Set([sentence('planned'), sentence('approved'), sentence('declined')]);
      expect(tenses.size, JSON.stringify(relation)).toBe(3);
      // The proposing tense is ONE tense: a stale or generating plan says the
      // same thing a planned one does.
      expect(sentence('generating')).toBe(sentence('planned'));
      expect(sentence('stale')).toBe(sentence('planned'));
    }
  });
});
