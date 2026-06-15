import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md. The route-transport
// half of the permission matrix drives `wsCtx.current`; the service-layer seams
// pass `ctx` explicitly.
import type { WorkspaceContext } from '@/lib/workspaces';
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import { db } from '@/lib/db';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import type { AutomationRuleWriteInput } from '@/lib/services/automationRulesService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The combined Epic-6 journey — Vitest companion (Story 6.7 · Subtask 6.7.2).
// The E2E (`tests/e2e/epic6-journey.spec.ts`) drives the build → save → widget →
// rule → fire → gate → unwind chain through the real UI + Inngest dev server;
// THIS spec asserts the two places that assertion is weak at the browser, at the
// service / route layer where they are checkable directly:
//
//   1. the CONSOLIDATED role × Epic-6-admin-endpoint permission matrix — driven
//      from a filesystem ROUTE INVENTORY of the admin-only automation surface
//      (the 6.5 hub's rule admin), so a new admin endpoint that lands without a
//      matrix row FAILS the suite (the 2.6.1 totality-guard pattern). Each
//      endpoint is exercised UI-blind through its real route handler: an admin
//      passes, a browsable non-admin viewer is 403 — the API half of the gate
//      the E2E asserts in the UI;
//   2. the rule-firing TRANSACTION seams the E2E asserts only weakly through the
//      async window: exactly-once per (rule × event) under a retry replay,
//      automation actor attribution on the action's revision row (the engine
//      runs as the rule OWNER, never the triggering user), and no orphan
//      execution rows after a rule delete (the FK cascade, proven not assumed).
//
// Real Postgres, no DB mocks (CLAUDE.md). The one external seam stubbed is the
// Inngest client's `send()` (the tests/helpers/jobs.ts pattern) so a service
// write's post-commit event doesn't reach an (absent) dev server. It does NOT
// re-test what an owning closer already covers in isolation (6.6.1 the route
// auth, 6.6.2 the engine matrix, 6.2.1 the saved-filter matrix) — only the
// CONSOLIDATED admin-gate inventory and the cross-story firing seams.

let cap: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// ── Team fixture: owner + an enrolled project admin + a read-only viewer ──────

interface Team {
  fx: WorkItemFixture;
  key: string;
  ownerCtx: ServiceContext;
  adminCtx: ServiceContext;
  viewerCtx: ServiceContext;
  adminId: string;
}

let teamSeq = 0;

async function makeTeam(): Promise<Team> {
  teamSeq += 1;
  const fx = await makeWorkItemFixture({ identifier: `E6${String(teamSeq).padStart(2, '0')}` });
  const key = fx.projectIdentifier;

  async function enroll(slug: string, role: 'admin' | 'viewer') {
    const user = await createTestUser({ email: `${slug}-${teamSeq}@example.com`, name: slug });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
    return user;
  }

  const admin = await enroll('admin', 'admin');
  const viewer = await enroll('viewer', 'viewer');
  const ctxFor = (userId: string): ServiceContext => ({ userId, workspaceId: fx.workspaceId });
  return {
    fx,
    key,
    ownerCtx: fx.ctx,
    adminCtx: ctxFor(admin.id),
    viewerCtx: ctxFor(viewer.id),
    adminId: admin.id,
  };
}

let ruleSeq = 0;

/** A minimal enabled rule, OWNER-owned — the row the single-rule routes act on. */
async function seedRule(t: Team): Promise<string> {
  ruleSeq += 1;
  const rule = await automationRulesService.create(
    t.key,
    {
      name: `Inventory rule ${ruleSeq}`,
      triggerType: 'created',
      triggerConfig: {},
      conditionFilterParam: null,
      actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    },
    t.ownerCtx,
  );
  return rule.id;
}

