import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  DEFAULT_BUG_CONTAINER_KIND,
  DEFAULT_BUG_CONTAINER_TITLE,
} from '@/lib/bugs/defaultBugContainer';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The bug container seeded at project creation — Story MOTIR-4927 · Subtask
// MOTIR-4935.
//
// What this card turns into an invariant: `ensure_planner_bug_home` is a DATA
// MIGRATION, and `lib/ai/plannerBugHome.ts` says in its own header that "a
// migration runs EXACTLY ONCE per database: it is a one-shot backfill, not a
// standing guarantee". Seeding on the event that creates the project is the only
// shape that cannot drift — so the load-bearing assertions here are (a) every
// newly created project has a container AND a pointer at it, and (b) a project
// creation that FAILS leaves no container behind.
//
// ⚠️ (b) is forced, not reasoned about. The card asks for exactly that, because
// "it's in the same transaction" is a claim about code and the retry path is the
// only thing that can falsify it.

let seq = 0;

async function makeWorkspace(tag: string) {
  const n = seq++;
  const user = await usersService.createUser({
    email: `bug-seed-${tag}-${n}@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${tag}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${tag} ${n}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('a newly created project', () => {
  it('has exactly one bug container, and a destination pointing at it', async () => {
    const { userId, workspaceId } = await makeWorkspace('has');

    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Seeded',
    });

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    const items = await adminDb.workItem.findMany({ where: { projectId: project.id } });

    expect(items).toHaveLength(1);
    expect(row.bugDestinationId).toBe(items[0]!.id);
  });

  it('seeds it as a `task` with a non-empty body — a bucket is not a feature, and it says what it is for', async () => {
    const { userId, workspaceId } = await makeWorkspace('kind');

    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Kinded',
    });

    const container = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: project.id },
    });

    // `task -> bug` is legal in the kind-parent matrix, so a `task` holds bugs
    // correctly — and every rollup and journey audit that reads kinds is spared
    // a `story` that is never finished because it is a bucket.
    expect(container.kind).toBe(DEFAULT_BUG_CONTAINER_KIND);
    expect(container.title).toBe(DEFAULT_BUG_CONTAINER_TITLE);
    expect(container.descriptionMd ?? '').not.toBe('');
    expect(container.parentId).toBeNull();
  });

  it('gives it a LEGAL initial status from the workflow seeded in the same transaction', async () => {
    const { userId, workspaceId } = await makeWorkspace('status');

    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Statused',
    });

    const container = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: project.id },
    });
    const initial = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: project.id, isInitial: true },
    });

    // Read back rather than asserted to be `todo`: the seed resolves the status
    // from the statuses just written, so this stays true if the default workflow
    // ever changes which status is initial.
    expect(container.status).toBe(initial.key);
  });

  it('allocates the container a real key, so the next work item does not collide with it', async () => {
    const { userId, workspaceId } = await makeWorkspace('key');

    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Keyed',
    });

    const container = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: project.id },
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });

    expect(container.identifier).toBe(`${row.identifier}-${container.key}`);
    // The counter was ADVANCED, not guessed past — the next create allocates the
    // following number rather than re-issuing the container's.
    expect(row.lastWorkItemNumber).toBe(container.key);
  });

  it('reports the creating actor as the container’s reporter', async () => {
    const { userId, workspaceId } = await makeWorkspace('reporter');

    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Reported',
    });

    const container = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: project.id },
    });
    // `reporterId` is NOT NULL with `onDelete: Restrict` and there is no system
    // principal at project-creation time, so the actor is threaded in from the
    // caller rather than resolved inside the seam.
    expect(container.reporterId).toBe(userId);
  });
});

describe('the retry path', () => {
  it('leaves NO orphan container when an identifier collision rolls the project back', async () => {
    // FORCED, not reasoned about. Two projects asked for the SAME identifier in
    // one workspace: the second collides on the unique index, its transaction
    // rolls back, and `createProject` retries with a suffixed identifier in a
    // FRESH transaction. If the container were seeded outside that transaction,
    // the rolled-back attempt would leave a stray `work_item` behind — in a
    // table where nobody would ever look for one.
    const { userId, workspaceId } = await makeWorkspace('collide');

    const first = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Collide',
      identifier: 'CLD',
    });
    const second = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Collide Two',
      identifier: 'CLD',
    });

    // The retry really happened — the second project did not get the identifier
    // it asked for. Without this the test would pass on a tree where nothing
    // collided at all.
    const firstRow = await adminDb.project.findUniqueOrThrow({ where: { id: first.id } });
    const secondRow = await adminDb.project.findUniqueOrThrow({ where: { id: second.id } });
    expect(firstRow.identifier).toBe('CLD');
    expect(secondRow.identifier).not.toBe('CLD');

    // One container per surviving project, and not one more. A container from
    // the rolled-back attempt would land here as a third row.
    const all = await adminDb.workItem.findMany({
      where: { projectId: { in: [first.id, second.id] } },
    });
    expect(all).toHaveLength(2);

    for (const project of [firstRow, secondRow]) {
      const own = all.filter((i) => i.projectId === project.id);
      expect(own).toHaveLength(1);
      expect(project.bugDestinationId).toBe(own[0]!.id);
    }

    // And no container belonging to no project at all.
    const orphans = await adminDb.workItem.findMany({
      where: { title: DEFAULT_BUG_CONTAINER_TITLE, projectId: { notIn: [first.id, second.id] } },
    });
    expect(orphans).toHaveLength(0);
  });
});

describe('the title is a LABEL, and nothing resolves by it', () => {
  it('is imported only by the seed and by tests — never by a read path', () => {
    // ⚠️ The card's own criterion, and it is a RATCHET rather than a one-off
    // check: the destination is a POINTER precisely so a team can rename their
    // container, and a title lookup anywhere would rebuild the fragility
    // `lib/ai/plannerBugHome.ts` documents — invisibly, because it works
    // perfectly until the first rename.
    //
    // The check is over the VALUE as well as the symbol: a reader that hardcodes
    // the string never imports the constant, so a symbol-only sweep is
    // structurally unable to see it. (That is not hypothetical in this tree —
    // `tests/github/explicitLinkStory.test.ts` reaches the LEGACY home by its
    // bare title rather than through `PLANNER_BUG_HOME_STORY_TITLE`.)
    const roots = ['lib', 'app', 'components', 'packages', 'scripts'];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walk(join(process.cwd(), root))) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (file.includes('/lib/bugs/defaultBugContainer.ts')) continue;
        const body = readFileSync(file, 'utf8');
        const importsConstant = body.includes('DEFAULT_BUG_CONTAINER_TITLE');
        const hardcodesValue = new RegExp(
          `['\`"]${DEFAULT_BUG_CONTAINER_TITLE}['\`"]\\s*[,)\\]}]`,
        ).test(body);
        if (!importsConstant && !hardcodesValue) continue;

        // The SEED is the one legitimate writer. Anything else naming the title
        // is a read path, and a read path must use the pointer.
        const isTheSeed = file.endsWith('/lib/services/workItemsService.ts');
        if (isTheSeed) {
          // …and even there, only to WRITE it. A `findFirst` by title inside the
          // seam would be the same defect one file over.
          expect(body).not.toMatch(/title:\s*DEFAULT_BUG_CONTAINER_TITLE[\s\S]{0,200}?findFirst/);
          continue;
        }
        offenders.push(file.replace(process.cwd() + '/', ''));
      }
    }

    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
