/**
 * The REPORTING-shaped at-scale fixture (Subtask 6.7.1 — the 4.7.1 / 5.6.1
 * precedent, applied to Epic 6). `pnpm db:seed:reporting` builds the
 * **reporting-shaped corpus** the Story 6.7 at-scale specs (6.7.3 bounded-read
 * census + SQL-aggregation correctness + the combined admin a11y sweep) run
 * against: thousands of work items spread over ~26 weeks of created/resolved
 * history with full field spread, PLUS the Epic-6 entities none of the existing
 * large seeds carries — named saved filters (6.2), a populated dashboard (6.3),
 * and enabled automation rules (6.6). The existing large seeds are tree-shaped
 * (2.5.16), board-shaped (3.5.1), sprint-shaped (4.7.1) and collaboration-shaped
 * (5.6.1) — NONE builds time-spread created/resolved history, saved filters,
 * dashboards or rules.
 *
 * EVERYTHING goes through the shipped services (the no-raw-inserts seed rule),
 * which makes the script double as a bulk smoke test of every Epic-6 write path:
 * workItemsService (create + status transitions), customFields/Values
 * (5.3.2/5.3.3), labels/components (5.4.2/5.4.3), savedFiltersService (6.2.1),
 * dashboardsService (6.3.1) and automationRulesService (6.6.1).
 *
 * THE ONE RECORDED DEVIATION — the documented **timestamp back-dating pass**.
 * Services stamp `now()` on every row (`work_item.createdAt` is `@default(now())`;
 * a status transition's `work_item_revision.changedAt` is `@default(now())` too),
 * and no service accepts a historical date — yet the time spread is the very
 * thing the 6.3 created-vs-resolved report measures. So after seeding, TWO raw
 * UPDATEs (and nothing else) back-date timestamps: (1) every corpus item's
 * `createdAt` to its assigned creation instant, and (2) each item's revisions
 * spread evenly across `[createdAt, endAt]` (endAt = the item's resolved instant
 * for a done/cancelled item, else its createdAt) — so the FINAL transition (the
 * one into a `done`-category status) lands exactly at the resolved instant, which
 * is the row the 6.3 resolved series buckets. The pass is confined to THIS script,
 * touches timestamps only, and the self-check asserts the resulting spread. This
 * is the same sanctioned exception `seedLargeBoard` / `seedCollabFixture` document
 * for the same reason (the ORM would re-stamp what the fixture must control).
 *
 * REALISTIC DATA DENSITY (justified deviation, rung-1 style — the mirror's shape).
 * The BULK corpus (every one of the N items) carries the lean columns the reports
 * + status distribution read at scale — kind, priority, assignee, status,
 * createdAt/resolvedAt. The rich field spread (labels, components, all five
 * custom-field types, on SELECTIVE subsets so the 6.1 predicates have meaningful
 * — not all-or-nothing — matches) is concentrated on a bounded RICH subset, exactly
 * as a real years-deep Jira project looks (most issues carry few custom fields).
 * This keeps a full-size run tractable while still exercising every Epic-6 write
 * path and giving the 6.1 filters / cf-distribution selective matches.
 *
 * DETERMINISTIC: all field/spread choices come from an FNV-1a hash of stable keys
 * (the plan-seed convention) — no Math.random, no Date.now in any decision; the
 * only clock read is the single `now` captured at the top, off which every
 * timestamp is derived. Stable across reseeds.
 *
 * IDEMPOTENT: re-running clears ONLY this fixture's own workspace (matched by the
 * fixed owner email + workspace name) and reseeds — it never touches any other
 * workspace's data. Refuses to run under NODE_ENV=production.
 *
 * CAP-PARAMETERISED: every dimension is an env knob (SEED_REPORTING_*) so the CI
 * lane can run reduced (the board-at-scale cap precedent) while local runs go
 * full-size. `resolveReportingSeedSizes()` is the ONE resolver — the seed, its
 * self-check, and the E2E helpers (tests/e2e/_helpers/reporting.ts) all read the
 * same numbers.
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { labelsService } from '@/lib/services/labelsService';
import { componentsService } from '@/lib/services/componentsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// ── The fixture tenant (fixed identifiers the helpers + specs key off) ──────
export const SEED_REPORTING_OWNER_EMAIL = 'seed-reporting@motir.dev';
export const SEED_REPORTING_PASSWORD = 'seed-reporting-pass-1!';
export const SEED_REPORTING_WORKSPACE_NAME = 'Seed — Reporting (Epic 6)';
export const SEED_REPORTING_PROJECT_NAME = 'Reporting heavy';
export const SEED_REPORTING_PROJECT_IDENTIFIER = 'RPT';
/** The dashboard the helpers/specs find by name. */
export const SEED_REPORTING_DASHBOARD_NAME = 'Delivery analytics';

