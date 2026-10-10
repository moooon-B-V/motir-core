import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { homeService, type HomeActorContext } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { HomePageDto } from '@/lib/dto/home';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';

// ONE RUNNABLE-CONTAINER DEFINITION, ONE GROUP RANK (Story MOTIR-8012 · MOTIR-8017).
//
// The Workbench's grouped tabs and `/ready`'s leaves lane both answer "which container
// does this item sit under, and in what order do the groups come". The story's promise is
// that they answer it with the SAME rule, so a person never sees a story as a group on one
// page and as loose rows on the other. Two halves hold it:
//
// - a SOURCE SCAN, cheap, which catches a re-declaration: the Workbench reads the rule and
//   the grouping from `lib/workItems/readyFilter.ts` and declares neither itself;
// - a BEHAVIOURAL PARITY read against a real Postgres, which catches what a scan cannot —
//   a copy that compiles, imports nothing suspicious, and silently orders differently.
//
// MOTIR-8015 EXTRACTED the grouping rather than copying it: `groupByContainer` in
// `readyFilter.ts` is called by both `/ready`'s `groupLaneRows` and `homeService`.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Every source file under a `workbench` directory of `app/`, route groups included. */
function workbenchAppFiles(dir = join(ROOT, 'app')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...workbenchAppFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && path.includes(`${join('/', 'workbench', '/')}`))
      out.push(path.slice(ROOT.length + 1));
  }
  return out;
}

/** A kinds literal naming the three runnable-container kinds, in any order. */
const KINDS_LITERAL =
  /\[\s*(['"])(story|task|bug)\1\s*,\s*(['"])(story|task|bug)\3\s*,\s*(['"])(story|task|bug)\5\s*\]/;
const LOCAL_DECLARATION =
  /(function|const|let)\s+(isRunnableContainer|groupRank|groupByContainer|RUNNABLE_CONTAINER_KINDS)\b/;

describe('C1 · the Workbench imports the rule; it does not copy it', () => {
  it('homeService imports the rule and the grouping from readyFilter', () => {
    const source = read('lib/services/homeService.ts');
    const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/workItems\/readyFilter'/);
    expect(imported, 'homeService no longer imports from readyFilter').not.toBeNull();
    const names = imported![1]!.split(',').map((n) => n.trim());
    expect(names).toEqual(expect.arrayContaining(['isRunnableContainer', 'groupByContainer']));
  });

  it('/ready groups through the same helper', () => {
    const source = read('lib/services/workItemsService.ts');
    expect(source).toMatch(/groupByContainer\(/);
  });

  it('the shared helper ranks groups by groupRank and members by compareReadyPosition', () => {
    const source = read('lib/workItems/readyFilter.ts');
    const body = source.slice(source.indexOf('export function groupByContainer'));
    const end = body.indexOf('\n}\n');
    const helper = body.slice(0, end);
    expect(helper).toMatch(/groupRank\(/);
    expect(helper).toMatch(/compareReadyPosition\(/);
  });

  it('neither homeService nor any Workbench file declares the kinds or the rank itself', () => {
    const files = ['lib/services/homeService.ts', ...workbenchAppFiles()];
    // SENSITIVITY: the walk found the Workbench's own components.
    expect(files).toEqual(
      expect.arrayContaining([
        'app/(authed)/workbench/_components/WorkbenchList.tsx',
        'app/(authed)/workbench/_components/WorkbenchGroupRow.tsx',
        'app/(authed)/workbench/_components/workbenchRows.ts',
      ]),
    );
    for (const file of files) {
      const source = read(file);
      expect(source, `${file} declares a kinds literal`).not.toMatch(KINDS_LITERAL);
      expect(source, `${file} declares the rule or the rank`).not.toMatch(LOCAL_DECLARATION);
    }
  });

  it('the scan’s patterns catch what they are for (counterfactual)', () => {
    expect("const KINDS = ['story', 'task', 'bug'];").toMatch(KINDS_LITERAL);
    expect('["bug","story","task"]').toMatch(KINDS_LITERAL);
    expect('function isRunnableContainer(shape) {').toMatch(LOCAL_DECLARATION);
    expect('const groupRank = (a, b) => 0;').toMatch(LOCAL_DECLARATION);
  });
});

// ── C2 · the same groups in the same order ────────────────────────────────────

let fx: WorkItemFixture;
let otherId: string;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'ONE' });
  otherId = (await createTestUser({ name: 'Somebody else' })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = (): HomeActorContext => ({ ...fx.ctx, projectId: fx.projectId });

async function item(
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
  title: string,
  parentId?: string,
  priority?: 'highest' | 'high' | 'medium' | 'low' | 'lowest',
) {
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      ...(parentId ? { parentId } : {}),
      ...(priority ? { priority } : {}),
    },
    fx.ctx,
  );
  return { id: created.id, identifier: created.identifier };
}

