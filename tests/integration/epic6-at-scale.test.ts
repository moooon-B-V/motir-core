import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  automationRulesService,
  type AutomationRuleWriteInput,
} from '@/lib/services/automationRulesService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import { expectedCreatedVsResolved, expectedStatusDistribution } from '../e2e/_helpers/reporting';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

/**
 * The Vitest COMPANION to `tests/e2e/epic6-at-scale.spec.ts` (Story 6.7 ·
 * Subtask 6.7.3) — the QUERY-SHAPE half of the finding-#57 sentinel for Epic 6.
 * Where the E2E proves the scaled behaviour over the real `db:seed:reporting`
 * corpus through the network (the census + the rendered report numbers + the
 * combined a11y sweep), this companion proves the three SHAPE properties that
 * are scale-INDEPENDENT and so don't need the 10k corpus — the same division
 * the shipped at-scale work uses (`board-at-scale` E2E vs. the bounded-read
 * `tests/integration/sprints/data-model.test.ts`):
 *
 *   1. SQL-AGGREGATED REPORTING — the 6.3 reads aggregate IN the database and
 *      return BOUNDED buckets/segments, never the row set (finding #57), AND
 *      their numbers equal the independently-recomputed expectations from the
 *      6.7.1 helpers (correctness, not just boundedness). The paginated
 *      issue/filter read clamps to one page + a true total however large the
 *      requested page.
 *   2. INDEXED PREDICATES — the heavy filter predicates the corpus stresses
 *      (text `contains` via the trigram GIN, the custom-field join, the
 *      created-date window) are served by an INDEX, not a sequential scan.
 *      Asserted deterministically with `SET LOCAL enable_seqscan = off`: the
 *      planner falls back to a Seq Scan only when NO usable index exists, so
 *      "no Seq Scan with seqscan disabled" proves a usable index is present —
 *      a size-INDEPENDENT check (a raw EXPLAIN "index scan at corpus size" is
 *      cost-estimate-dependent and would flake in the reduced CI lane; the
 *      forced-planner form is the deterministic equivalent).
 *   3. THE RULE STORM — a sweep of N transitions over matching items fires the
 *      enabled rule EXACTLY N times even under simulated job retries (the
 *      `(rule, event)` idempotency claim), the emitted job events carry only
 *      IDs (never issue bodies), and every action lands.
 *
 * Real Postgres, no DB mocks (Yue's rule); the one stubbed seam is the Inngest
 * client's `send()` (captureJobEvents) — so the seeding writes' post-commit
 * `work-item/*` events don't hit a non-existent dev server AND the
 * bounded-payload assertion can read them. Drives the services directly.
 */

let cap: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// --------------------------------------------------------------------------
// 1. SQL-aggregated reporting — bounded + correct against the 6.7.1 helpers
// --------------------------------------------------------------------------