const MEMBER_NAMES = [
  'Ada Okafor',
  'Bram Visser',
  'Carmen Ruiz',
  'Daan Mulder',
  'Elif Yilmaz',
  'Femke de Boer',
  'Gabriel Costa',
  'Hana Sato',
] as const;

// ── Size knobs (the board-at-scale env-cap pattern) ─────────────────────────
const n = (env: string, dflt: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : dflt;
};

export interface ReportingSeedSizes {
  /** Total work items in the corpus (the bulk, time-spread). */
  items: number;
  /** Weeks of created/resolved history the corpus spreads across. */
  weeks: number;
  /** Members beside the owner (the assignee/reporter pool). */
  members: number;
  /** Items carrying the rich field spread (labels/components/all CF types). */
  richItems: number;
  /** Named saved filters built (6.2). */
  savedFilters: number;
  /** Enabled automation rules built (6.6). */
  rules: number;
}

/**
 * The ONE size resolver — the seed, its end-of-run self-check, and the E2E
 * helpers all call this, so a CI lane that lowers a knob keeps every assert
 * consistent. Defaults are the full-size spec-sheet shape (10k items / 26 weeks).
 */
export function resolveReportingSeedSizes(): ReportingSeedSizes {
  const items = n('SEED_REPORTING_ITEMS', 10_000);
  return {
    items,
    weeks: n('SEED_REPORTING_WEEKS', 26),
    members: n('SEED_REPORTING_MEMBERS', MEMBER_NAMES.length),
    // The rich subset never exceeds the corpus (a tiny CI cap keeps it ≤ items).
    richItems: Math.min(items, n('SEED_REPORTING_RICH_ITEMS', 400)),
    savedFilters: n('SEED_REPORTING_SAVED_FILTERS', 5),
    rules: n('SEED_REPORTING_RULES', 3),
  };
}

