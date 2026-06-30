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
 * manage) — and the project's `accessLevel` is set to **`public`** (Story 6.12 —
 * the live tenant IS the public showcase: anyone reads /p/PROD with no sign-in;
 * flip to `open`/`private` to showcase member gating instead). Before 6.4 access
 * was workspace-level only.
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
 * Status preservation (Subtask 7.8.7 — the source-of-truth flip). The seed is
 * still the source of truth for plan STRUCTURE (the epic→story→leaf tree), but
 * NO LONGER for STATUS. Once agents/users transition statuses directly in the
 * live tenant (via the MCP `transition_status` tool, 7.8.5), a clear-and-reseed
 * that re-applied seed statuses would CLOBBER those live changes. So a seed
 * status is now INITIAL-ONLY: it is the status a NEW item is created with, and
 * a reseed PRESERVES the live `workflow_status` of items that already existed
 * in the tenant. Mechanically (see `./preserveStatus.ts`): BEFORE the clear we
 * snapshot the current status of every existing plan item keyed by its dotted
 * plan id (the stable title prefix), and AFTER re-creating the tree we re-apply
 * that snapshot to the items that existed before, leaving new items on their
 * seed status. A snapshotted status whose key is no longer in the target
 * workflow falls back to the seed status with a loader warning. The double
 * reseed stays idempotent (it snapshots the statuses it just preserved and
 * re-applies the same values). This is also why `.github/workflows/seed.yml`'s
 * `[reseed]` gate is safe for PLANNING merges: a reseed regenerates the tree
 * without reverting the user's hand/agent status flips.
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
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { keyForAppend } from '@/lib/workItems/positioning';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { PLAN, ROOT_BUGS } from './data';
import { composeDescription, mapTypeAndExecutor } from './mapItem';
import { MOTIR_PUBLIC_OVERVIEW_MD, MOTIR_PUBLIC_TAGLINE, MOTIR_PUBLIC_TAGS } from './motirOverview';
import { applyPreservedStatuses, snapshotLiveStatuses } from './preserveStatus';
import { SEED_TEST_PROJECT_NAME, seedGenerationTestProject } from './testProject';
import { seedSystemPrincipal } from './systemPrincipal';
import {
  SEED_STATUS_MAP,
  epicIdOf,
  type SeedItem,
  type SeedLeafKind,
  type SeedStatus,
} from './types';

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

  // The live `workflow_status` of every existing plan item, keyed by dotted plan
  // id, snapshotted BELOW (before the destructive clear) and re-applied AFTER the
  // tree is rebuilt — so a reseed PRESERVES statuses agents/users flipped in the
  // live tenant (seed status is initial-only; Subtask 7.8.7). Empty on a
  // first-ever seed → every item then keeps its seed status.
  let preservedStatuses = new Map<string, string>();

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
    // Snapshot live statuses BEFORE anything is deleted (Subtask 7.8.7). Keyed
    // by the dotted plan id (recovered from the stable title prefix), so it
    // survives the key reallocation a reseed does.
    preservedStatuses = await snapshotLiveStatuses(workspaceIds);
    for (const workspaceId of workspaceIds) {
      // work_item.parent is onDelete:NoAction, so clear the set in one statement
      // first; the workspace then cascades project + memberships. Clearing the
      // items also frees the legacy user from any reporter FK so it can be removed.
      await db.workItem.deleteMany({ where: { workspaceId } });
      await db.workspace.delete({ where: { id: workspaceId } });
    }
    // The orgs are now childless — drop them (cascades their OrganizationMembership
    // rows). This is slug-agnostic, so it also cleans an org whose slug a past
    // collision suffixed.
    for (const organizationId of organizationIds) {
      await db.organization.delete({ where: { id: organizationId } });
    }
    // Belt-and-suspenders: also remove any other org NAMED `moooon` whose
    // *every* org-membership belongs to a seed user — i.e. a seed-owned dupe
    // the workspace-driven sweep above missed. Two failure modes feed this
    // (visible as ≥5 `moooon` rows in the org switcher today):
    //   (a) past partial-reseed left an org whose workspace was already
    //       independently deleted, so no workspace-membership points at it
    //       (invisible to the `organizationIds`-from-WorkspaceMemberships
    //       sweep above) — but its ORG-memberships for seed users persist;
    //   (b) the slug-retry loop in `workspacesService.createWorkspace` minted
    //       a SUFFIXED slug (`moooon-xxxx`) when the unsuffixed slug was
    //       taken, so a `where: { slug: SEED_WORKSPACE_NAME }` deleteMany
    //       (the prior shape) only caught the one unsuffixed row.
    // Safety: only drop orgs whose memberships are a SUBSET of the known seed
    // user set. A real tenant who happened to name their org `moooon` would
    // have at least one non-seed-user member (themselves), so they're never
    // touched. `seedUserIds` covers BOTH the legacy single-owner account AND
    // the current team (it was built from `knownEmails` above).
    const seedUserIdSet = new Set(knownUsers.map((u) => u.id));
    const candidateOrgs = await db.organization.findMany({
      where: { name: SEED_WORKSPACE_NAME },
      include: { memberships: { select: { userId: true } } },
    });
    const seedOnlyOrgIds = candidateOrgs
      .filter(
        (o) => o.memberships.length > 0 && o.memberships.every((m) => seedUserIdSet.has(m.userId)),
      )
      .map((o) => o.id);
    if (seedOnlyOrgIds.length) {
      await db.organization.deleteMany({ where: { id: { in: seedOnlyOrgIds } } });
    }
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
    // The seed `moooon` org IS moooon B.V. — the META org: exempt from the §4
    // entitlement caps + the AI paywall. The prod row is flipped by the
    // add_organization_is_meta migration (WHERE slug = 'moooon'); that one-time
    // UPDATE does not re-run on reseed, so the seed sets it explicitly each time.
    await organizationRepository.update(organizationId, { isMeta: true }, tx);
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
  // manage). The project's accessLevel is set to `public` below (Story 6.12 —
  // the live tenant IS the public showcase); flip it to `'open'`/`'private'` to
  // demo workspace-member gating instead. The clear pass above deletes the
  // project (cascading its memberships), so a plain create is idempotent across
  // reseeds.
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
    // Story 6.12: the live tenant IS the public showcase — `public` so anyone
    // on the web reads its Overview / board / work items at /p/PROD with no
    // sign-in (the 6.12.4 anonymous public view), and its public hero
    // (`publicTagline` + `publicTags` + `publicOverviewMd`) is seeded to Motir's
    // canonical copy so the Overview renders real copy (Story 6.16 · 6.16.7 split
    // the tagline + tags out of the README body into their own hero fields).
    await projectRepository.setAccessLevel(project.id, 'public', { stampMadePublicAt: true }, tx);
    await projectRepository.setPublicOverview(
      project.id,
      {
        publicOverviewMd: MOTIR_PUBLIC_OVERVIEW_MD,
        publicTagline: MOTIR_PUBLIC_TAGLINE,
        publicTags: MOTIR_PUBLIC_TAGS,
      },
      tx,
    );
  });

  // ── A SECOND, onboarding-ready project: the AI-generation TEST BED (MOTIR-1426) ──
  // A fresh project under the SAME `moooon` workspace, with NO seeded tree and no
  // approved plan, so `onboardingRanAt` stays null and `/onboarding` LOADS for it
  // (the gate redirects to /roadmap only AFTER a plan is approved). AI access is
  // inherited from the org's `isMeta` flag. It is the test bed for the generation
  // ENTRY (MOTIR-1396) — distinct from the real `motir` plan project; reaching the
  // "Generate plan" entry then needs a `tiers_complete` pre-plan baseline seeded
  // in motir-ai (MOTIR-1430). The active-project pin above is deliberately NOT
  // touched — `motir` stays the default landing project; testers switch to this
  // one via the project switcher. Idempotent across reseeds (the clear pass
  // deletes the workspace, cascading its projects).
  const testProject = await seedGenerationTestProject({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    memberUserIds: SEED_USERS.map((u) => userIdByEmail.get(u.email)!),
  });

  // ── The Motir SYSTEM PRINCIPAL (MOTIR-1451) ───────────────────────────────
  // The reserved, non-loginnable service identity the AI self-learning loop
  // writes AS when it files a `kind: bug` into THIS meta project (the foundation
  // the `POST /api/internal/ai/work-items` route — MOTIR-1450 — consumes). A
  // member of the `moooon` workspace + the `motir` project, so its
  // service-authenticated creates satisfy `assertReporterMember` + the 6.4 edit
  // gate. Idempotent across reseeds (the clear pass cascades its memberships;
  // the user row is reused by email upsert).
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });

  // ── Tree pass: create every epic → story → leaf through the shipped path ──
  let created = 0;
  const idMap = new Map<string, string>(); // dotted plan id → work_item id
  const dependsEdges: Array<{ from: string; to: string }> = [];

  // A VALID, GLOBALLY-UNIQUE fractional-index `position` per item, chained in
  // creation order. `position` MUST be a real fractional-index key (the shape
  // `lib/workItems/positioning.ts` mints) — NOT a zero-padded number. A padded
  // number like "00000612" has head '0', which `generateKeyBetween` rejects
  // ("invalid order key head: 0"), so ANY board drag landing next to such a card
  // throws → the move API 500s and the board shows "Move not allowed" (the same
  // class of bug the `backlogRank` chain below already avoids).
  //
  // The chain is GLOBAL, not per-parent: a board column orders cards by
  // `position` ACROSS parents, so two items must never share a key — otherwise
  // dropping a card between two equal-keyed neighbours calls keyBetween(k, k),
  // which throws "prev >= next" → another 500. A single ascending chain keeps
  // every key distinct (matching the old padded WORK-ITEM-NUMBER's global
  // ordering) while staying valid; siblings are created consecutively so each
  // parent's children still sort correctly under the tree.
  let lastPosition: string | null = null;

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
    // Mint this item's globally-unique fractional-index position (ascending).
    const position = keyForAppend(lastPosition);
    lastPosition = position;
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
          position,
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
      status: SEED_STATUS_MAP[epic.status],
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
        status: SEED_STATUS_MAP[story.status],
        descriptionMd: storyDesc.length ? storyDesc : null,
        parentId: epicId,
      });

      for (const item of story.items) {
        const { type, executor } = mapTypeAndExecutor(item);
        await createItem({
          kind: item.kind ?? 'subtask',
          planId: item.id,
          title: `${item.id} ${item.title}`,
          status: SEED_STATUS_MAP[item.status],
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
        status: SEED_STATUS_MAP[item.status],
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

  // Top-level parentless bugs (root siblings of the epics — MOTIR.md's
  // bug-parent rule when the related epic is `done`). `bug.parentId IS NULL`
  // is legal under the kind-parent matrix in work_item_triggers.sql.
  for (const item of ROOT_BUGS) {
    const { type, executor } = mapTypeAndExecutor(item);
    await createItem({
      kind: item.kind ?? 'bug',
      planId: item.id,
      title: `${item.id} ${item.title}`,
      status: SEED_STATUS_MAP[item.status],
      descriptionMd: composeDescription(item),
      explanationMd: item.explanationMd?.trim() ?? null,
      estimateMinutes: item.estimateMinutes ?? null,
      type,
      executor,
      parentId: null,
    });
    for (const dep of item.dependsOn ?? []) dependsEdges.push({ from: item.id, to: dep });
  }

  // ── Status-preservation pass (Subtask 7.8.7) ─────────────────────────────
  // Re-apply the statuses snapshotted before the clear, so a reseed PRESERVES
  // the live workflow status of items that already existed (seed status is now
  // INITIAL-ONLY — it stays only on NEW items). Matched by dotted plan id; a
  // snapshotted status no longer in the target workflow keeps the seed status
  // with a warning. No-op on a first-ever seed (empty snapshot).
  const preserve = await applyPreservedStatuses({ snapshot: preservedStatuses, idMap });

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
  if (preserve.preserved || preserve.fellBack) {
    console.log(
      `🔁 Preserved ${preserve.preserved} live status(es) from the prior tenant` +
        (preserve.fellBack ? ` (${preserve.fellBack} fell back to seed status)` : '') +
        ` — seed status is initial-only (7.8.7).`,
    );
    for (const w of preserve.warnings) console.warn(`   ⚠ ${w}`);
  }
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
  console.log(`  Project:   access=public · ${OWNER_EMAIL}=admin, rest=member (Story 6.4/6.12)`);
  console.log(`  Public:    /p/${project.identifier} — anonymous public view (Story 6.12.4)`);
  console.log(
    `  Test bed:  ${SEED_TEST_PROJECT_NAME} (${testProject.identifier}) — onboarding-ready for AI generation (MOTIR-1396); open /onboarding`,
  );
  console.log('  Open the project to browse the plan as an issue tree.');
  console.log('────────────────────────────────────────────────────────');
}

// ─── Sprint pass ────────────────────────────────────────────────────────────

/** A resolved LEAF plan card (subtask/task/bug) with its created work_item id. */
interface SprintLeaf {
  planId: string;
  workItemId: string;
  status: SeedStatus;
  kind: SeedLeafKind;
}

/** One sprint to create (computed dynamically — see `buildSprints`). */
interface SprintSpec {
  name: string;
  goal: string;
  state: SprintState;
  startDate: Date | null;
  endDate: Date | null;
  /** The exact leaves assigned to this sprint (no reuse across sprints). */
  items: SprintLeaf[];
}

/** The day in ms — for the consecutive short-sprint windows. */
const DAY_MS = 24 * 60 * 60 * 1000;

// The sprint history covers EVERY leaf (user request, last reseed): rather than
// a fixed handful of sprints with size caps that leave most work in the backlog,
// we partition ALL leaves into consecutive short sprints so the board / velocity
// / burndown read a full, realistic project history.
//
//   • LEAVES_PER_SPRINT — a realistic ~4-day batch for a 6-person team (subtasks
//     are small). The sprint COUNT is emergent (≈ done/size complete + active +
//     ≈ upcoming/size planned), which for an 8-epic product is dozens of sprints
//     — exactly what a months-long short-cadence project looks like.
//   • DONE leaves (in PLAN order) → consecutive COMPLETE sprints marching back in
//     time (Sprint 1 = the oldest work); IN_PROGRESS leaves → the single ACTIVE
//     sprint (Jira allows one active); PLANNED + BLOCKED leaves → PLANNED sprints
//     marching forward. CANCELLED leaves are never sprinted.
//   • Each sprint is themed by the dominant story/epic of its items, so the names
//     read like a real backlog ("Sprint 12 · Triage inbox").
const LEAVES_PER_SPRINT = 16;
/** Each sprint window is this many days; the active sprint straddles "now". */
const SPRINT_DAYS = 4;
/** The active sprint started ~2 days ago and ends ~2 days out (it straddles now). */
const ACTIVE_START_DAYS = -2;
const ACTIVE_END_DAYS = ACTIVE_START_DAYS + SPRINT_DAYS;

/** Split an array into consecutive chunks of `size` (last chunk may be short). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Epic title by epic id, and story title by 2-segment story id — for theming. */
const EPIC_TITLE_BY_ID = new Map(PLAN.map((e) => [e.id, e.title]));
const STORY_TITLE_BY_ID = new Map<string, string>();
for (const e of PLAN) for (const s of e.stories) STORY_TITLE_BY_ID.set(s.id, s.title);

/** The 2-segment story id of a dotted plan id (`6.11.10` → `6.11`). */
function storyIdOf(planId: string): string {
  const parts = planId.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : planId;
}

/** A short theme label for a sprint: the dominant story's title (parenthetical
 * stripped), falling back to the dominant epic's title. */
function themeFor(items: readonly SprintLeaf[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const sid = storyIdOf(it.planId);
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  let bestId = '';
  let bestN = -1;
  for (const [id, n] of counts) {
    if (n > bestN) {
      bestId = id;
      bestN = n;
    }
  }
  const title =
    STORY_TITLE_BY_ID.get(bestId) ?? EPIC_TITLE_BY_ID.get(epicIdOf(bestId)) ?? 'Delivery';
  // Drop a trailing parenthetical for a tidy sprint name.
  return title.split(' (')[0]!.trim();
}

/**
 * Partition every leaf into a full sprint history (deterministic, plan-ordered):
 * DONE → consecutive COMPLETE sprints ending at the active sprint's start;
 * IN_PROGRESS → the one ACTIVE sprint straddling now; PLANNED+BLOCKED → PLANNED
 * sprints marching forward. Sprint windows are `SPRINT_DAYS` apart; `sequence`
 * runs chronologically (oldest complete = 1).
 */
function buildSprints(leaves: readonly SprintLeaf[]): SprintSpec[] {
  const now = Date.now();
  const day = (offset: number): Date => new Date(now + offset * DAY_MS);

  // Plan-ordered leaves by lifecycle bucket (cancelled is never sprinted).
  const done = leaves.filter((l) => l.status === 'done');
  const inProgress = leaves.filter((l) => l.status === 'in_progress');
  const upcoming = leaves.filter((l) => l.status === 'planned' || l.status === 'blocked');

  const completeChunks = chunk(done, LEAVES_PER_SPRINT);
  const plannedChunks = chunk(upcoming, LEAVES_PER_SPRINT);
  // The active sprint holds the in-progress work; if there is none, it pulls the
  // first upcoming chunk forward so a mid-flight project always has one.
  const activeItems = inProgress.length > 0 ? inProgress : (plannedChunks.shift() ?? []);

  const specs: SprintSpec[] = [];
  const n = completeChunks.length;

  // Complete sprints — oldest (i=0) → newest (i=n-1); the newest ends where the
  // active sprint starts, and each is a `SPRINT_DAYS` window marching back.
  completeChunks.forEach((items, i) => {
    const endOffset = ACTIVE_START_DAYS - (n - 1 - i) * SPRINT_DAYS;
    specs.push({
      name: `Sprint ${specs.length + 1} · ${themeFor(items)}`,
      goal: `Ship the ${themeFor(items)} work.`,
      state: 'complete',
      startDate: day(endOffset - SPRINT_DAYS),
      endDate: day(endOffset),
      items,
    });
  });

  // The single active sprint, straddling now.
  if (activeItems.length > 0) {
    specs.push({
      name: `Sprint ${specs.length + 1} · ${themeFor(activeItems)}`,
      goal: `In flight: the ${themeFor(activeItems)} work.`,
      state: 'active',
      startDate: day(ACTIVE_START_DAYS),
      endDate: day(ACTIVE_END_DAYS),
      items: activeItems,
    });
  }

  // Planned sprints — upcoming work, future windows marching forward.
  plannedChunks.forEach((items, p) => {
    const startOffset = ACTIVE_END_DAYS + p * SPRINT_DAYS;
    specs.push({
      name: `Sprint ${specs.length + 1} · ${themeFor(items)}`,
      goal: `Up next: the ${themeFor(items)} work.`,
      state: 'planned',
      startDate: day(startOffset),
      endDate: day(startOffset + SPRINT_DAYS),
      items,
    });
  });

  return specs;
}

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
    select: { id: true, status: true, kind: true },
  });
  const leafWorkItemIds = new Set(leafKindRows.map((r) => r.id));

  // Invert SEED_STATUS_MAP (planned→todo, …) so an orphan's DB workflow status
  // maps back to a plan lifecycle bucket for the sweep below. The seed creates
  // items with these initial keys; anything unexpected falls back to `planned`.
  const planStatusByWorkflowKey = new Map<string, SeedStatus>(
    (Object.entries(SEED_STATUS_MAP) as [SeedStatus, string][]).map(([plan, key]) => [key, plan]),
  );

  // Collect every LEAF in PLAN order (stable), resolving the created id.
  const LEAF_KINDS: ReadonlySet<SeedLeafKind> = new Set(['subtask', 'bug', 'task']);
  const leaves: SprintLeaf[] = [];
  const seen = new Set<string>(); // de-dupe colliding plan ids → one work_item once
  const addLeaf = (item: SeedItem, defaultKind: SeedLeafKind) => {
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

  // Sweep up any LEAF work_item the PLAN walk couldn't reach via `idMap` — the
  // 2 plan-id collisions (`1.0.5` is BOTH a story and a leaf) leave their leaf
  // unreachable by plan id, so it'd otherwise never be sprinted. Append them
  // (status from the DB) so EVERY leaf is covered (the "cover all" request).
  for (const row of leafKindRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    leaves.push({
      planId: row.id,
      workItemId: row.id,
      status: planStatusByWorkflowKey.get(row.status) ?? 'planned',
      kind: row.kind as SeedLeafKind,
    });
  }

  // Partition EVERY leaf into a full sprint history (done → complete sprints,
  // in_progress → the active sprint, planned/blocked → planned sprints). The
  // sprint count is emergent, so the whole backlog is covered — no large
  // unsprinted remainder (the user's "cover all the work items" request).
  const specs = buildSprints(leaves);

  let sequence = 0;
  let assignedCount = 0;
  let pointed = 0;
  const lines: string[] = [];
  const counts = { complete: 0, active: 0, planned: 0 };

  for (const spec of specs) {
    sequence += 1;
    const seq = sequence;
    const items = spec.items;
    counts[spec.state] += 1;

    // Snapshot: committed points = Σ storyPoints over the assigned items,
    // committed issue count = the item count. Computed up-front so the create
    // can stamp it (the complete/active sprints carry a real "Committed" line).
    const points = items.map((leaf) => storyPointsFor(leaf.planId));
    const committedPoints = points.reduce((sum, p) => sum + p, 0);
    const committedIssueCount = items.length;

    const startDate = spec.startDate;
    const endDate = spec.endDate;
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
    sprintCount: specs.length,
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