describe('epic6-at-scale (6.7.3) — SQL-aggregated reporting', () => {
  // A modest corpus, time-SPREAD across weeks (back-dated through Prisma so the
  // mapping is exact — the seed's documented timestamp deviation in miniature)
  // with a resolved subset, so the created-vs-resolved buckets are non-trivial.
  const ITEMS = 60;
  const DAY = 24 * 60 * 60 * 1000;
  let fx: WorkItemFixture;

  beforeEach(async () => {
    fx = await makeWorkItemFixture({ name: 'Reporting scale', identifier: 'RPT' });
    const now = Date.now();
    for (let i = 0; i < ITEMS; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: i % 3 === 0 ? 'bug' : 'task', title: `Scale ${i}` },
        fx.ctx,
      );
      // Back-date creation across ~7 weekly buckets, all comfortably inside the
      // 70-day window below (no boundary item → no off-by-one flake).
      const createdAt = new Date(now - ((i % 7) * 7 + 3) * DAY);
      await db.workItem.update({ where: { id: item.id }, data: { createdAt } });
      // Resolve ~40% by cancelling (todo→cancelled is a single legal edge into
      // the done CATEGORY — the report's "resolved" predicate).
      if (i % 5 < 2) await workItemsService.updateStatus(item.id, 'cancelled', fx.ctx);
    }
  });

  it('created-vs-resolved aggregates in SQL and equals the independent recompute (bounded buckets, no row set)', async () => {
    const config = { period: 'week' as const, daysBack: 70, cumulative: false };
    const result = await reportsService.getCreatedVsResolved(
      { projectId: fx.projectId },
      config,
      fx.ctx,
    );
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;

    // Bounded (finding #57): the read returns BUCKETS, never the row set, and
    // the bucket count is bounded by the window cap (≤ 120), not the item count.
    expect((result.data as unknown as { items?: unknown }).items).toBeUndefined();
    expect(result.data.buckets.length).toBeLessThanOrEqual(120);
    expect(result.data.buckets.length).toBeLessThan(ITEMS);

    // Correct: the SQL aggregate equals the 6.7.1 helper's independent JS
    // recompute over the same back-dated rows (same `date_trunc` semantics).
    const expected = await expectedCreatedVsResolved(fx.projectId, fx.workspaceId, {
      now: new Date(),
      period: 'week',
      daysBack: 70,
    });
    const createdGot: Record<string, number> = {};
    const resolvedGot: Record<string, number> = {};
    for (const b of result.data.buckets) {
      createdGot[b.date] = b.created;
      resolvedGot[b.date] = b.resolved;
    }
    expect(createdGot).toEqual(expected.created);
    expect(resolvedGot).toEqual(expected.resolved);
    // Sanity: the corpus actually exercised both series in-window.
    expect(Object.values(expected.created).reduce((a, b) => a + b, 0)).toBe(ITEMS);
    expect(Object.values(expected.resolved).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('status distribution aggregates in SQL and equals the independent recompute (bounded segments)', async () => {
    const result = await reportsService.getDistribution(
      { projectId: fx.projectId },
      'status',
      fx.ctx,
    );
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;

    // Segments, never items; bounded by the status vocabulary (≤ 6 defaults).
    expect((result.data as unknown as { items?: unknown }).items).toBeUndefined();
    expect(result.data.segments.length).toBeLessThanOrEqual(6);

    // Compare as a status→count MAP (robust to count-tie ordering: the DTO
    // breaks ties by label, the helper by status key).
    const got = Object.fromEntries(result.data.segments.map((s) => [s.id, s.count]));
    const expected = Object.fromEntries(
      (await expectedStatusDistribution(fx.projectId)).map((r) => [r.status, r.count]),
    );
    expect(got).toEqual(expected);
    expect(Object.values(got).reduce((a, b) => Number(a) + Number(b), 0)).toBe(ITEMS);
  });

  it('the paginated issue read clamps to one page + a true total however large the requested page (finding #57)', async () => {
    const huge = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, pageSize: 100_000 },
      fx.ctx,
    );
    // Never loads the whole set: the page is clamped to the server cap, but the
    // total tracks the real count for the "N issues" header / pager.
    expect(huge.total).toBe(ITEMS);
    expect(huge.pageSize).toBe(ISSUE_LIST_PAGE_SIZE);
    expect(huge.items.length).toBe(Math.min(ITEMS, ISSUE_LIST_PAGE_SIZE));
    expect(huge.items.length).toBeLessThan(ITEMS);
  });
});

// --------------------------------------------------------------------------
// 2. Indexed predicates — EXPLAIN with the planner forced off Seq Scan
// --------------------------------------------------------------------------