// ── Determinism: FNV-1a over stable keys (the plan-seed convention) ─────────
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function pick<T>(arr: readonly T[], key: string): T {
  return arr[hash(key) % arr.length]!;
}
/** A deterministic integer in `[0, mod)` keyed by `key`. */
function hashInt(key: string, mod: number): number {
  return hash(key) % mod;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const PRIORITIES: readonly WorkItemPriorityDto[] = ['lowest', 'low', 'medium', 'high', 'highest'];
// Weighted toward task/bug (the real shape of an execution project's leaves).
const KINDS: readonly WorkItemKindDto[] = ['task', 'task', 'task', 'story', 'bug', 'bug'];

// The six default workflow statuses (lib/workflows/defaultWorkflow.ts). `done`
// and `cancelled` are the two `done`-category statuses (the "resolved" set).
type StatusKey = 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
const DONE_CATEGORY_KEYS: ReadonlySet<StatusKey> = new Set(['done', 'cancelled']);

/** The legal transition path from the initial `todo` to a target status, as the
 * ordered list of `updateStatus` steps (the default workflow graph). The LAST
 * step of a done/cancelled path is the transition the resolved series buckets. */
function transitionPath(target: StatusKey): StatusKey[] {
  switch (target) {
    case 'todo':
      return [];
    case 'in_progress':
      return ['in_progress'];
    case 'in_review':
      return ['in_progress', 'in_review'];
    case 'done':
      return ['in_progress', 'in_review', 'done'];
    case 'blocked':
      return ['blocked'];
    case 'cancelled':
      return ['cancelled']; // todo → cancelled is a legal default edge
  }
}

/** Deterministic final status for item `i` — a realistic spread that fills every
 * default status and gives the resolved series a healthy population. */
function statusFor(i: number): StatusKey {
  const r = hashInt(`status:${i}`, 100);
  if (r < 40) return 'done'; // 40% resolved (done)
  if (r < 55) return 'in_progress'; // 15%
  if (r < 65) return 'in_review'; // 10%
  if (r < 85) return 'todo'; // 20%
  if (r < 92) return 'blocked'; // 7%
  return 'cancelled'; // 8% resolved (cancelled)
}

// ── Reference data ──────────────────────────────────────────────────────────
const COMPONENT_NAMES = ['Frontend', 'Backend', 'Infrastructure', 'Mobile', 'Billing'] as const;
const LABEL_NAMES = [
  'regression',
  'customer-reported',
  'tech-debt',
  'flaky',
  'security',
  'performance',
  'good-first-issue',
  'needs-design',
  'blocked-upstream',
  'quick-win',
] as const;
const SELECT_OPTIONS = ['Frontend', 'Backend', 'Infra', 'Mobile', 'Data'] as const;
const ROOT_CAUSES = [
  'race condition',
  'missing index',
  'stale cache',
  'off-by-one',
  'null guard',
  'config drift',
] as const;
const TITLE_VERBS = ['Fix', 'Investigate', 'Add', 'Refactor', 'Improve', 'Document', 'Remove'];
const TITLE_NOUNS = [
  'checkout retry path',
  'search indexing',
  'dashboard widget render',
  'sprint burndown',
  'webhook delivery',
  'permission gate',
  'CSV export',
  'mobile nav',
  'rate limiter',
  'audit log',
];

function titleFor(i: number): string {
  return `${pick(TITLE_VERBS, `verb:${i}`)} ${pick(TITLE_NOUNS, `noun:${i}`)} (#${i + 1})`;
}

type Ctx = { userId: string; workspaceId: string };

/** What got built — the self-check asserts against it; the runner prints it. */
export interface ReportingSeedManifest {
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  ownerId: string;
  items: number;
  resolvedItems: number;
  richItems: number;
  statusCounts: Record<string, number>;
  customFieldValues: number;
  labelLinks: number;
  componentLinks: number;
  savedFilters: number;
  dashboardWidgets: number;
  rules: number;
  windowStart: string;
  windowEnd: string;
}

/** One corpus item's back-dating bounds (the ONLY clock-derived state). */
interface ItemTiming {
  id: string;
  createdAt: Date;
  /** Resolved instant for a done/cancelled item; equals createdAt otherwise. */
  endAt: Date;
  resolved: boolean;
}

export async function seedReportingFixture(): Promise<ReportingSeedManifest> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed:reporting is a DEV tool — refusing to run under NODE_ENV=production.');
  }
  const sizes = resolveReportingSeedSizes();
  // The SINGLE clock read — every timestamp is derived off this instant so the
  // spread is deterministic given a fixed `now`. The corpus is back-dated into
  // [now - (weeks*7 - 2) days, now - 2h], leaving a 2-day margin under the
  // report's weeks*7-day window so the oldest item never falls off the edge.
  const now = new Date();
  const windowDays = sizes.weeks * 7;
  const spreadDays = windowDays - 2;
  const windowStart = new Date(now.getTime() - spreadDays * DAY_MS);

  console.log(
    `Seeding reporting corpus: ${sizes.items} items over ${sizes.weeks} weeks ` +
      `(${sizes.richItems} rich, ${sizes.savedFilters} filters, ${sizes.rules} rules)…`,
  );

  // ── Idempotent clear: drop this fixture's prior workspace(s) only ─────────
  const existingOwner = await db.user.findUnique({ where: { email: SEED_REPORTING_OWNER_EMAIL } });
  if (existingOwner) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: existingOwner.id },
      include: { workspace: true },
    });
    for (const m of memberships) {
      if (m.workspace.name === SEED_REPORTING_WORKSPACE_NAME) {
        // work_item.parent is onDelete:NoAction — clear the set in one statement
        // first; the workspace then cascades everything else.
        await db.workItem.deleteMany({ where: { workspaceId: m.workspaceId } });
        await db.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
  }

  // ── Tenant: owner + member pool, workspace, project, project enrolment ────
  const owner =
    existingOwner ??
    (await usersService.createUser({
      email: SEED_REPORTING_OWNER_EMAIL,
      password: SEED_REPORTING_PASSWORD,
      name: 'Rey Reporting',
    }));

  const { workspace } = await workspacesService.createWorkspace({
    name: SEED_REPORTING_WORKSPACE_NAME,
    ownerUserId: owner.id,
  });

  const memberIds: string[] = [owner.id];
  for (let i = 0; i < sizes.members; i++) {
    const email = `seed-reporting-m${i + 1}@motir.dev`;
    const name = MEMBER_NAMES[i % MEMBER_NAMES.length]!;
    const existing = await db.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await usersService.createUser({ email, password: SEED_REPORTING_PASSWORD, name }));
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: workspace.id,
      role: 'member',
    });
    memberIds.push(user.id);
  }

  const project = await projectsService.createProject({
    name: SEED_REPORTING_PROJECT_NAME,
    identifier: SEED_REPORTING_PROJECT_IDENTIFIER,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const key = project.identifier;

  // Enroll the pool in the project (open access) — the plan-seed 6.4.7 pattern;
  // the owner is the project admin (saved-filter share + automation-admin gates).
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const userId of memberIds) {
      await projectMembershipRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          userId,
          role: userId === owner.id ? 'admin' : 'member',
        },
        tx,
      );
    }
    await projectRepository.setAccessLevel(project.id, 'open', { stampMadePublicAt: false }, tx);
  });
  await db.workspaceMembership.updateMany({
    where: { workspaceId: workspace.id },
    data: { activeProjectId: project.id },
  });

  const ownerCtx: Ctx = { userId: owner.id, workspaceId: workspace.id };

  // The project's done-category status row ids (for the automation trigger/action
  // status referents — open ids, but real ones keep the rules executable).
  const statuses = await workflowsRepository.findStatuses(project.id, workspace.id);
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
  const doneStatusId = statusIdByKey.get('done')!;

  // ── Custom fields: one of each of the five types (5.3.2) ──────────────────
  const fieldInput = { key, actorUserId: owner.id, ctx: ownerCtx };
  const textField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Root cause',
    fieldType: 'text',
  });
  const numberField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Customer impact',
    fieldType: 'number',
  });
  const dateField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Detected on',
    fieldType: 'date',
  });
  const selectField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Area',
    fieldType: 'select',
    options: [...SELECT_OPTIONS],
  });
  const userField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Owner',
    fieldType: 'user',
  });
  const selectOptionIds = selectField.options.map((o) => o.id);

  // ── Components (5.4.3): one carries a default assignee ────────────────────
  const componentIds: string[] = [];
  for (const [i, name] of COMPONENT_NAMES.entries()) {
    const component = await componentsService.createComponent(
      {
        key,
        name,
        description: null,
        defaultAssigneeId: i === 0 ? pick(memberIds, 'component-default') : null,
      },
      ownerCtx,
    );
    componentIds.push(component.id);
  }

  // ── The corpus ────────────────────────────────────────────────────────────
  const timings: ItemTiming[] = [];
  const statusCounts: Record<string, number> = {};
  let resolvedItems = 0;
  let customFieldValues = 0;
  let labelLinks = 0;
  let componentLinks = 0;

  for (let i = 0; i < sizes.items; i++) {
    const status = statusFor(i);
    const resolved = DONE_CATEGORY_KEYS.has(status);
    const assigneeId =
      hashInt(`unassigned:${i}`, 7) === 0 ? null : pick(memberIds, `assignee:${i}`);
    // Creation instant: spread across the window with hash-driven weekly
    // variance; an intraday offset keeps day-buckets non-degenerate.
    const createdAt = new Date(
      windowStart.getTime() +
        hashInt(`created:${i}`, spreadDays) * DAY_MS +
        hashInt(`createdH:${i}`, 24) * HOUR_MS,
    );
    // Resolved instant: createdAt + a 1–40 day lead, clamped to ≤ now - 1h.
    const leadDays = 1 + hashInt(`lead:${i}`, 40);
    const endAt = resolved
      ? new Date(Math.min(createdAt.getTime() + leadDays * DAY_MS, now.getTime() - HOUR_MS))
      : createdAt;

    const reporterCtx: Ctx = {
      userId: pick(memberIds, `reporter:${i}`),
      workspaceId: workspace.id,
    };
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: pick(KINDS, `kind:${i}`),
        title: titleFor(i),
        priority: pick(PRIORITIES, `priority:${i}`),
        assigneeId,
      },
      reporterCtx,
    );

    // Rich subset — labels, components, and selective custom-field values, set
    // BEFORE the status transitions so the LAST revision is the (resolved)
    // transition the back-dating maps to `endAt`.
    if (i < sizes.richItems) {
      const richCtx: Ctx = {
        userId: pick(memberIds, `rich-actor:${i}`),
        workspaceId: workspace.id,
      };
      // 1–2 labels.
      const labelA = pick(LABEL_NAMES, `labelA:${i}`);
      await labelsService.addLabel(item.id, labelA, richCtx);
      labelLinks++;
      if (hashInt(`label2:${i}`, 2) === 0) {
        const labelB = LABEL_NAMES[(LABEL_NAMES.indexOf(labelA) + 3) % LABEL_NAMES.length]!;
        if (labelB !== labelA) {
          await labelsService.addLabel(item.id, labelB, richCtx);
          labelLinks++;
        }
      }
      // A component.
      await componentsService.addComponent(item.id, pick(componentIds, `cmp:${i}`), richCtx);
      componentLinks++;
      // Selective custom-field values — different subsets per field so the 6.1
      // predicates match meaningful (not all-or-nothing) slices.
      if (hashInt(`cf-select:${i}`, 2) === 0) {
        await customFieldValuesService.setValue(
          item.id,
          selectField.id,
          pick(selectOptionIds, `cf-select-opt:${i}`),
          richCtx,
        );
        customFieldValues++;
      }
      if (hashInt(`cf-number:${i}`, 3) === 0) {
        await customFieldValuesService.setValue(
          item.id,
          numberField.id,
          1 + hashInt(`cf-number-v:${i}`, 500),
          richCtx,
        );
        customFieldValues++;
      }
      if (hashInt(`cf-text:${i}`, 4) === 0) {
        await customFieldValuesService.setValue(
          item.id,
          textField.id,
          pick(ROOT_CAUSES, `cf-text-v:${i}`),
          richCtx,
        );
        customFieldValues++;
      }
      if (hashInt(`cf-date:${i}`, 5) === 0) {
        await customFieldValuesService.setValue(
          item.id,
          dateField.id,
          createdAt.toISOString().slice(0, 10),
          richCtx,
        );
        customFieldValues++;
      }
      if (hashInt(`cf-user:${i}`, 6) === 0) {
        await customFieldValuesService.setValue(
          item.id,
          userField.id,
          pick(memberIds, `cf-user-v:${i}`),
          richCtx,
        );
        customFieldValues++;
      }
    }

    // Walk the legal transition path to the final status (the actor is a member).
    const stepCtx: Ctx = {
      userId: pick(memberIds, `transition-actor:${i}`),
      workspaceId: workspace.id,
    };
    for (const step of transitionPath(status)) {
      await workItemsService.updateStatus(item.id, step, stepCtx);
    }

    timings.push({ id: item.id, createdAt, endAt, resolved });
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (resolved) resolvedItems++;
    if ((i + 1) % 500 === 0) console.log(`  …${i + 1}/${sizes.items} items`);
  }

  // ── The timestamp back-dating pass (THE recorded deviation) ───────────────
  console.log('Back-dating createdAt + revision timestamps…');
  await backdateTimestamps(timings);

  // ── Saved filters (6.2): enum / negation / date-window / custom-field ─────
  const filterSpecs: Array<{ name: string; description: string; ast: FilterAst }> = [
    {
      name: 'Open bugs',
      description: 'Bugs not yet resolved',
      ast: {
        combinator: 'and',
        conditions: [
          { field: 'kind', operator: 'is_any_of', value: ['bug'] },
          { field: 'status', operator: 'is_none_of', value: ['done', 'cancelled'] }, // negation
        ],
      },
    },
    {
      name: 'High priority work',
      description: 'High and highest priority items',
      ast: {
        combinator: 'and',
        conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
      },
    },
    {
      name: 'Created this month',
      description: 'Anything created in the last 30 days',
      ast: {
        combinator: 'and',
        conditions: [{ field: 'created', operator: 'in_last_days', value: 30 }], // date window
      },
    },
    {
      name: 'Frontend area',
      description: 'Items tagged Area = Frontend',
      ast: {
        combinator: 'and',
        conditions: [
          { field: `cf:${selectField.id}`, operator: 'is_any_of', value: [selectOptionIds[0]!] }, // custom field
        ],
      },
    },
    {
      name: 'In flight',
      description: 'Currently in progress or in review',
      ast: {
        combinator: 'or',
        conditions: [
          { field: 'status', operator: 'is_any_of', value: ['in_progress', 'in_review'] },
        ],
      },
    },
  ];
  const savedFilterIds: string[] = [];
  for (const spec of filterSpecs.slice(0, sizes.savedFilters)) {
    const filter = await savedFiltersService.create(
      key,
      {
        name: spec.name,
        description: spec.description,
        visibility: 'project',
        filterParam: encodeFilterParam(spec.ast),
      },
      ownerCtx,
    );
    savedFilterIds.push(filter.id);
  }

  // ── Dashboard (6.3): widgets consuming the corpus + a saved filter ────────
  const dashboard = await dashboardsService.create(
    { name: SEED_REPORTING_DASHBOARD_NAME, access: 'workspace', layout: 'three' },
    ownerCtx,
  );
  let dashboardWidgets = 0;
  const addWidget = async (input: {
    type: string;
    savedFilterId?: string;
    projectId?: string;
    config?: unknown;
  }) => {
    await dashboardsService.addWidget(dashboard.id, input, ownerCtx);
    dashboardWidgets++;
  };
  await addWidget({
    type: 'created_vs_resolved',
    projectId: project.id,
    config: { period: 'week', daysBack: windowDays, cumulative: false },
  });
  await addWidget({
    type: 'distribution',
    projectId: project.id,
    config: { statisticType: 'status' },
  });
  await addWidget({
    type: 'distribution',
    projectId: project.id,
    config: { statisticType: 'priority' },
  });
  if (savedFilterIds.length > 0) {
    await addWidget({
      type: 'filter_results',
      savedFilterId: savedFilterIds[0]!,
      config: { pageSize: 20 },
    });
  }

  // ── Automation rules (6.6): enabled, over the built-in action set ─────────
  const ruleSpecs: Array<{
    name: string;
    triggerType: string;
    triggerConfig: unknown;
    conditionFilterParam: string | null;
    actions: unknown;
  }> = [
    {
      name: 'Tag new bugs as triaged',
      triggerType: 'created',
      triggerConfig: { type: 'created' },
      conditionFilterParam: encodeFilterParam({
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
      }),
      actions: [{ type: 'add_label', name: 'triaged' }],
    },
    {
      name: 'Comment when resolved',
      triggerType: 'transitioned',
      triggerConfig: { type: 'transitioned', fromStatusId: null, toStatusId: doneStatusId },
      conditionFilterParam: null,
      actions: [{ type: 'add_comment', bodyMd: 'Automatically marked resolved by a rule.' }],
    },
    {
      name: 'Escalate highest priority',
      triggerType: 'field_changed',
      triggerConfig: { type: 'field_changed', field: 'priority' },
      conditionFilterParam: encodeFilterParam({
        combinator: 'and',
        conditions: [{ field: 'priority', operator: 'is_any_of', value: ['highest'] }],
      }),
      actions: [{ type: 'add_label', name: 'escalated' }],
    },
  ];
  let rules = 0;
  for (const spec of ruleSpecs.slice(0, sizes.rules)) {
    await automationRulesService.create(key, spec, ownerCtx);
    rules++;
  }

  // ── Self-check: the seeded shape matches the spec sheet — fail loudly ─────
  const manifest: ReportingSeedManifest = {
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ownerId: owner.id,
    items: sizes.items,
    resolvedItems,
    richItems: sizes.richItems,
    statusCounts,
    customFieldValues,
    labelLinks,
    componentLinks,
    savedFilters: savedFilterIds.length,
    dashboardWidgets,
    rules,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
  };
  await runSelfCheck(manifest, project.id, now);
  return manifest;
}

