/**
 * `pnpm db:seed` — seed the REAL Motir build plan into a real tenant so the
 * plan can be browsed inside Motir itself, and so the seed is the single
 * source of truth for planning (MOTIR.md; `prodect_plan/` is now a frozen
 * archive). The plan tree lives in `./data/` (one typed module per story);
 * this loader walks it and writes the work-item tree + dependency links.
 *
 * Tenant (fixed): the `moooon` workspace + `motir` project owned by
 * **zhuyue@motir.co** (the project manager), with a small **team** of members
 * (see SEED_USERS). Every work item gets a **reporter + assignee drawn from the
 * team** and a **varied priority** — deterministically (a hash of the plan id),
 * so reseeds are stable and the board/list show real people + a spread of
 * priorities rather than one owner + all-medium. The team is also enrolled in the
 * `motir` **project** (Story 6.4 added project-level access gating): every seed
 * user gets a `ProjectMembership` — **zhuyue@motir.co is the project `admin`**
 * (manages members + access), **everyone else is a `member`** (can edit, can't
 * manage) — and the project's `accessLevel` is set explicitly to **`open`** so the
 * demo tenant stays browsable by every workspace member (flip to `private` here to
 * showcase gating instead). Before 6.4 access was workspace-level only.
 *
 * Org tier (Story 6.10): the `moooon` workspace nests under a `moooon`
 * **Organization** — the root tenancy tier ABOVE Workspace. The seed models a
 * SINGLE org over the single workspace (the simplest shape that still exercises
 * the org switcher's active org); `workspacesService.createWorkspace` mints it
 * with **zhuyue@motir.co as org OWNER** and attaches the workspace, then the rest
 * of the team is enrolled as org members at **varied org-roles** (a couple of
 * `admin`s, the rest `member`s) so 6.10.5's cross-workspace member UI + 6.10.8's
 * e2e have a realistic owner/admin/member roster. The clear pass deletes the org
 * too — it does NOT cascade up from the workspace delete — so reseeds stay
 * idempotent and never collide on the globally-unique `moooon` org slug.
 *
 * Re-running is IDEMPOTENT — it clears ONLY the `moooon` workspace(s) owned by a
 * seed user (old or new) and reseeds; it never touches any other workspace's
 * data. The legacy single-owner account `info@moooon.net` is removed. Everything
 * is written through the shipped services / repositories (no raw inserts that
 * would skip the kind-parent triggers), so the seed exercises the same create
 * path the app does.
 *
 * Production: unlike `db:seed:large` (a pure dev tool), this seed is the
 * authoritative plan and may run against production on merge to main (the
 * `Reseed plan on merge` workflow). It refuses to run under
 * NODE_ENV=production UNLESS SEED_ALLOW_PRODUCTION=1 is set — so a stray build
 * never wipes-and-reseeds prod, but the reseed workflow (which sets the flag)
 * can.
 */