describe('epic6-at-scale (6.7.3) — heavy predicates are index-served, not Seq Scan', () => {
  let fx: WorkItemFixture;
  let fieldId: string;
  let optionId: string;

  beforeEach(async () => {
    fx = await makeWorkItemFixture({ name: 'Index scale', identifier: 'IDX' });
    // A select custom field + option for the CF-join predicate.
    const field = await db.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'area',
        label: 'Area',
        fieldType: 'select',
        position: 'a0',
      },
    });
    fieldId = field.id;
    const option = await db.customFieldOption.create({
      data: { fieldId, label: 'Frontend', position: 'a0' },
    });
    optionId = option.id;

    // Enough rows + ANALYZE so the planner has real stats (a usable index then
    // wins decisively once Seq Scan is penalised).
    for (let i = 0; i < 80; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `Indexable subject ${i}` },
        fx.ctx,
      );
      if (i % 2 === 0) {
        await db.customFieldValue.create({
          data: {
            workspaceId: fx.workspaceId,
            workItemId: item.id,
            fieldId,
            valueOptionId: optionId,
          },
        });
      }
    }
    await db.$executeRawUnsafe('ANALYZE "work_item"');
    await db.$executeRawUnsafe('ANALYZE "custom_field_value"');
  });

  /**
   * EXPLAIN the query with Seq Scan penalised out of the plan, then return the
   * plan text. With `enable_seqscan = off` the planner emits a Seq Scan only
   * when no usable index exists — so asserting NO `Seq Scan on <table>` proves a
   * usable index is present, independent of table size.
   */
  async function explain(sql: string, params: unknown[]): Promise<string> {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN ${sql}`, ...params);
    });
    return rows.map((r) => Object.values(r)[0]).join('\n');
  }

  it('text `contains` rides the trigram GIN index — no Seq Scan on work_item', async () => {
    // Only the gin_trgm_ops index on (title, descriptionMd) can serve a bare
    // ILIKE %…% — no other predicate narrows it, so a Seq Scan here would mean
    // the trigram index is missing/unusable.
    const plan = await explain(`SELECT 1 FROM "work_item" w WHERE w."title" ILIKE $1`, [
      '%dexable subj%',
    ]);
    expect(plan, plan).not.toMatch(/Seq Scan on work_item/);
  });

  it('the created-date window rides a projectId index — no Seq Scan on work_item', async () => {
    const plan = await explain(
      `SELECT 1 FROM "work_item" w WHERE w."projectId" = $1 AND w."createdAt" >= $2 AND w."createdAt" <= $3`,
      [fx.projectId, new Date(Date.now() - 30 * 24 * 3600 * 1000), new Date()],
    );
    expect(plan, plan).not.toMatch(/Seq Scan on work_item/);
  });

  it('the custom-field select join rides the [fieldId, valueOptionId] index — no Seq Scan on custom_field_value', async () => {
    const plan = await explain(
      `SELECT 1 FROM "custom_field_value" v WHERE v."field_id" = $1 AND v."value_option_id" = $2`,
      [fieldId, optionId],
    );
    expect(plan, plan).not.toMatch(/Seq Scan on custom_field_value/);
  });
});

// --------------------------------------------------------------------------
// 3. The rule storm — exactly-once under retry, bounded payloads, actions land
// --------------------------------------------------------------------------

describe('epic6-at-scale (6.7.3) — the rule storm fires exactly once under retry', () => {
  const N = 12;
  let fx: WorkItemFixture;

  beforeEach(async () => {
    fx = await makeWorkItemFixture({ name: 'Automation scale', identifier: 'AUT' });
  });

  function transitionedRule(): AutomationRuleWriteInput {
    return {
      name: 'Label swept items',
      triggerType: 'transitioned',
      triggerConfig: { fromStatusId: null, toStatusId: 'in_progress' },
      conditionFilterParam: null,
      actions: [{ type: 'add_label', name: 'swept' }],
    };
  }

  it('a bulk transition sweep fires the rule exactly N times (no loss, no duplicates under retries) with bounded payloads', async () => {
    const rule = await automationRulesService.create(
      fx.project.identifier,
      transitionedRule(),
      fx.ctx,
    );

    // The sweep: transition N items todo→in_progress. Each commit emits ONE
    // `work-item/transitioned` event (captured off the stubbed client).
    const itemIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `Sweep ${i}` },
        fx.ctx,
      );
      itemIds.push(item.id);
      await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    }

    const transitioned = cap.events.filter((e) => e.name === 'work-item/transitioned');
    expect(transitioned).toHaveLength(N);

    // Bounded payload (finding #57 for the job lane): the event carries IDs, not
    // the issue body — no title / description rides the event.
    const allowed = new Set([
      'workspaceId',
      'workItemId',
      'actorId',
      'fromStatusKey',
      'toStatusKey',
      'revisionId',
      'viaAutomationRuleId',
    ]);
    for (const evt of transitioned) {
      const data = evt.data as Record<string, unknown>;
      expect(Object.keys(data).every((k) => allowed.has(k))).toBe(true);
      expect('title' in data).toBe(false);
      expect('descriptionMd' in data).toBe(false);
    }

    // Drive the engine for every event — TWICE each (a redelivery / retry of the
    // SAME eventId). The `(rule, event)` idempotency claim makes the second a
    // no-op, so the rule fires exactly N times across 2N deliveries.
    for (const evt of transitioned) {
      const data = evt.data as {
        workItemId: string;
        revisionId: string;
        fromStatusKey: string;
        toStatusKey: string;
      };
      const input = {
        trigger: 'transitioned' as const,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: data.workItemId,
        fromStatusKey: data.fromStatusKey,
        toStatusKey: data.toStatusKey,
        // The engine claims on eventId; a redelivery reuses it (here: the
        // revision id, stable per transition).
        eventId: `evt-${data.revisionId}`,
      };
      const first = await automationEngineService.runForEvent(input);
      expect(first).toMatchObject({ matched: 1, succeeded: 1, failed: 0 });
      const retry = await automationEngineService.runForEvent(input);
      // The retry is claimed-away: it matches the rule but executes nothing new.
      expect(retry.succeeded).toBe(0);
    }

    // Exactly N execution audit rows for the rule — one per item, no duplicates.
    const executions = await db.automationRuleExecution.findMany({ where: { ruleId: rule.id } });
    expect(executions).toHaveLength(N);
    expect(executions.every((e) => e.status === 'success')).toBe(true);

    // Every action landed: all N items carry the 'swept' label.
    const labelled = await db.workItemLabel.count({
      where: { workItemId: { in: itemIds }, label: { nameLower: 'swept' } },
    });
    expect(labelled).toBe(N);
  });
});