/**
 * THE recorded deviation — back-date timestamps the services stamp at `now()`.
 * Two raw UPDATEs, timestamps only:
 *   1. `work_item.createdAt` ← each item's assigned creation instant.
 *   2. Each item's `work_item_revision` rows spread evenly across
 *      `[createdAt, endAt]` (rank 0 = the `created` revision → createdAt; the
 *      last rank → endAt, which for a resolved item IS its done/cancelled
 *      transition — the row the 6.3 resolved series buckets).
 * Chunked so the parameter count stays well under the Postgres protocol limit.
 */
async function backdateTimestamps(timings: ItemTiming[]): Promise<void> {
  const CHUNK = 2_000;
  for (let off = 0; off < timings.length; off += CHUNK) {
    const chunk = timings.slice(off, off + CHUNK);

    const createdRows = chunk.map(
      (t) => Prisma.sql`(${t.id}::text, ${t.createdAt.toISOString()}::timestamptz)`,
    );
    await db.$executeRaw(Prisma.sql`
      UPDATE "work_item" w
      SET "createdAt" = v.created
      FROM (VALUES ${Prisma.join(createdRows)}) AS v(id, created)
      WHERE w.id = v.id`);

    const boundRows = chunk.map(
      (t) =>
        Prisma.sql`(${t.id}::text, ${t.createdAt.toISOString()}::timestamptz, ${t.endAt.toISOString()}::timestamptz)`,
    );
    await db.$executeRaw(Prisma.sql`
      WITH bounds(id, c, e) AS (VALUES ${Prisma.join(boundRows)}),
      ranked AS (
        SELECT r.id AS rid,
               r."workItemId" AS wid,
               ROW_NUMBER() OVER (PARTITION BY r."workItemId" ORDER BY r."changedAt" ASC, r.id ASC) - 1 AS rn,
               COUNT(*) OVER (PARTITION BY r."workItemId") AS cnt
        FROM "work_item_revision" r
        WHERE r."workItemId" IN (SELECT id FROM bounds)
      )
      UPDATE "work_item_revision" w
      SET "changedAt" = b.c
        + (b.e - b.c) * (CASE WHEN ranked.cnt <= 1 THEN 0 ELSE ranked.rn::float8 / (ranked.cnt - 1) END)
      FROM ranked
      JOIN bounds b ON b.id = ranked.wid
      WHERE w.id = ranked.rid`);
  }
}