function jsonReq(body: unknown): Request {
  return new Request('http://test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const RULE_BODY = {
  name: 'Via route',
  triggerType: 'created',
  triggerConfig: {},
  condition: null,
  actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
};

// ── 1. The consolidated role × Epic-6-admin-endpoint permission matrix ────────
//
// `endpoint` keys map 1:1 to a discovered `<relativePath>#<METHOD>` handler in
// the inventory below; `run` exercises the REAL route handler with the actor's
// context. Admin → 2xx, browsable viewer → 403 (the service gate, surfaced by
// `mapAutomationError`). The single-rule routes seed their own OWNER-owned rule
// so each cell is independent of the others' order (DELETE can run last safely).

import {
  GET as listGET,
  POST as collectionPOST,
} from '@/app/api/projects/[key]/automation-rules/route';
import {
  GET as ruleGET,
  PATCH as rulePATCH,
  DELETE as ruleDELETE,
} from '@/app/api/projects/[key]/automation-rules/[ruleId]/route';
import { PUT as enabledPUT } from '@/app/api/projects/[key]/automation-rules/[ruleId]/enabled/route';
import { GET as executionsGET } from '@/app/api/projects/[key]/automation-rules/[ruleId]/executions/route';

interface AdminEndpoint {
  /** The `<path-relative-to-[key]>#<METHOD>` inventory key. */
  endpoint: string;
  label: string;
  run: (t: Team, ctx: WorkspaceContext) => Promise<Response>;
}

const ADMIN_ENDPOINTS: AdminEndpoint[] = [
  {
    endpoint: 'automation-rules/route.ts#GET',
    label: 'list rules',
    run: async (t) =>
      listGET(new Request('http://test/'), { params: Promise.resolve({ key: t.key }) }),
  },
  {
    endpoint: 'automation-rules/route.ts#POST',
    label: 'create rule',
    run: async (t) =>
      collectionPOST(jsonReq(RULE_BODY), { params: Promise.resolve({ key: t.key }) }),
  },
  {
    endpoint: 'automation-rules/[ruleId]/route.ts#GET',
    label: 'read one rule',
    run: async (t) => {
      const ruleId = await seedRule(t);
      return ruleGET(new Request('http://test/'), {
        params: Promise.resolve({ key: t.key, ruleId }),
      });
    },
  },
  {
    endpoint: 'automation-rules/[ruleId]/route.ts#PATCH',
    label: 'replace rule content',
    run: async (t) => {
      const ruleId = await seedRule(t);
      return rulePATCH(jsonReq(RULE_BODY), { params: Promise.resolve({ key: t.key, ruleId }) });
    },
  },
  {
    endpoint: 'automation-rules/[ruleId]/route.ts#DELETE',
    label: 'delete rule',
    run: async (t) => {
      const ruleId = await seedRule(t);
      return ruleDELETE(new Request('http://test/'), {
        params: Promise.resolve({ key: t.key, ruleId }),
      });
    },
  },
  {
    endpoint: 'automation-rules/[ruleId]/enabled/route.ts#PUT',
    label: 'toggle enabled',
    run: async (t) => {
      const ruleId = await seedRule(t);
      return enabledPUT(jsonReq({ enabled: false }), {
        params: Promise.resolve({ key: t.key, ruleId }),
      });
    },
  },
  {
    endpoint: 'automation-rules/[ruleId]/executions/route.ts#GET',
    label: 'read execution log',
    run: async (t) => {
      const ruleId = await seedRule(t);
      return executionsGET(new Request('http://test/?page=1'), {
        params: Promise.resolve({ key: t.key, ruleId }),
      });
    },
  },
];

/** Discover every exported HTTP handler under the admin-only automation route
 * tree — the source of truth the matrix is held total against. */
function discoverAdminHandlers(): string[] {
  const apiRoot = path.join(process.cwd(), 'app/api/projects/[key]');
  const adminRoot = path.join(apiRoot, 'automation-rules');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') {
        const src = readFileSync(full, 'utf8');
        const rel = path.relative(apiRoot, full).split(path.sep).join('/');
        for (const m of src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)) {
          found.push(`${rel}#${m[1]}`);
        }
      }
    }
  };
  walk(adminRoot);
  return found.sort();
}

describe('the Epic-6 admin surface — role × endpoint permission matrix (inventory-driven)', () => {
  it('every discovered admin route handler has a matrix row, and every row maps to a real handler (totality guard)', () => {
    const discovered = discoverAdminHandlers();
    const covered = new Set(ADMIN_ENDPOINTS.map((e) => e.endpoint));
    // A new admin endpoint landing without a matrix row FAILS here (the point).
    for (const handler of discovered) {
      expect(
        covered,
        `admin route handler ${handler} is missing a permission-matrix row`,
      ).toContain(handler);
    }
    // …and no stale rows for a handler that no longer exists.
    for (const e of ADMIN_ENDPOINTS) {
      expect(discovered, `matrix row ${e.endpoint} no longer maps to a route handler`).toContain(
        e.endpoint,
      );
    }
  });

  for (const ep of ADMIN_ENDPOINTS) {
    it(`a browsable non-admin viewer is 403 on ${ep.label} (${ep.endpoint})`, async () => {
      const t = await makeTeam();
      wsCtx.current = t.viewerCtx;
      const res = await ep.run(t, t.viewerCtx);
      expect(res.status, `${ep.endpoint} should reject the viewer with 403`).toBe(403);
    });

    it(`a project admin succeeds on ${ep.label} (${ep.endpoint})`, async () => {
      const t = await makeTeam();
      wsCtx.current = t.adminCtx;
      const res = await ep.run(t, t.adminCtx);
      expect(res.status, `${ep.endpoint} should accept the admin (2xx)`).toBeGreaterThanOrEqual(
        200,
      );
      expect(res.status, `${ep.endpoint} should accept the admin (2xx)`).toBeLessThan(300);
    });
  }
});

