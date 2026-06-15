/**
 * E2E + integration helpers for the reporting-shaped fixture (Subtask 6.7.1) —
 * the accessors the Story 6.7 at-scale specs (6.7.3) assert against.
 *
 * The fixture itself is seeded by `pnpm db:seed:reporting` — ALWAYS through
 * `runReportingSeed()` (a child process), never by importing and calling
 * `seedReportingFixture()` from the Playwright/Vitest runner: the runner process
 * has no Inngest dev server, so a service-layer work-item write here would fire a
 * post-commit job event with no event key. The runner script
 * (`scripts/seed-reporting.ts`) stubs that seam itself, so the child process
 * works in CI and locally with zero setup.
 *
 * Counts: the specs assert against `reportingSeedSizes()` — the SAME env-driven
 * resolver the seed used — so a reduced CI lane (lower SEED_REPORTING_* env on
 * both the seed step and the spec lane) keeps every assertion consistent.
 * `getReportingFixture()` reports the ACTUAL DB counts for census-style asserts.
 *
 * Expected aggregates: `expectedCreatedVsResolved()` and
 * `expectedStatusDistribution()` recompute the report values INDEPENDENTLY of the
 * 6.3 reporting service — in JS, over the rows read back from the DB, using the
 * SAME pure bucket math (`lib/reports/buckets`) the report's SQL `date_trunc`
 * mirrors. The 6.7.3 specs compare the report's SQL-aggregated output against
 * these, so a drift between the JS axis and the SQL grouping (or a regression in
 * the aggregate read) fails the suite.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { bucketAxis, bucketKey, reportWindow, type ReportPeriod } from '@/lib/reports/buckets';
import {
  resolveReportingSeedSizes,
  SEED_REPORTING_DASHBOARD_NAME,
  SEED_REPORTING_OWNER_EMAIL,
  SEED_REPORTING_PASSWORD,
  SEED_REPORTING_PROJECT_IDENTIFIER,
  SEED_REPORTING_PROJECT_NAME,
  SEED_REPORTING_WORKSPACE_NAME,
  type ReportingSeedSizes,
} from '@/scripts/seedReportingFixture';

const execFileAsync = promisify(execFile);

export {
  SEED_REPORTING_DASHBOARD_NAME,
  SEED_REPORTING_OWNER_EMAIL,
  SEED_REPORTING_PASSWORD,
  SEED_REPORTING_PROJECT_IDENTIFIER,
  SEED_REPORTING_PROJECT_NAME,
  SEED_REPORTING_WORKSPACE_NAME,
};
export type { ReportingSeedSizes };

/** The env-driven size knobs — the seed and the specs read the same numbers. */
export function reportingSeedSizes(): ReportingSeedSizes {
  return resolveReportingSeedSizes();
}

/**
 * Run the reporting seed as a child process (idempotent — clears and reseeds its
 * own workspace only). Pass `env` to lower the SEED_REPORTING_* knobs for a
 * reduced lane; everything else inherits the runner shell.
 */