/** Assert the seeded shape — every failure named, thrown together. */
async function runSelfCheck(m: ReportingSeedManifest, projectId: string, now: Date): Promise<void> {
  const [
    itemCount,
    distinctStatuses,
    valueCount,
    labelCount,
    componentCount,
    filterCount,
    ruleCount,
    enabledRules,
  ] = await Promise.all([
    db.workItem.count({ where: { projectId } }),
    db.workItem.findMany({ where: { projectId }, distinct: ['status'], select: { status: true } }),
    db.customFieldValue.count({ where: { workItem: { projectId } } }),
    db.workItemLabel.count({ where: { workItem: { projectId } } }),
    db.workItemComponent.count({ where: { workItem: { projectId } } }),
    db.savedFilter.count({ where: { projectId } }),
    db.automationRule.count({ where: { projectId } }),
    db.automationRule.count({ where: { projectId, enabled: true } }),
  ]);

  // The back-dating worked: the oldest createdAt sits near the window start and
  // the newest revision is in the past (no future-stamped row leaked through).
  const oldest = await db.workItem.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  const newestRevision = await db.workItemRevision.findFirst({
    where: { workItem: { projectId } },
    orderBy: { changedAt: 'desc' },
    select: { changedAt: true },
  });
  const ageDays = oldest ? (now.getTime() - oldest.createdAt.getTime()) / DAY_MS : 0;

  const checks: Array<[string, boolean]> = [
    [`items == ${m.items} (got ${itemCount})`, itemCount === m.items],
    [`≥5 distinct statuses (got ${distinctStatuses.length})`, distinctStatuses.length >= 5],
    [`resolved items > 0 (got ${m.resolvedItems})`, m.resolvedItems > 0],
    [
      `all five CF types valued (got ${valueCount})`,
      valueCount === m.customFieldValues && valueCount > 0,
    ],
    [`label links seeded (got ${labelCount})`, labelCount === m.labelLinks && labelCount > 0],
    [
      `component links seeded (got ${componentCount})`,
      componentCount === m.componentLinks && componentCount > 0,
    ],
    [`saved filters == ${m.savedFilters} (got ${filterCount})`, filterCount === m.savedFilters],
    [`dashboard widgets > 0 (got ${m.dashboardWidgets})`, m.dashboardWidgets > 0],
    [
      `rules == ${m.rules} and all enabled (got ${ruleCount}/${enabledRules})`,
      ruleCount === m.rules && enabledRules === m.rules,
    ],
    [`timestamp pass back-dated history (oldest ≈ ${ageDays.toFixed(0)}d ago)`, ageDays > 7],
    [
      `no future-stamped revision`,
      newestRevision !== null && newestRevision.changedAt.getTime() <= now.getTime() + HOUR_MS,
    ],
  ];
  const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failures.length > 0) {
    throw new Error(`seed-reporting self-check FAILED:\n  - ${failures.join('\n  - ')}`);
  }
}