/** Someone else's container — so on the Workbench it heads as CONTEXT, as on /ready. */
async function theirs(id: string): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: { reporterId: otherId, assigneeId: otherId },
  });
}

type Groups = { head: string; members: string[] }[];

/** `/ready`'s leaves lane as `(head, members)` — `container ?? self`, in lane order. */
async function readyGroups(): Promise<Groups> {
  const lane = await workItemsService.listReadyLeaves(fx.projectId, { limit: 200 }, fx.ctx);
  const groups: Groups = [];
  for (const row of lane.items) {
    const head = row.container?.id ?? row.id;
    const last = groups.at(-1);
    if (last?.head === head) last.members.push(row.id);
    else groups.push({ head, members: [row.id] });
  }
  return groups;
}

/** The Workbench's To do as `(head, members)` — a standalone row is a group of itself. */
const workbenchGroups = (page: HomePageDto): Groups =>
  page.items.map((row) => ({
    head: row.id,
    members: row.groupHead === null ? [row.id] : row.groupMembers.map((m) => m.id),
  }));

describe('C2 · /ready and the Workbench group and order the same To do', () => {
  it('produces the identical (head, members) sequence, and keeps it with a bug group added', async () => {
    // Three stories, their leaves at mixed priorities so the order is not creation order,
    // and a task directly under an epic, which stands alone on both surfaces.
    const epic = await item('epic', 'Billing');
    await theirs(epic.id);
    const s1 = await item('story', 'Per-key API quotas');
    const s2 = await item('story', 'Audit log export');
    const s3 = await item('story', 'Checklists');
    await item('subtask', 'Quota table', s1.id, 'low');
    await item('subtask', 'Enforce the quota', s1.id, 'high');
    await item('subtask', 'CSV export', s2.id, 'highest');
    await item('subtask', 'Checklist read', s3.id, 'medium');
    await item('subtask', 'Checklist write', s3.id, 'medium');
    await item('task', 'Retire the legacy invoice job', epic.id, 'highest');
    for (const story of [s1, s2, s3]) await theirs(story.id);

    const ready = await readyGroups();
    const workbench = workbenchGroups(await homeService.listToDo(ctx()));
    // SENSITIVITY: four groups, three of them containers, and not in creation order.
    expect(ready).toHaveLength(4);
    expect(ready.filter((g) => g.members.length > 1)).toHaveLength(2);
    expect(ready.map((g) => g.head)).not.toEqual([s1.id, s2.id, s3.id, expect.anything()]);
    expect(workbench).toEqual(ready);

    // A bug with a subtask: /ready routes it to its BUG lane, the Workbench still groups
    // it under the bug. Parity holds over every non-bug group.
    const bug = await item('bug', 'Usage feed double-counts');
    const b1 = await item('subtask', 'Idempotency key', bug.id);
    const withBug = workbenchGroups(await homeService.listToDo(ctx()));
    expect(withBug.find((g) => g.head === bug.id)?.members).toEqual([b1.id]);
    expect(withBug.filter((g) => g.head !== bug.id)).toEqual(await readyGroups());
  });
});