export async function runReportingSeed(env: Record<string, string> = {}): Promise<void> {
  await execFileAsync('pnpm', ['db:seed:reporting'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    timeout: 30 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export interface ReportingFixture {
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  owner: { id: string; email: string };
  /** Actual DB counts over the corpus — the census denominators. */
  counts: {
    items: number;
    resolvedItems: number;
    customFieldValues: number;
    labelLinks: number;
    componentLinks: number;
    savedFilters: number;
    dashboards: number;
    dashboardWidgets: number;
    rules: number;
    enabledRules: number;
  };
}

/**
 * Resolve the seeded fixture from the DB (run `runReportingSeed()` first). Finds
 * the tenant by its fixed owner email + workspace name, then reports the actual
 * collection counts the bounded-read census asserts against.
 */
export async function getReportingFixture(): Promise<ReportingFixture> {
  const owner = await db.user.findUniqueOrThrow({ where: { email: SEED_REPORTING_OWNER_EMAIL } });
  const workspace = await db.workspace.findFirstOrThrow({
    where: { name: SEED_REPORTING_WORKSPACE_NAME, memberships: { some: { userId: owner.id } } },
  });
  const project = await db.project.findFirstOrThrow({
    where: { workspaceId: workspace.id, identifier: SEED_REPORTING_PROJECT_IDENTIFIER },
  });
  const doneKeys = await doneCategoryStatusKeys(project.id, workspace.id);

  const [
    items,
    resolvedItems,
    customFieldValues,
    labelLinks,
    componentLinks,
    savedFilters,
    dashboards,
    dashboardWidgets,
    rules,
    enabledRules,
  ] = await Promise.all([
    db.workItem.count({ where: { projectId: project.id } }),
    db.workItem.count({ where: { projectId: project.id, status: { in: doneKeys } } }),
    db.customFieldValue.count({ where: { workItem: { projectId: project.id } } }),
    db.workItemLabel.count({ where: { workItem: { projectId: project.id } } }),
    db.workItemComponent.count({ where: { workItem: { projectId: project.id } } }),
    db.savedFilter.count({ where: { projectId: project.id } }),
    db.dashboard.count({ where: { workspaceId: workspace.id } }),
    db.dashboardWidget.count({ where: { dashboard: { workspaceId: workspace.id } } }),
    db.automationRule.count({ where: { projectId: project.id } }),
    db.automationRule.count({ where: { projectId: project.id, enabled: true } }),
  ]);

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    owner: { id: owner.id, email: owner.email },
    counts: {
      items,
      resolvedItems,
      customFieldValues,
      labelLinks,
      componentLinks,
      savedFilters,
      dashboards,
      dashboardWidgets,
      rules,
      enabledRules,
    },
  };
}

/** The project's `done`-category status keys (the "resolved" set — done +
 * cancelled in the default workflow). */
export async function doneCategoryStatusKeys(
  projectId: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db.workflowStatus.findMany({
    where: { projectId, workspaceId, category: 'done' },
    select: { key: true },
  });
  return rows.map((r) => r.key);
}

export interface ExpectedCreatedVsResolved {
  period: ReportPeriod;
  daysBack: number;
  windowStart: Date;
  windowEnd: Date;
  /** The full bucket-key axis (no holes), matching the report's. */
  axis: string[];
  /** bucketKey → count of items created in that bucket (within the window). */
  created: Record<string, number>;
  /** bucketKey → count of items resolved (net-into-done) in that bucket. */
  resolved: Record<string, number>;
}

/**
 * Recompute the created-vs-resolved series INDEPENDENTLY of `reportsService` —
 * in JS, over the back-dated rows, with the same pure bucket math the report's
 * SQL `date_trunc` reproduces. `created` buckets `work_item.createdAt`;
 * `resolved` buckets each resolved item's done-transition revision (its latest
 * revision by construction — the seed orders the transition into a `done`-category
 * status LAST), exactly the net-into-done event the report's resolved series
 * counts. Only in-window events count (the report's `[start, end]` rule).
 */
export async function expectedCreatedVsResolved(
  projectId: string,
  workspaceId: string,
  opts: { now: Date; period?: ReportPeriod; daysBack: number },
): Promise<ExpectedCreatedVsResolved> {
  const period: ReportPeriod = opts.period ?? 'week';
  const { start, end } = reportWindow(opts.now, opts.daysBack);
  const axis = bucketAxis(period, start, end);

  const inWindow = (d: Date) => d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
  const created: Record<string, number> = {};
  const resolved: Record<string, number> = {};
  for (const k of axis) {
    created[k] = 0;
    resolved[k] = 0;
  }

  const items = await db.workItem.findMany({
    where: { projectId },
    select: { createdAt: true },
  });
  for (const it of items) {
    if (inWindow(it.createdAt)) created[bucketKey(period, it.createdAt)]! += 1;
  }

  const doneKeys = await doneCategoryStatusKeys(projectId, workspaceId);
  const resolvedAgg = await db.workItemRevision.groupBy({
    by: ['workItemId'],
    where: { workItem: { projectId, status: { in: doneKeys } } },
    _max: { changedAt: true },
  });
  for (const row of resolvedAgg) {
    const at = row._max.changedAt;
    if (at && inWindow(at)) resolved[bucketKey(period, at)]! += 1;
  }

  return {
    period,
    daysBack: opts.daysBack,
    windowStart: start,
    windowEnd: end,
    axis,
    created,
    resolved,
  };
}

/**
 * Recompute the status distribution INDEPENDENTLY of `reportsService` — group
 * the corpus by current `status`, count-descending, the shape the donut widget
 * renders. (Matches the report's group-by-status aggregate.)
 */
export async function expectedStatusDistribution(
  projectId: string,
): Promise<Array<{ status: string; count: number }>> {
  const grouped = await db.workItem.groupBy({
    by: ['status'],
    where: { projectId },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}
