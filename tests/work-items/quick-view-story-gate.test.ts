import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { StaleWorkItemError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-2560's STORY GATE (MOTIR-2567) — the seams BETWEEN the story's cards,
// and the guards a coverage percentage cannot see.
//
// Each feature card shipped unit tests against a fixture its own author wrote.
// That is the expected normal, and it is exactly why this file exists: a fixture
// test proves the panel renders an object the test invented, never that the real
// service produces one of that shape, and never that the write the rail fires
// actually lands. So everything here drives one card's REAL output into the next
// card's REAL consumer, against real Postgres.
//
// `quick-view-editor-inputs.test.ts` (MOTIR-2562) already asserts the payload
// CARRIES each option source. This file starts one step later: the payload is
// written THROUGH, and read BACK.

const PASSWORD = 'hunter2hunter2';

// The two context resolvers the test environment cannot supply via cookies —
// the only stubs in this file. Everything else is the real path.
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
// The peek route resolves the request locale to format its display strings.
// `getLocale` needs a real request scope, which a Vitest process has no way to
// open — the third and last stub, and it changes nothing this file asserts.
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));

const { updateIssueAction, changeStatusAction } =
  await import('@/app/(authed)/items/[key]/edit/actions');
const { GET: peekRoute } = await import('@/app/api/work-items/peek/route');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeScenario(slug: string) {
  const user = await usersService.createUser({
    email: `gate-${slug}@example.com`,
    password: PASSWORD,
    name: 'Alice Chen',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${slug}`,
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** Sign in as `s` with `s`'s project active — what the peek's callers assume. */
function signIn(s: Scenario, as?: { id: string; email: string }) {
  session.current = {
    user: {
      id: as?.id ?? s.user.id,
      email: as?.email ?? s.user.email,
      name: 'Alice Chen',
    },
  };
  activeCtx.current = {
    userId: as?.id ?? s.user.id,
    workspaceId: s.workspace.id,
    projectId: s.project.id,
    project: s.project,
  };
}

function peek(s: Scenario, identifier: string, actor = s.ctx) {
  return workItemsService.getQuickView(
    s.project.id,
    identifier,
    s.project.accessLevel,
    actor,
    'en',
  );
}

function peekViaRoute(key: string): Promise<Response> {
  return peekRoute(new Request(`http://localhost:3000/api/work-items/peek?key=${key}`));
}

describe('seam · editor → action → re-read (the write the rail fires actually lands)', () => {
  it('every self-contained field the rail edits round-trips through updateIssueAction', async () => {
    const s = await makeScenario('roundtrip');
    signIn(s);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Round trip' },
      s.ctx,
    );
    const before = await peek(s, item.identifier);

    const res = await updateIssueAction({
      id: before.id,
      expectedUpdatedAt: before.updatedAt,
      priority: 'high',
      type: 'design',
      executor: 'human',
      dueDate: '2026-09-01T00:00:00.000Z',
      estimateMinutes: 120,
      assigneeId: s.user.id,
    });
    expect(res).toMatchObject({ ok: true });

    // Read BACK through the same payload the panel renders — the only check
    // that a field the action accepted also reaches the peek's rail.
    const after = await peek(s, item.identifier);
    expect(after).toMatchObject({
      priority: 'high',
      type: 'design',
      executor: 'human',
      estimateMinutes: 120,
      assigneeId: s.user.id,
    });
    expect(after.dueDate?.slice(0, 10)).toBe('2026-09-01');
    // The DISPLAY axis moves with the raw one — the pairing the panel depends on
    // to stay presentational.
    expect(after.dueLabel).toBeTruthy();
    expect(after.estimateLabel).toBeTruthy();
    expect(after.assigneeName).toBe('Alice Chen');
  });

  it('status goes through its OWN gated action and comes back as label + category', async () => {
    const s = await makeScenario('status');
    signIn(s);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Status move' },
      s.ctx,
    );
    const before = await peek(s, item.identifier);
    // The picker only offers what the workflow permits, so drive a target the
    // real workflow actually reaches from here.
    const target = before.workflow.statuses.find((st) => st.key === 'in_progress')!;

    expect(await changeStatusAction({ id: before.id, toStatusKey: target.key })).toMatchObject({
      ok: true,
    });

    const after = await peek(s, item.identifier);
    expect(after.status).toBe('in_progress');
    expect(after.statusLabel).toBe(target.label);
    expect(after.statusCategory).toBe(target.category);
  });

  it('sprint assignment round-trips, and the payload still lists the sprint it now holds', async () => {
    const s = await makeScenario('sprint');
    signIn(s);
    const sprint = await sprintsService.createSprint(s.project.id, { name: 'Sprint A' }, s.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Committed' },
      s.ctx,
    );
    await backlogService.assignToSprint(item.id, sprint.id, undefined, s.ctx);

    const after = await peek(s, item.identifier);
    expect(after.sprintId).toBe(sprint.id);
    expect(after.sprintName).toBe('Sprint A');
    // The picker's own option set must contain the current value, or opening it
    // would show the item's sprint as unselected.
    expect(after.sprints.map((x) => x.id)).toContain(sprint.id);
  });

  it('an EPIC carries the full editor inputs even though the rail hides its Sprint row', async () => {
    const s = await makeScenario('epic');
    signIn(s);
    const epic = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'epic', title: 'An epic' },
      s.ctx,
    );

    const data = await peek(s, epic.identifier);
    // The panel decides which ROWS render; the payload is unconditional. A
    // service that trimmed the option sources per kind would break the moment
    // the rail's conditions changed.
    expect(data.kind).toBe('epic');
    expect(data.workflow.statuses.length).toBeGreaterThan(0);
    expect(Array.isArray(data.sprints)).toBe(true);
    expect(Array.isArray(data.projectComponents)).toBe(true);
    expect(data.estimation).toBeTruthy();
    // …and an epic is still editable through the same action.
    expect(
      await updateIssueAction({
        id: data.id,
        expectedUpdatedAt: data.updatedAt,
        priority: 'low',
      }),
    ).toMatchObject({ ok: true });
    expect((await peek(s, epic.identifier)).priority).toBe('low');
  });

  it('an ARCHIVED item still peeks, carrying its archived fact AND the editor inputs', async () => {
    const s = await makeScenario('archived');
    signIn(s);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Shelved' },
      s.ctx,
    );
    await workItemsService.archiveWorkItem(item.id, s.ctx);

    const data = await peek(s, item.identifier);
    expect(data.archived).not.toBeNull();
    // The rail is the same component; if the payload dropped `estimation` on an
    // archived read the panel would throw rather than render the notice.
    expect(data.estimation).toBeTruthy();
    expect(data.workflow.statuses.length).toBeGreaterThan(0);
  });
});

