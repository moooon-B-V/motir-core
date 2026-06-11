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
import type { Prisma, WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { PLAN } from './data';
import { PLAN_STATUS_MAP, type PlanItem } from './types';

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

/** Compose the work-item description: a metadata blockquote + the card prose. */
function composeDescription(item: PlanItem): string | null {
  const meta: string[] = [];
  if (item.type) meta.push(`**Type:** ${item.type}`);
  if (item.executor) meta.push(`**Executor:** ${item.executor}`);
  if (item.estimateMinutes) meta.push(`**Estimate:** ${item.estimateMinutes}m`);
  if (item.dependsOn?.length) meta.push(`**Depends on:** ${item.dependsOn.join(', ')}`);
  const header = meta.length ? `> ${meta.join(' · ')}\n\n` : '';
  const body = item.descriptionMd?.trim() ?? '';
  const out = (header + body).trim();
  return out.length ? out : null;
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
    const workspaceIds = new Set(
      memberships.filter((m) => m.workspace.name === SEED_WORKSPACE_NAME).map((m) => m.workspaceId),
    );
    for (const workspaceId of workspaceIds) {
      // work_item.parent is onDelete:NoAction, so clear the set in one statement
      // first; the workspace then cascades project + memberships. Clearing the
      // items also frees the legacy user from any reporter FK so it can be removed.
      await db.workItem.deleteMany({ where: { workspaceId } });
      await db.workspace.delete({ where: { id: workspaceId } });
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
        await createItem({
          kind: item.kind ?? 'subtask',
          planId: item.id,
          title: `${item.id} ${item.title}`,
          status: PLAN_STATUS_MAP[item.status],
          descriptionMd: composeDescription(item),
          explanationMd: item.explanationMd?.trim() ?? null,
          estimateMinutes: item.estimateMinutes ?? null,
          parentId: storyId,
        });
        for (const dep of item.dependsOn ?? []) dependsEdges.push({ from: item.id, to: dep });
      }
    }

    // Epic-direct leaves (standalone bugs parented to the epic, Jira shape).
    for (const item of epic.items ?? []) {
      await createItem({
        kind: item.kind ?? 'bug',
        planId: item.id,
        title: `${item.id} ${item.title}`,
        status: PLAN_STATUS_MAP[item.status],
        descriptionMd: composeDescription(item),
        explanationMd: item.explanationMd?.trim() ?? null,
        estimateMinutes: item.estimateMinutes ?? null,
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

  console.log(`\n✅ Seeded ${created} work items, ${links} dependency links.`);
  if (dangling) console.log(`   (${dangling} depends_on edge(s) referenced unknown ids — skipped)`);
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

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exitCode = 1;
  });