/* eslint-disable no-console -- a CLI script: console IS its output surface */
import '../_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads (helper is in scripts/, one level up)
import type { OrganizationRole, Prisma, SprintState, WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { keyForAppend } from '@/lib/workItems/positioning';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { PLAN } from './data';
import { composeDescription, mapTypeAndExecutor } from './mapItem';
import { PLAN_STATUS_MAP, type PlanItem, type PlanLeafKind, type PlanStatus } from './types';

const SEED_PASSWORD = '!QAZ1qaz';
const SEED_WORKSPACE_NAME = 'moooon';
const SEED_PROJECT_NAME = 'motir';
const SEED_PROJECT_IDENTIFIER = 'PROD';

/**
 * The seed team. The first entry (zhuyue@motir.co) is the workspace OWNER +
 * project manager; the rest are members. Reporters + assignees are drawn from
 * this whole pool. All passwords are SEED_PASSWORD.
 */
const SEED_USERS: ReadonlyArray<{ email: string; name: string }> = [
  { email: 'zhuyue@motir.co', name: 'Zhu Yue' }, // [0] owner / project manager
  { email: 'bophilips@motir.co', name: 'Bo Philips' },
  { email: 'odie@motir.co', name: 'Odie' },
  { email: 'mo@motir.co', name: 'Mo' },
  { email: 'julian@motir.co', name: 'Julian' },
  { email: 'eikooc@motir.co', name: 'Eikooc' },
];
const OWNER_EMAIL = SEED_USERS[0]!.email;
/** Removed by this seed (the old single-owner tenant account). */
const LEGACY_EMAIL = 'info@moooon.net';

/** Every priority value, so seeded items span the spectrum, not all `medium`. */
const PRIORITIES: readonly WorkItemPriority[] = ['lowest', 'low', 'medium', 'high', 'highest'];

/** FNV-1a — a tiny deterministic string hash (stable reporter/assignee/priority across reseeds). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministically pick an element of `arr` keyed by `key`. */
function pick<T>(arr: readonly T[], key: string): T {
  return arr[hash(key) % arr.length]!;
}

/** The story-point estimates a sprinted leaf can carry — a Fibonacci spread. */
const STORY_POINTS: readonly number[] = [1, 2, 3, 5, 8];

/** Deterministic Fibonacci story-point estimate for a plan id (stable across reseeds). */
function storyPointsFor(planId: string): number {
  return pick(STORY_POINTS, `${planId}:points`);
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    throw new Error(
      'db:seed refuses to run under NODE_ENV=production without SEED_ALLOW_PRODUCTION=1 ' +
        '(the reseed-on-merge workflow sets this flag deliberately).',
    );
  }

  // ── Idempotent clear: drop every `moooon` workspace owned by a seed user ────
  // (old single-owner OR the new team), then remove the legacy account. Keyed by
  // the seed emails + workspace NAME, so it never touches a real user's data.
  const knownEmails = [LEGACY_EMAIL, ...SEED_USERS.map((u) => u.email)];
  const knownUsers = await db.user.findMany({ where: { email: { in: knownEmails } } });
  if (knownUsers.length) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: { in: knownUsers.map((u) => u.id) } },
      include: { workspace: true },
    });
    const seededWorkspaces = memberships
      .filter((m) => m.workspace.name === SEED_WORKSPACE_NAME)
      .map((m) => m.workspace);
    const workspaceIds = new Set(seededWorkspaces.map((w) => w.id));
    // Story 6.10: each workspace's parent Organization (the tenant ROOT above
    // Workspace). Cascade only flows org→workspace, so deleting a workspace does
    // NOT delete its org — an undeleted org would orphan and collide on the
    // globally-unique `moooon` org slug the next reseed mints, breaking
    // idempotency. Capture the org ids now; drop them AFTER their workspaces.
    // (The new-tenant-root truncate rule: a tier above an existing root must be
    // cleared explicitly — Cascade never reaches up.)
    const organizationIds = new Set(seededWorkspaces.map((w) => w.organizationId));
    for (const workspaceId of workspaceIds) {
      // work_item.parent is onDelete:NoAction, so clear the set in one statement
      // first; the workspace then cascades project + memberships. Clearing the
      // items also frees the legacy user from any reporter FK so it can be removed.
      await db.workItem.deleteMany({ where: { workspaceId } });
      await db.workspace.delete({ where: { id: workspaceId } });
    }
    // The orgs are now childless — drop them (cascades their OrganizationMembership
    // rows). This is slug-agnostic, so it also cleans an org whose slug a past
    // collision suffixed. Belt-and-suspenders: also remove any org still carrying
    // the seed slug that a PRE-6.10.6 reseed left orphaned (its workspace delete
    // never reached up to it), so the createWorkspace below mints slug `moooon`,
    // not a suffixed retry. `slug` is @unique, so this drops at most one row.
    for (const organizationId of organizationIds) {
      await db.organization.delete({ where: { id: organizationId } });
    }
    await db.organization.deleteMany({ where: { slug: SEED_WORKSPACE_NAME } });
    const legacy = knownUsers.find((u) => u.email === LEGACY_EMAIL);
    if (legacy) await db.user.delete({ where: { id: legacy.id } });
  }

  // ── Team: create (or reuse) each user; zhuyue@motir.co owns the workspace ─
  const userIdByEmail = new Map<string, string>();
  for (const u of SEED_USERS) {
    const existing = await db.user.findUnique({ where: { email: u.email } });
    const user =
      existing ??
      (await usersService.createUser({ email: u.email, password: SEED_PASSWORD, name: u.name }));
    userIdByEmail.set(u.email, user.id);
  }
  const ownerId = userIdByEmail.get(OWNER_EMAIL)!;
  /** The reporter/assignee pool, in SEED_USERS order (keeps `pick` deterministic). */
  const memberIds = SEED_USERS.map((u) => userIdByEmail.get(u.email)!);

  const { workspace } = await workspacesService.createWorkspace({
    name: SEED_WORKSPACE_NAME,
    ownerUserId: ownerId,
  });
  // The rest of the team join as members (owner is already a member via createWorkspace).
  for (const u of SEED_USERS) {
    if (u.email === OWNER_EMAIL) continue;
    await workspacesService.addMember({
      userId: userIdByEmail.get(u.email)!,
      workspaceId: workspace.id,
      role: 'member',
    });
  }

  // ── Org roster: model the `moooon` org over its workspace (Story 6.10.6) ───
  // `createWorkspace` above already minted the `moooon` Organization (the root
  // tenancy tier) with zhuyue@motir.co as its org OWNER and the workspace
  // attached via `organizationId`. We want the rest of the team enrolled as org
  // members at VARIED org-roles so the owner/admin/member spread is realistic for
  // 6.10.5's cross-workspace member UI + 6.10.8's e2e.
  //
  // As of Story 6.10.4 the upward auto-join IS wired: `workspacesService.addMember`
  // (the loop above) already created an org membership at the default `member`
  // role for every non-owner. So we must NOT `create` the membership again here —
  // that double-creates and trips the unique (organizationId, userId) constraint,
  // aborting the seed AFTER the destructive clear but BEFORE the project/work-item
  // pass (leaving the tenant with no project and no items). Instead, UPDATE the
  // role for the members we want promoted to org `admin`; the rest keep the
  // `member` role addMember already gave them. Idempotent across reseeds — the
  // clear pass deletes the org first, cascading its memberships.
  const organizationId = workspace.organizationId;
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (let i = 0; i < SEED_USERS.length; i++) {
      const email = SEED_USERS[i]!.email;
      if (email === OWNER_EMAIL) continue; // already the org owner via createWorkspace
      // Deterministic spread: the first two non-owner members are org `admin`s,
      // the rest stay `member` (addMember's auto-join default) — so owner + admin
      // + member are all represented. Only the admins need a role update.
      const role: OrganizationRole = i <= 2 ? ORGANIZATION_ROLE.admin : ORGANIZATION_ROLE.member;
      if (role === ORGANIZATION_ROLE.member) continue; // auto-join already set this
      await organizationMembershipRepository.updateRole(
        organizationId,
        userIdByEmail.get(email)!,
        role,
        tx,
      );
    }
  });

  const project = await projectsService.createProject({
    name: SEED_PROJECT_NAME,
    identifier: SEED_PROJECT_IDENTIFIER,
    workspaceId: workspace.id,
    actorUserId: ownerId,
  });
  // Point every member's active project at `motir` so they all land on it
  // (this is just the convenience default for where they land on sign-in).
  await db.workspaceMembership.updateMany({
    where: { workspaceId: workspace.id },
    data: { activeProjectId: project.id },
  });

  // ── Project membership: enroll the team in `motir` (Story 6.4.7) ──────────
  // Project-level access gating landed in Story 6.4; now that ProjectMembership
  // exists, enroll the team in the project itself — the project half of the
  // original "add the team to the workspace AND the project" ask (the workspace
  // half is the addMember loop above). zhuyue@motir.co is the project `admin`
  // (manages members + access); everyone else is a `member` (can edit, can't
  // manage). The project keeps accessLevel `open` (set explicitly here, though it
  // is also the schema default) so the demo tenant stays browsable by every
  // workspace member — gating is exercised by the 6.4 tests, not forced on the
  // showcase tenant; flip `'open'` to `'private'` below to demo gating instead.
  // The clear pass above deletes the project (cascading its memberships), so a
  // plain create is idempotent across reseeds.
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const u of SEED_USERS) {
      await projectMembershipRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          userId: userIdByEmail.get(u.email)!,
          role: u.email === OWNER_EMAIL ? 'admin' : 'member',
        },
        tx,
      );
    }
    await projectRepository.setAccessLevel(project.id, 'open', tx);
  });

  // ── Tree pass: create every epic → story → leaf through the shipped path ──
  let created = 0;
  const idMap = new Map<string, string>(); // dotted plan id → work_item id
  const dependsEdges: Array<{ from: string; to: string }> = [];

  async function createItem(args: {
    kind: 'epic' | 'story' | 'subtask' | 'bug' | 'task';
    planId: string;
    title: string;
    status: string;
    descriptionMd: string | null;
    explanationMd?: string | null;
    estimateMinutes?: number | null;
    // Work-item TYPE + EXECUTOR (Story 2.7 · Subtask 2.7.5) — leaf-only: the
    // caller passes the mapped values for leaves and `null`/`null` for
    // epics/stories (containers are never typed). Written straight onto the
    // create input below (the nullable columns 2.7.3 added).
    type?: WorkItemTypeDto | null;
    executor?: ExecutorDto | null;
    parentId: string | null;
  }): Promise<string> {
    // Deterministic reporter / assignee / priority from the plan id, so the
    // tenant shows real people + a spread of priorities and reseeds are stable.
    const reporterId = pick(memberIds, `${args.planId}:reporter`);
    const assigneeId = pick(memberIds, `${args.planId}:assignee`);
    const priority = pick(PRIORITIES, `${args.planId}:priority`);
    const id = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const key = await projectRepository.allocateWorkItemNumber(project.id, tx);
      const row = await workItemRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          parentId: args.parentId,
          kind: args.kind,
          key,
          identifier: `${project.identifier}-${key}`,
          title: args.title,
          descriptionMd: args.descriptionMd ?? undefined,
          explanationMd: args.explanationMd ?? undefined,
          status: args.status,
          priority,
          estimateMinutes: args.estimateMinutes ?? undefined,
          type: args.type ?? undefined,
          executor: args.executor ?? undefined,
          reporterId,
          assigneeId,
          position: String(key).padStart(8, '0'),
        },
        tx,
      );
      return row.id;
    });
    idMap.set(args.planId, id);
    created++;
    if (created % 100 === 0) process.stdout.write(`  …${created} items\n`);
    return id;
  }

  for (const epic of PLAN) {
    const epicId = await createItem({
      kind: 'epic',
      planId: epic.id,
      title: `Epic ${epic.id}: ${epic.title}`,
      status: PLAN_STATUS_MAP[epic.status],
      descriptionMd: epic.descriptionMd?.trim() ?? null,
      parentId: null,
    });

    for (const story of epic.stories) {
      const storyDesc = [story.descriptionMd?.trim(), story.verificationRecipeMd?.trim()]
        .filter(Boolean)
        .join('\n\n## Verification\n\n');
      const storyId = await createItem({
        kind: 'story',
        planId: story.id,
        title: `${story.id} ${story.title}`,
        status: PLAN_STATUS_MAP[story.status],
        descriptionMd: storyDesc.length ? storyDesc : null,
        parentId: epicId,
      });

      for (const item of story.items) {
        const { type, executor } = mapTypeAndExecutor(item);
        await createItem({
          kind: item.kind ?? 'subtask',
          planId: item.id,
          title: `${item.id} ${item.title}`,
          status: PLAN_STATUS_MAP[item.status],
          descriptionMd: composeDescription(item),
          explanationMd: item.explanationMd?.trim() ?? null,
          estimateMinutes: item.estimateMinutes ?? null,
          type,
          executor,
          parentId: storyId,
        });
        for (const dep of item.dependsOn ?? []) dependsEdges.push({ from: item.id, to: dep });
      }
    }

    // Epic-direct leaves (standalone bugs parented to the epic, Jira shape).
    for (const item of epic.items ?? []) {
      const { type, executor } = mapTypeAndExecutor(item);
      await createItem({
        kind: item.kind ?? 'bug',
        planId: item.id,
        title: `${item.id} ${item.title}`,
        status: PLAN_STATUS_MAP[item.status],
        descriptionMd: composeDescription(item),
        explanationMd: item.explanationMd?.trim() ?? null,
        estimateMinutes: item.estimateMinutes ?? null,
        type,
        executor,
        parentId: epicId,
      });
      for (const dep of item.dependsOn ?? []) dependsEdges.push({ from: item.id, to: dep });
    }
  }

  // ── Link pass: depends_on → `is_blocked_by` (fromItem is_blocked_by toItem) ─
  let links = 0;
  let dangling = 0;
  for (const edge of dependsEdges) {
    const fromId = idMap.get(edge.from);
    const toId = idMap.get(edge.to);
    if (!fromId || !toId) {
      dangling++;
      if (dangling <= 20) console.warn(`  ⚠ dangling depends_on: ${edge.from} → ${edge.to}`);
      continue;
    }
    await db.$transaction((tx: Prisma.TransactionClient) =>
      workItemLinkRepository.create(
        {
          workspaceId: workspace.id,
          fromId,
          toId,
          kind: 'is_blocked_by',
          createdById: ownerId,
        },
        tx,
      ),
    );
    links++;
  }

  // ── Sprint pass: realistic sprints + leaf assignments (additive) ──────────
  // A coding-agent-cadence project runs SHORT, consecutive sprints (~3–5 days),
  // the most recent ending ~now. We create a handful of `complete`/`active`/
  // `planned` sprints in `motir` and bucket LEAF items (subtask/task/bug — never
  // epics/stories) into them by status, matching the work to the sprint state:
  //   • complete → `done` leaves (what was "built" in that window);
  //   • active   → mostly in_progress/todo (+ a couple done);
  //   • planned  → todo/blocked (upcoming).
  // Everything is DETERMINISTIC (PLAN order + the `hash`/`pick` helpers, no
  // Math.random) and IDEMPOTENT (the clear pass drops the workspace, so a reseed
  // rebuilds identically). Most leaves are LEFT in the backlog — realistic.
  //
  // Each assigned issue gets: a valid fractional-index `backlogRank` (minted via
  // `keyForAppend`, chained per-sprint — NEVER a padded number, which would break
  // drag-reorder) and a Fibonacci `storyPoints` estimate (the `hash` of its plan
  // id). The sprint's `committedPoints`/`committedIssueCount` snapshot = the sum/
  // count over its assigned items, so velocity/burndown read real data
  // (project.estimationStatistic defaults to `story_points`).
  const sprintSummary = await runSprintPass({
    workspaceId: workspace.id,
    projectId: project.id,
    idMap,
  });

  console.log(`\n✅ Seeded ${created} work items, ${links} dependency links.`);
  if (dangling) console.log(`   (${dangling} depends_on edge(s) referenced unknown ids — skipped)`);
  console.log(
    `🏃 Seeded ${sprintSummary.sprintCount} sprints ` +
      `(${sprintSummary.completeCount} complete, ${sprintSummary.activeCount} active, ` +
      `${sprintSummary.plannedCount} planned) · ${sprintSummary.assignedCount} issues assigned · ` +
      `${sprintSummary.pointed} story-pointed.`,
  );
  for (const line of sprintSummary.lines) console.log(`   ${line}`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:   ${OWNER_EMAIL} / ${SEED_PASSWORD}  (project manager)`);
  console.log(`  Team:      ${SEED_USERS.map((u) => u.email).join(', ')}`);
  console.log(
    `             (all passwords ${SEED_PASSWORD}; reporters/assignees drawn from the team)`,
  );
  console.log(`  Workspace: ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:   ${SEED_PROJECT_NAME} (${project.identifier})`);
  console.log(`  Project:   access=open · ${OWNER_EMAIL}=admin, rest=member (Story 6.4)`);
  console.log('  Open the project to browse the plan as an issue tree.');
  console.log('────────────────────────────────────────────────────────');
}

// ─── Sprint pass ────────────────────────────────────────────────────────────

/** A resolved LEAF plan card (subtask/task/bug) with its created work_item id. */
interface SprintLeaf {
  planId: string;
  workItemId: string;
  status: PlanStatus;
  kind: PlanLeafKind;
}

/** One sprint to create, with the plan statuses + batch size it draws items from. */
interface SprintSpec {
  name: string;
  goal: string;
  state: SprintState;
  /** Days from "now": sprint window [now+startOffset, now+endOffset]. */
  startOffsetDays: number | null;
  endOffsetDays: number | null;
  /** Plan statuses this sprint's items are drawn from, in preference order. */
  drawFrom: PlanStatus[];
  /** How many leaves to pull into the sprint. */
  size: number;
}

/** The day in ms — for the consecutive short-sprint windows. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The sprint plan: ~3 complete + 1 active + ~2 planned, consecutive ~4-day
 * windows with the most recent ACTIVE one ending a few days out (the active
 * sprint started ~2 days ago). Complete windows march backwards from the active
 * sprint's start; planned windows march forward from the active sprint's end.
 * Offsets are in days relative to "now" — deterministic given the run time
 * (dates are realistic, not reproducible-to-the-ms, which is expected of a
 * time-anchored seed). `drawFrom` matches the work to the state.
 */
const SPRINT_SPECS: readonly SprintSpec[] = [
  // Three completed sprints (oldest → newest), each a past ~4-day window.
  {
    name: 'Sprint 1 · Foundations',
    goal: 'Stand up auth, workspaces, and the project shell.',
    state: 'complete',
    startOffsetDays: -14,
    endOffsetDays: -10,
    drawFrom: ['done'],
    size: 14,
  },
  {
    name: 'Sprint 2 · Issue tree',
    goal: 'Ship the epic→story→task tree and the issue detail view.',
    state: 'complete',
    startOffsetDays: -10,
    endOffsetDays: -6,
    drawFrom: ['done'],
    size: 12,
  },
  {
    name: 'Sprint 3 · Boards & workflow',
    goal: 'Land the board, columns, and the workflow status model.',
    state: 'complete',
    startOffsetDays: -6,
    endOffsetDays: -2,
    drawFrom: ['done'],
    size: 10,
  },
  // The single active sprint — started ~2 days ago, ends ~2 days out.
  {
    name: 'Sprint 4 · Sprints & backlog',
    goal: 'Sprint entity, backlog ranking, velocity, and burndown.',
    state: 'active',
    startOffsetDays: -2,
    endOffsetDays: 2,
    drawFrom: ['in_progress', 'planned', 'done'],
    size: 10,
  },
  // Two planned sprints — upcoming work, future windows.
  {
    name: 'Sprint 5 · Reports & filters',
    goal: 'Saved filters, the report builder, and dashboards.',
    state: 'planned',
    startOffsetDays: 2,
    endOffsetDays: 6,
    drawFrom: ['planned', 'blocked'],
    size: 8,
  },
  {
    name: 'Sprint 6 · Native rewrite polish',
    goal: 'Localization polish and the design-system pass.',
    state: 'planned',
    startOffsetDays: 6,
    endOffsetDays: 10,
    drawFrom: ['planned', 'blocked'],
    size: 8,
  },
];

/**
 * Create the sprints + assign leaves. Walks PLAN in order (deterministic) to
 * collect the LEAF cards (subtask/task/bug — epics/stories are CONTAINERS, never
 * sprinted), buckets them by plan status, then fills each `SprintSpec` from its
 * preferred statuses without reusing an item. Per assigned item: a Fibonacci
 * `storyPoints` + a chained fractional-index `backlogRank` (per sprint). The
 * sprint's committed snapshot = the sum/count over its assigned items.
 */
async function runSprintPass(args: {
  workspaceId: string;
  projectId: string;
  idMap: Map<string, string>;
}): Promise<{
  sprintCount: number;
  completeCount: number;
  activeCount: number;
  plannedCount: number;
  assignedCount: number;
  pointed: number;
  lines: string[];
}> {
  const { workspaceId, projectId, idMap } = args;

  // The set of work_item ids actually created as LEAF kinds (subtask/bug/task).
  // We gate the resolved ids against THIS rather than trusting the plan kind: a
  // couple of plan ids collide between a story and a leaf in the source data
  // (e.g. story `1.0.5` "Design system & brand" vs leaf `1.0.5` "Vercel link"),
  // so an `idMap` lookup for such an id can resolve to the STORY's work_item.
  // Filtering on the real `work_item.kind` guarantees a CONTAINER (epic/story)
  // is never sprinted, whatever the colliding plan id resolved to.
  const leafKindRows = await db.workItem.findMany({
    where: { projectId, kind: { in: ['subtask', 'bug', 'task'] } },
    select: { id: true },
  });
  const leafWorkItemIds = new Set(leafKindRows.map((r) => r.id));

  // Collect every LEAF in PLAN order (stable), resolving the created id.
  const LEAF_KINDS: ReadonlySet<PlanLeafKind> = new Set(['subtask', 'bug', 'task']);
  const leaves: SprintLeaf[] = [];
  const seen = new Set<string>(); // de-dupe colliding plan ids → one work_item once
  const addLeaf = (item: PlanItem, defaultKind: PlanLeafKind) => {
    const kind = item.kind ?? defaultKind;
    if (!LEAF_KINDS.has(kind)) return;
    const workItemId = idMap.get(item.id);
    if (!workItemId) return; // never-created id (shouldn't happen) — skip
    if (!leafWorkItemIds.has(workItemId)) return; // resolved to a container — skip
    if (seen.has(workItemId)) return; // already bucketed (id collision) — skip
    seen.add(workItemId);
    leaves.push({ planId: item.id, workItemId, status: item.status, kind });
  };
  for (const epic of PLAN) {
    for (const story of epic.stories) for (const item of story.items) addLeaf(item, 'subtask');
    for (const item of epic.items ?? []) addLeaf(item, 'bug');
  }

  // Bucket by plan status; we draw from these without reuse (a consumed leaf is
  // removed from the head of its bucket, so no item lands in two sprints).
  const buckets: Record<PlanStatus, SprintLeaf[]> = {
    done: [],
    in_progress: [],
    planned: [],
    blocked: [],
    // Cancelled (won't-build tombstone) cards are never sprinted — no SprintSpec
    // draws from this bucket; it exists only to satisfy the Record's totality.
    cancelled: [],
  };
  for (const leaf of leaves) buckets[leaf.status].push(leaf);

  /** Pull up to `n` leaves preferring `statuses` in order; consumes from buckets. */
  const draw = (statuses: PlanStatus[], n: number): SprintLeaf[] => {
    const out: SprintLeaf[] = [];
    for (const status of statuses) {
      while (out.length < n && buckets[status].length > 0) {
        out.push(buckets[status].shift()!);
      }
      if (out.length >= n) break;
    }
    return out;
  };

  const now = Date.now();
  const at = (offsetDays: number | null): Date | null =>
    offsetDays === null ? null : new Date(now + offsetDays * DAY_MS);

  let sequence = 0;
  let assignedCount = 0;
  let pointed = 0;
  const lines: string[] = [];
  const counts = { complete: 0, active: 0, planned: 0 };

  for (const spec of SPRINT_SPECS) {
    sequence += 1;
    const seq = sequence;
    const items = draw(spec.drawFrom, spec.size);
    counts[spec.state] += 1;

    // Snapshot: committed points = Σ storyPoints over the assigned items,
    // committed issue count = the item count. Computed up-front so the create
    // can stamp it (the complete/active sprints carry a real "Committed" line).
    const points = items.map((leaf) => storyPointsFor(leaf.planId));
    const committedPoints = points.reduce((sum, p) => sum + p, 0);
    const committedIssueCount = items.length;

    const startDate = at(spec.startOffsetDays);
    const endDate = at(spec.endOffsetDays);
    // A completed sprint completed at its window end; active/planned have none.
    const completedAt = spec.state === 'complete' ? endDate : null;

    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const sprint = await sprintRepository.create(
        {
          workspaceId,
          projectId,
          name: spec.name,
          goal: spec.goal,
          state: spec.state,
          startDate,
          endDate,
          completedAt,
          // Only the complete + active sprints carry a committed baseline (a
          // planned sprint has not been started, so its baseline is null — Jira
          // shape); the assignments below still rank into all of them.
          committedPoints: spec.state === 'planned' ? null : committedPoints,
          committedIssueCount: spec.state === 'planned' ? null : committedIssueCount,
          sequence: seq,
        },
        tx,
      );

      // Assign each item: chain a valid fractional-index backlogRank per sprint
      // (keyForAppend(prev) — NEVER a padded number) + a Fibonacci storyPoints.
      let prevRank: string | null = null;
      for (let i = 0; i < items.length; i++) {
        const leaf = items[i]!;
        const rank = keyForAppend(prevRank);
        prevRank = rank;
        await workItemRepository.setSprint(leaf.workItemId, sprint.id, tx);
        await workItemRepository.setBacklogRank(leaf.workItemId, rank, tx);
        await workItemRepository.setStoryPoints(leaf.workItemId, points[i]!, tx);
      }
    });

    assignedCount += items.length;
    pointed += items.length;
    lines.push(
      `${spec.name} [${spec.state}] — ${items.length} issues, ` +
        `${committedPoints} pts (seq ${seq})`,
    );
  }

  return {
    sprintCount: SPRINT_SPECS.length,
    completeCount: counts.complete,
    activeCount: counts.active,
    plannedCount: counts.planned,
    assignedCount,
    pointed,
    lines,
  };
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exitCode = 1;
  });