// ── 2. The rule-firing transaction seams ──────────────────────────────────────

let evtSeq = 0;
function transitionedTo(
  fx: WorkItemFixture,
  workItemId: string,
  toStatusKey: string,
  eventId: string,
) {
  return automationEngineService.runForEvent({
    trigger: 'transitioned',
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    workItemId,
    eventId,
    fromStatusKey: 'todo',
    toStatusKey,
  });
}

async function makeTransitionRule(
  key: string,
  ctx: ServiceContext,
  overrides: Partial<AutomationRuleWriteInput> = {},
) {
  const input: AutomationRuleWriteInput = {
    name: 'Escalate on start',
    triggerType: 'transitioned',
    triggerConfig: { toStatusId: 'in_progress' },
    conditionFilterParam: null,
    actions: [{ type: 'set_field', field: 'priority', value: 'highest' }],
    ...overrides,
  };
  return automationRulesService.create(key, input, ctx);
}

describe('the rule-firing transaction seams', () => {
  it('the same (rule, event) fires exactly once — a retry replay is deduped, the action runs once', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await makeTransitionRule(fx.projectIdentifier, fx.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship it' },
      fx.ctx,
    );
    const eventId = `dedupe-${(evtSeq += 1)}`;

    const first = await transitionedTo(fx, item.id, 'in_progress', eventId);
    expect(first).toMatchObject({ matched: 1, succeeded: 1, failed: 0 });

    // The job lane re-delivers the SAME event (Inngest at-least-once) → deduped,
    // no second audit row, no second effect.
    const replay = await transitionedTo(fx, item.id, 'in_progress', eventId);
    expect(replay.deduped).toBe(1);

    expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(1);
    expect((await workItemsService.getWorkItem(item.id, fx.ctx)).priority).toBe('highest');
  });

  it('the action revision is attributed to the rule OWNER, never the triggering user', async () => {
    const t = await makeTeam();
    // The rule is owned by the project ADMIN; the item is created (and the
    // transition triggered) by the workspace OWNER. The engine runs the action
    // as the rule owner — so the priority change is attributed to the admin.
    const rule = await makeTransitionRule(t.key, t.adminCtx);
    const item = await workItemsService.createWorkItem(
      { projectId: t.fx.projectId, kind: 'task', title: 'Whose change?' },
      t.ownerCtx,
    );

    const summary = await transitionedTo(t.fx, item.id, 'in_progress', `attr-${(evtSeq += 1)}`);
    expect(summary).toMatchObject({ matched: 1, succeeded: 1 });

    const updates = await db.workItemRevision.findMany({
      where: { workItemId: item.id, changeKind: 'updated' },
    });
    const priorityRev = updates.find(
      (r) => (r.diff as { priority?: unknown }).priority !== undefined,
    );
    expect(priorityRev, 'a priority-change revision exists').toBeDefined();
    expect(priorityRev!.changedById).toBe(t.adminId); // the rule owner
    expect(priorityRev!.changedById).not.toBe(t.ownerCtx.userId); // not the triggerer
    expect(rule.id).toBeTruthy();
  });

  it('deleting a rule cascades its execution audit log — no orphan rows survive', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await automationRulesService.create(
      fx.projectIdentifier,
      {
        name: 'Soon deleted',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Audited' },
      fx.ctx,
    );

    const run = await automationEngineService.runForEvent({
      trigger: 'created',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      eventId: `del-${(evtSeq += 1)}`,
    });
    expect(run).toMatchObject({ matched: 1, succeeded: 1 });
    expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(1);

    await automationRulesService.delete(fx.projectIdentifier, rule.id, fx.ctx);

    // FK onDelete: Cascade — the audit rows go with the rule, none orphaned.
    expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(0);
    expect(await db.automationRule.count({ where: { id: rule.id } })).toBe(0);
  });
});
