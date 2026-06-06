/**
 * `pnpm db:seed` — seed the REAL Prodect build plan into a real tenant so the
 * plan can be browsed inside Prodect itself, and so the seed is the single
 * source of truth for planning (PRODECT.md; `prodect_plan/` is now a frozen
 * archive). The plan tree lives in `./data/` (one typed module per story);
 * this loader walks it and writes the work-item tree + dependency links.
 *
 * Tenant (fixed): the `moooon` workspace + `prodect` project owned by a single
 * user. Re-running is IDEMPOTENT — it clears ONLY this tenant's `moooon`
 * workspace (by name, owned by the fixed user) and reseeds; it never touches
 * any other workspace's data. Everything is written through the shipped
 * services / repositories (no raw inserts that would skip the kind-parent
 * triggers), so the seed exercises the same create path the app does.
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
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { PLAN } from './data';
import { PLAN_STATUS_MAP, type PlanItem } from './types';

const SEED_EMAIL = 'info@moooon.net';
const SEED_PASSWORD = '!QAZ1qaz';
const SEED_OWNER_NAME = 'Moooon';
const SEED_WORKSPACE_NAME = 'moooon';
const SEED_PROJECT_NAME = 'prodect';
const SEED_PROJECT_IDENTIFIER = 'PROD';

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

  // ── Idempotent clear: drop this tenant's prior `moooon` workspace ──────────
  const existingUser = await db.user.findUnique({ where: { email: SEED_EMAIL } });
  if (existingUser) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: existingUser.id },
      include: { workspace: true },
    });
    for (const m of memberships) {
      if (m.workspace.name === SEED_WORKSPACE_NAME) {
        // work_item.parent is onDelete:NoAction, so clear the set in one
        // statement first; the workspace then cascades project + memberships.
        await db.workItem.deleteMany({ where: { workspaceId: m.workspaceId } });
        await db.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
  }

  // ── Tenant: fixed user (reused if present) + fresh workspace + project ─────
  const owner =
    existingUser ??
    (await usersService.createUser({
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      name: SEED_OWNER_NAME,
    }));
  const { workspace } = await workspacesService.createWorkspace({
    name: SEED_WORKSPACE_NAME,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: SEED_PROJECT_NAME,
    identifier: SEED_PROJECT_IDENTIFIER,
    workspaceId: workspace.id,
    actorUserId: owner.id,
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
          estimateMinutes: args.estimateMinutes ?? undefined,
          reporterId: owner.id,
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
          createdById: owner.id,
        },
        tx,
      ),
    );
    links++;
  }

  console.log(`\n✅ Seeded ${created} work items, ${links} dependency links.`);
  if (dangling) console.log(`   (${dangling} depends_on edge(s) referenced unknown ids — skipped)`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:   ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  Workspace: ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:   ${SEED_PROJECT_NAME} (${project.identifier})`);
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