describe('seam · the concurrency path (the guarantee the rail’s ledger rides on)', () => {
  it('two writes on the SAME token: one wins, the other is refused as stale', async () => {
    const s = await makeScenario('stale');
    signIn(s);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Contended' },
      s.ctx,
    );
    const before = await peek(s, item.identifier);

    // Two genuine writes carrying the SAME expected token — the two-tabs case.
    // Either may land first; what must hold is that exactly one succeeds and the
    // loser is REFUSED rather than silently overwriting.
    const [a, b] = await Promise.all([
      updateIssueAction({
        id: before.id,
        expectedUpdatedAt: before.updatedAt,
        priority: 'high',
      }),
      updateIssueAction({
        id: before.id,
        expectedUpdatedAt: before.updatedAt,
        priority: 'low',
      }),
    ]);

    const ok = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The refusal is the STALE one specifically — the flag the rail reads to
    // raise its reload notice rather than a per-field error.
    expect(refused[0]).toMatchObject({ ok: false, stale: true });

    // And the winner's value is what persisted; the loser wrote nothing.
    const after = await peek(s, item.identifier);
    expect(['high', 'low']).toContain(after.priority);
    // The token ADVANCED, so a fresh read can write again.
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(
      await updateIssueAction({
        id: after.id,
        expectedUpdatedAt: after.updatedAt,
        priority: 'medium',
      }),
    ).toMatchObject({ ok: true });
  });

  it('the service itself raises the TYPED error, not a generic write failure', async () => {
    const s = await makeScenario('typed-stale');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Typed' },
      s.ctx,
    );
    const stale = item.updatedAt;
    await workItemsService.updateWorkItem(item.id, { priority: 'high' }, s.ctx, {
      expectedUpdatedAt: stale,
    });

    // Submitting the now-superseded token must be a StaleWorkItemError — the
    // action's `stale: true` above is only as honest as this.
    await expect(
      workItemsService.updateWorkItem(item.id, { priority: 'low' }, s.ctx, {
        expectedUpdatedAt: stale,
      }),
    ).rejects.toBeInstanceOf(StaleWorkItemError);
  });
});

