/**
 * `pnpm db:seed:large` — seed a REAL-SCALE demo project (Subtask 2.5.16,
 * finding #57). Dev tooling only: it makes the finding-#57 scale work
 * (List pagination 2.5.12 · lazy-load + virtualization 2.5.14/2.5.15)
 * *visible* in the UI — you can't see pagination or lazy-load do anything with
 * 7 issues.
 *
 * Creates one self-contained demo tenant (a fixed user + workspace + project)
 * and a few-thousand-issue tree:
 *   - many ROOT epics (so the flat List spans many pages + roots paginate),
 *   - one epic with > the per-node page (50) of children (to exercise the Tree's
 *     "Load more children" + virtualization), and a deep branch under it,
 *   - the rest with a handful of children each.
 *
 * IDEMPOTENT: re-running clears its OWN demo workspace (by name, owned by the
 * fixed seed user) and reseeds — it never touches any other workspace's data.
 * Runs through the shipped services / repository create path (no raw inserts
 * that skip the kind-parent triggers). NOT part of the production bundle
 * (scripts/ isn't in the Next app); refuses to run under NODE_ENV=production.
 *
 * Tune the size with env: SEED_ROOTS, SEED_BIG_CHILDREN, SEED_SMALL_CHILDREN,
 * SEED_DEEP_CHILDREN (defaults below ≈ 2,000 issues).
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import type { Prisma, WorkItemKind } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

const SEED_EMAIL = 'seed-large@prodect.dev';
const SEED_PASSWORD = 'hunter2hunter2'; // satisfies the credential-strength rule
const SEED_WORKSPACE_NAME = 'Seed — Large (finding #57)';
const SEED_PROJECT_NAME = 'Large backlog';
const SEED_PROJECT_IDENTIFIER = 'BIG';

const n = (env: string, dflt: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : dflt;
};
const ROOTS = n('SEED_ROOTS', 60); // → ~2 List pages of roots, roots paginate in the tree
const BIG_CHILDREN = n('SEED_BIG_CHILDREN', 130); // epic[0] → "Load more children" (50/50/30)
const DEEP_CHILDREN = n('SEED_DEEP_CHILDREN', 90); // a story under epic[0] → nested load-more
const SMALL_CHILDREN = n('SEED_SMALL_CHILDREN', 30); // the other epics

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed:large is a DEV tool — refusing to run under NODE_ENV=production.');
  }

  // ── Idempotent clear: drop this seed user's prior demo workspace(s) ────────
  const existingUser = await db.user.findUnique({ where: { email: SEED_EMAIL } });
  if (existingUser) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: existingUser.id },
      include: { workspace: true },
    });
    for (const m of memberships) {
      if (m.workspace.name === SEED_WORKSPACE_NAME) {
        // Delete the work_items first (the self-FK parent is onDelete:NoAction,
        // so clear the set in one statement), then the workspace cascades the
        // project + memberships.
        await db.workItem.deleteMany({ where: { workspaceId: m.workspaceId } });
        await db.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
  }

  // ── Tenant: a fixed user (reused if present) + a fresh workspace + project ──
  const owner =
    existingUser ??
    (await usersService.createUser({
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      name: 'Seed Owner',
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

  // ── Bulk create through the shipped allocate-key + repo.create dance ───────
  let created = 0;
  const tick = () => {
    created++;
    if (created % 250 === 0) process.stdout.write(`  …${created} issues\n`);
  };

  async function createItem(
    kind: WorkItemKind,
    title: string,
    parentId: string | null,
  ): Promise<string> {
    const id = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const key = await projectRepository.allocateWorkItemNumber(project.id, tx);
      const row = await workItemRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          parentId,
          kind,
          key,
          identifier: `${project.identifier}-${key}`,
          title,
          reporterId: owner.id,
          position: String(key).padStart(8, '0'),
        },
        tx,
      );
      return row.id;
    });
    tick();
    return id;
  }

  console.log(`Seeding ${ROOTS} root epics…`);
  for (let r = 0; r < ROOTS; r++) {
    const epicId = await createItem('epic', `Epic ${r + 1}`, null);

    // The FIRST epic is the "big" one: many children (load-more) + a deep branch.
    if (r === 0) {
      for (let c = 0; c < BIG_CHILDREN; c++) {
        const storyId = await createItem('story', `Story ${r + 1}.${c + 1}`, epicId);
        if (c === 0) {
          for (let d = 0; d < DEEP_CHILDREN; d++) {
            const taskId = await createItem('task', `Task ${r + 1}.${c + 1}.${d + 1}`, storyId);
            if (d % 10 === 0)
              await createItem('subtask', `Subtask of ${r + 1}.${c + 1}.${d + 1}`, taskId);
          }
        }
      }
      continue;
    }

    // The rest: a handful of stories, a couple with a task or bug, for variety.
    for (let c = 0; c < SMALL_CHILDREN; c++) {
      const storyId = await createItem('story', `Story ${r + 1}.${c + 1}`, epicId);
      if (c % 7 === 0) await createItem('task', `Task ${r + 1}.${c + 1}.1`, storyId);
      if (c % 11 === 0) await createItem('bug', `Bug under ${r + 1}.${c + 1}`, storyId);
    }
  }

  console.log(`\n✅ Seeded ${created} issues.`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:   ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  Workspace: ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:   ${SEED_PROJECT_NAME} (${project.identifier})`);
  console.log('  Then open  /issues  — switch Tree ↔ List, expand nodes, page through.');
  console.log('────────────────────────────────────────────────────────');
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exitCode = 1;
  });