describe('guard · the wider payload did not widen the blast radius', () => {
  it('a cross-workspace key, an unknown key and a deleted key are the SAME 404', async () => {
    const owner = await makeScenario('leak-owner');
    const item = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Private work' },
      owner.ctx,
    );
    const deleted = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Doomed' },
      owner.ctx,
    );
    await workItemsService.deleteWorkItem(deleted.id, owner.ctx);
    const outsider = await makeScenario('leak-outsider');

    // The outsider's own project is active; the foreign key must look exactly
    // as absent as a key that never existed. A 403 would confirm existence.
    signIn(outsider);
    const foreign = await peekViaRoute(item.identifier);
    const unknown = await peekViaRoute(`${outsider.project.identifier}-99999`);
    signIn(owner);
    const gone = await peekViaRoute(deleted.identifier);

    for (const res of [foreign, unknown, gone]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
    }
  });

  it('no option source reaches a body a non-member can obtain', async () => {
    const owner = await makeScenario('leak-fields');
    await sprintsService.createSprint(owner.project.id, { name: 'Secret Sprint' }, owner.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Private work' },
      owner.ctx,
    );
    const outsider = await makeScenario('leak-fields-out');

    signIn(outsider);
    const res = await peekViaRoute(item.identifier);
    const body = (await res.json()) as Record<string, unknown>;

    // The widened payload is the story's premise, so the leak test has to name
    // the NEW keys explicitly — the old assertion ("it 404s") would still pass
    // if a future refactor started answering 200 with a trimmed body.
    for (const key of ['members', 'sprints', 'projectComponents', 'workflow', 'estimation', 'id']) {
      expect(body[key]).toBeUndefined();
    }
  });

  it('an unauthenticated caller gets 401, and a missing key a 400 — before any read', async () => {
    session.current = null;
    activeCtx.current = null;
    expect((await peekViaRoute('ACME-1')).status).toBe(401);

    const s = await makeScenario('badreq');
    signIn(s);
    expect((await peekRoute(new Request('http://localhost:3000/api/work-items/peek'))).status).toBe(
      400,
    );
  });
});

describe('guard · the read-only actor is gated on the SERVER, not only in the UI', () => {
  it('a project VIEWER can peek but cannot write — the affordance is not the gate', async () => {
    const owner = await makeScenario('viewer');
    const viewer = await usersService.createUser({
      email: 'gate-viewer-actor@example.com',
      password: PASSWORD,
      name: 'Vic Viewer',
    });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: owner.workspace.id,
      role: 'member',
    });
    await projectMembersService.addMember({
      key: owner.project.identifier,
      actorUserId: owner.user.id,
      ctx: owner.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    const item = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Look, don’t touch' },
      owner.ctx,
    );
    const viewerCtx = { userId: viewer.id, workspaceId: owner.workspace.id };

    // The viewer CAN read the peek — the rail renders, minus its chevrons.
    const data = await peek(owner, item.identifier, viewerCtx);
    expect(data.identifier).toBe(item.identifier);

    // …and the write is refused by `assertCanEdit` regardless of what rendered.
    // Hiding a chevron is never enforcement; this is.
    await expect(
      workItemsService.updateWorkItem(item.id, { priority: 'high' }, viewerCtx, {
        expectedUpdatedAt: data.updatedAt,
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);

    // The refusal is real, not cosmetic: nothing moved.
    expect((await peek(owner, item.identifier)).priority).toBe('medium');
  });
});

describe('guard · one write path per field', () => {
  // The five source files the peek's rail is made of. Every write it performs
  // has to leave through one of them.
  const PEEK_SOURCES = [
    'app/(authed)/items/_components/IssueQuickViewPanel.tsx',
    'app/(authed)/items/_components/QuickViewRailEdit.tsx',
    'app/(authed)/items/_components/fieldChipEditing.ts',
    'app/(authed)/items/_components/customFieldEditing.tsx',
    'app/(authed)/items/_components/IssueQuickViewController.tsx',
  ];

  it('the peek writes ONLY through the modules the detail page already writes through', () => {
    // A parallel write path would pass every component test in this story —
    // they stub the action — and give one field two implementations that drift
    // the first time either is fixed. Nothing but a structural read of the
    // sources catches that, so this is deliberately not a behavioural test.
    const SHIPPED_WRITE_MODULES = new Set([
      // The detail page's own edit actions (priority / type / executor / due /
      // estimate / assignee / parent, and the gated status change).
      '../[key]/edit/actions',
      '@/app/(authed)/items/[key]/edit/actions',
      // The detail cards' label + component actions, and the custom-field setter.
      '../[key]/labelComponentActions',
      '../[key]/customFieldActions',
      // The sprint assign helper the detail rail uses (its own shipped route).
      '@/components/issues/actions/workItemActionsClient',
    ]);
    const WRITE_HINT = /(Action|actions|actionsClient)$/;

    for (const rel of PEEK_SOURCES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const mod = m[1]!;
        if (!WRITE_HINT.test(mod)) continue;
        expect(
          SHIPPED_WRITE_MODULES.has(mod),
          `${rel} imports writes from an unshipped module: ${mod}`,
        ).toBe(true);
      }
    }
  });

  it('no peek source performs its OWN mutating fetch', () => {
    // The one `fetch` the peek is allowed is the controller's READ of
    // /api/work-items/peek. A method option anywhere in this tree means a hand-
    // rolled endpoint call bypassing the shipped action.
    for (const rel of PEEK_SOURCES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src, `${rel} issues a mutating fetch`).not.toMatch(
        /method:\s*'(POST|PATCH|PUT|DELETE)'/,
      );
    }
  });

  it('the peek route itself is READ-ONLY — it exports GET and nothing else', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/work-items/peek/route.ts'), 'utf8');
    expect(src).toMatch(/export async function GET\b/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\b/);
  });
});
