import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { workItemLabelRepository } from '@/lib/repositories/workItemLabelRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the Story 5.4 data-access leaves (Subtask
// 5.4.1): labelRepository / workItemLabelRepository / componentRepository /
// workItemComponentRepository / watcherRepository, plus the schema-level
// guarantees the migration carries — the case-insensitive uniques (the
// JRACLOUD-24907 wart-fix), the work_item_component RESTRICT backstop (the
// move-or-remove flow's DB guard), the cascades, and the SetNull on a
// component's default assignee. Real Postgres (no mocks), per CLAUDE.md.
// They run as the dev/CI superuser via the `db` singleton (RLS is inert
// under BYPASSRLS — the policies are exercised separately under the
// prodect_app role, the multi-tenant-rls suite's pattern); what's proven
// here is the repository contract and the migration-built constraints.
// Writes run inside a real `db.$transaction` to exercise the required-`tx`
// path. The folksonomy/permission/notification BUSINESS rules live in the
// 5.4.2–5.4.5 services and are tested there.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades workspace → project → label/component and workspace →
  // work_item → join rows / watchers (all FK chains with onDelete: Cascade),
  // so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface OrganisationFixture {
  fx: WorkItemFixture;
  issue: WorkItem;
}

async function makeOrganisationFixture(): Promise<OrganisationFixture> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Organised task' });
  return { fx, issue };
}

/** Find-or-create a label + attach it to an issue through the required-`tx` write path. */
async function addLabel(c: OrganisationFixture, name: string): Promise<string> {
  return db.$transaction(async (tx) => {
    const nameLower = name.toLowerCase();
    const existing = await labelRepository.findByNameLower(c.fx.projectId, nameLower, tx);
    const label =
      existing ??
      (await labelRepository.create(
        { workspaceId: c.fx.workspaceId, projectId: c.fx.projectId, name, nameLower },
        tx,
      ));
    await workItemLabelRepository.create({ workItemId: c.issue.id, labelId: label.id }, tx);
    return label.id;
  });
}

async function addComponent(
  c: OrganisationFixture,
  name: string,
  opts: { defaultAssigneeId?: string } = {},
): Promise<string> {
  const component = await db.$transaction(async (tx) =>
    componentRepository.create(
      {
        workspaceId: c.fx.workspaceId,
        projectId: c.fx.projectId,
        name,
        nameLower: name.toLowerCase(),
        defaultAssigneeId: opts.defaultAssigneeId ?? null,
      },
      tx,
    ),
  );
  return component.id;
}

describe('labelRepository + workItemLabelRepository', () => {
  it('find-or-create round-trips: findByNameLower matches case-insensitively, display casing survives', async () => {
    const c = await makeOrganisationFixture();
    const id = await addLabel(c, 'Perf-Q3');

    const found = await db.$transaction(async (tx) =>
      labelRepository.findByNameLower(c.fx.projectId, 'perf-q3', tx),
    );
    expect(found?.id).toBe(id);
    expect(found?.name).toBe('Perf-Q3'); // first-typed display casing
    expect(found?.nameLower).toBe('perf-q3');
  });

  it('enforces case-INSENSITIVE uniqueness per project (the JRACLOUD-24907 wart-fix) while allowing the same name in another project', async () => {
    const c = await makeOrganisationFixture();
    await addLabel(c, 'Performance');

    // Same project, different casing → the unique on (projectId, nameLower) rejects.
    await expect(
      db.$transaction(async (tx) =>
        labelRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name: 'performance',
            nameLower: 'performance',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    // A different project (second tenant) is free to use the same name.
    const other = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    const row = await db.$transaction(async (tx) =>
      labelRepository.create(
        {
          workspaceId: other.workspaceId,
          projectId: other.projectId,
          name: 'performance',
          nameLower: 'performance',
        },
        tx,
      ),
    );
    expect(row.id).toBeTruthy();
  });

  it('one join row per issue × label (unique), remove() is an idempotent count', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'backend');

    await expect(
      db.$transaction(async (tx) =>
        workItemLabelRepository.create({ workItemId: c.issue.id, labelId }, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const first = await db.$transaction(async (tx) =>
      workItemLabelRepository.remove(c.issue.id, labelId, tx),
    );
    const second = await db.$transaction(async (tx) =>
      workItemLabelRepository.remove(c.issue.id, labelId, tx),
    );
    expect(first).toBe(1);
    expect(second).toBe(0); // idempotent, no P2025
  });

  it('createMany skips duplicates; createMany/removeMany guard empty input as no-ops', async () => {
    const c = await makeOrganisationFixture();
    const aId = await addLabel(c, 'alpha'); // already attached
    const b = await db.$transaction(async (tx) =>
      labelRepository.create(
        {
          workspaceId: c.fx.workspaceId,
          projectId: c.fx.projectId,
          name: 'beta',
          nameLower: 'beta',
        },
        tx,
      ),
    );

    const inserted = await db.$transaction(async (tx) =>
      workItemLabelRepository.createMany(
        [
          { workItemId: c.issue.id, labelId: aId }, // duplicate → skipped
          { workItemId: c.issue.id, labelId: b.id },
        ],
        tx,
      ),
    );
    expect(inserted).toBe(1);

    // Empty-input guards (coverage gate): no statement, zero counts.
    const emptyCreate = await db.$transaction(async (tx) =>
      workItemLabelRepository.createMany([], tx),
    );
    const emptyRemove = await db.$transaction(async (tx) =>
      workItemLabelRepository.removeMany(c.issue.id, [], tx),
    );
    expect(emptyCreate).toBe(0);
    expect(emptyRemove).toBe(0);

    const removed = await db.$transaction(async (tx) =>
      workItemLabelRepository.removeMany(c.issue.id, [aId, b.id], tx),
    );
    expect(removed).toBe(2);
  });

  it('searchByPrefix is case-insensitive, prefix-anchored, bounded, name-ordered; empty prefix lists bounded', async () => {
    const c = await makeOrganisationFixture();
    for (const name of ['Perf-Q3', 'perf-q4', 'performance', 'backend']) {
      await db.$transaction(async (tx) =>
        labelRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name,
            nameLower: name.toLowerCase(),
          },
          tx,
        ),
      );
    }

    const hits = await labelRepository.searchByPrefix(c.fx.projectId, 'PERF');
    expect(hits.map((l) => l.name)).toEqual(['Perf-Q3', 'perf-q4', 'performance']);

    const bounded = await labelRepository.searchByPrefix(c.fx.projectId, 'perf', 2);
    expect(bounded).toHaveLength(2);

    // Empty prefix = "open the picker before typing": the first `take`
    // existing labels, name-ordered — bounded, never a semantic error.
    const all = await labelRepository.searchByPrefix(c.fx.projectId, '', 3);
    expect(all.map((l) => l.nameLower)).toEqual(['backend', 'perf-q3', 'perf-q4']);
  });

  it('countByLabel / countByWorkItem / listByWorkItem serve the guard reads; lockById returns the row or null', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'infra');
    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Second' });
    await db.$transaction(async (tx) =>
      workItemLabelRepository.create({ workItemId: issue2.id, labelId }, tx),
    );

    await db.$transaction(async (tx) => {
      expect(await workItemLabelRepository.countByLabel(labelId, tx)).toBe(2);
      expect(await workItemLabelRepository.countByWorkItem(c.issue.id, tx)).toBe(1);
      expect(await labelRepository.lockById(labelId, tx)).toEqual({ id: labelId });
      expect(await labelRepository.lockById('missing-label-id', tx)).toBeNull();
    });

    const labels = await labelRepository.listByWorkItem(c.issue.id);
    expect(labels.map((l) => l.name)).toEqual(['infra']);
    const joins = await workItemLabelRepository.listByWorkItem(c.issue.id);
    expect(joins).toHaveLength(1);

    // Both client paths of the optional-`tx` reads (the bare-`db` half of
    // findByNameLower, the in-`tx` half of the two list reads).
    const bare = await labelRepository.findByNameLower(c.fx.projectId, 'infra');
    expect(bare?.id).toBe(labelId);
    await db.$transaction(async (tx) => {
      expect(await labelRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
      expect(await workItemLabelRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
    });

    // The delete-on-last-use end state: label rows die with their last use.
    await db.$transaction(async (tx) => {
      await workItemLabelRepository.remove(c.issue.id, labelId, tx);
      await workItemLabelRepository.remove(issue2.id, labelId, tx);
      expect(await workItemLabelRepository.countByLabel(labelId, tx)).toBe(0);
      await labelRepository.delete(labelId, tx);
    });
    expect(await db.label.findUnique({ where: { id: labelId } })).toBeNull();
  });

  it('cascades: deleting a work item sheds its label joins; deleting a label sheds its joins', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'doomed');

    await db.workItem.delete({ where: { id: c.issue.id } });
    expect(await db.workItemLabel.count({ where: { labelId } })).toBe(0);
    // The label row itself survives a work-item delete (delete-on-last-use
    // is a SERVICE rule, not a cascade) — 5.4.2 owns that lifecycle.
    expect(await db.label.findUnique({ where: { id: labelId } })).not.toBeNull();

    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Again' });
    await db.$transaction(async (tx) =>
      workItemLabelRepository.create({ workItemId: issue2.id, labelId }, tx),
    );
    await db.$transaction(async (tx) => labelRepository.delete(labelId, tx));
    expect(await db.workItemLabel.count({ where: { workItemId: issue2.id } })).toBe(0);
  });
});

describe('componentRepository + workItemComponentRepository', () => {
  it('CRUD round-trips; case-insensitive uniqueness per project', async () => {
    const c = await makeOrganisationFixture();
    const id = await addComponent(c, 'API');

    await expect(
      db.$transaction(async (tx) =>
        componentRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name: 'api',
            nameLower: 'api',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const probe = await componentRepository.findByNameLower(c.fx.projectId, 'api');
    expect(probe?.id).toBe(id);
    expect(await componentRepository.findByNameLower(c.fx.projectId, 'web')).toBeNull();

    const updated = await db.$transaction(async (tx) =>
      componentRepository.update(id, { description: 'The API surface' }, tx),
    );
    expect(updated.description).toBe('The API surface');

    await db.$transaction(async (tx) => componentRepository.delete(id, tx));
    expect(await componentRepository.findById(id)).toBeNull();
  });

  it('listByProject is name-ordered with in-use counts; listByWorkItem rides the issue', async () => {
    const c = await makeOrganisationFixture();
    const webId = await addComponent(c, 'Web');
    const apiId = await addComponent(c, 'API');
    await db.$transaction(async (tx) =>
      workItemComponentRepository.createMany(
        [
          { workItemId: c.issue.id, componentId: apiId },
          { workItemId: c.issue.id, componentId: webId },
        ],
        tx,
      ),
    );

    const list = await componentRepository.listByProject(c.fx.projectId);
    expect(list.map((x) => [x.name, x._count.workItems])).toEqual([
      ['API', 1],
      ['Web', 1],
    ]);

    const mine = await componentRepository.listByWorkItem(c.issue.id);
    expect(mine.map((x) => x.name)).toEqual(['API', 'Web']);
    expect(await workItemComponentRepository.countByComponent(apiId)).toBe(1);
  });

  it('findFirstDefaultAssignee picks the first-alphabetical component HAVING a default; empty input guards to null', async () => {
    const c = await makeOrganisationFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });
    // Alphabetical: "API" (no default) < "Mobile" (Odie) < "Web" (Bo) —
    // the rule skips API and lands on Mobile.
    const apiId = await addComponent(c, 'API');
    const mobileId = await addComponent(c, 'Mobile', { defaultAssigneeId: odie.id });
    const webId = await addComponent(c, 'Web', { defaultAssigneeId: bo.id });

    const winner = await componentRepository.findFirstDefaultAssignee([apiId, webId, mobileId]);
    expect(winner?.id).toBe(mobileId);
    expect(winner?.defaultAssigneeId).toBe(odie.id);

    expect(await componentRepository.findFirstDefaultAssignee([apiId])).toBeNull();
    // Empty-input guard (coverage gate): no statement, null.
    expect(await componentRepository.findFirstDefaultAssignee([])).toBeNull();
  });

  it('RESTRICT backstop: a component with join rows cannot be deleted until the joins go', async () => {
    const c = await makeOrganisationFixture();
    const id = await addComponent(c, 'API');
    await db.$transaction(async (tx) =>
      workItemComponentRepository.create({ workItemId: c.issue.id, componentId: id }, tx),
    );

    await expect(
      db.$transaction(async (tx) => componentRepository.delete(id, tx)),
    ).rejects.toMatchObject({ code: 'P2003' }); // FK violation — the DB backstop

    await db.$transaction(async (tx) => {
      expect(await componentRepository.lockById(id, tx)).toEqual({ id });
      expect(await workItemComponentRepository.deleteByComponent(id, tx)).toBe(1);
      await componentRepository.delete(id, tx); // now clean
    });
    expect(await componentRepository.findById(id)).toBeNull();
    await db.$transaction(async (tx) => {
      expect(await componentRepository.lockById('missing-component-id', tx)).toBeNull();
    });
  });

  it('reassignItems repoints joins to the target, skipping issues that already carry it (the move branch)', async () => {
    const c = await makeOrganisationFixture();
    const fromId = await addComponent(c, 'Old');
    const toId = await addComponent(c, 'New');
    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Both' });
    await db.$transaction(async (tx) =>
      workItemComponentRepository.createMany(
        [
          { workItemId: c.issue.id, componentId: fromId }, // moves
          { workItemId: issue2.id, componentId: fromId }, // duplicate → skipped
          { workItemId: issue2.id, componentId: toId },
        ],
        tx,
      ),
    );

    await db.$transaction(async (tx) => {
      const moved = await workItemComponentRepository.reassignItems(fromId, toId, tx);
      expect(moved).toBe(1);
      // The duplicate leftover still points at `fromId` — the service drops
      // it in the same transaction (the move branch's sweep).
      expect(await workItemComponentRepository.deleteByComponent(fromId, tx)).toBe(1);
    });

    expect(await workItemComponentRepository.countByComponent(toId)).toBe(2);
    expect(await workItemComponentRepository.countByComponent(fromId)).toBe(0);
    // Issues untouched either way (the verified rule).
    expect(await db.workItem.count({ where: { projectId: c.fx.projectId } })).toBe(2);

    // The set-diff reads, on both client paths (bare `db` + in-`tx`).
    const joins = await workItemComponentRepository.listByWorkItem(issue2.id);
    expect(joins.map((j) => j.componentId)).toEqual([toId]);
    await db.$transaction(async (tx) => {
      expect(await workItemComponentRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
      expect(await workItemComponentRepository.countByComponent(toId, tx)).toBe(2);
    });

    // removeMany with real ids (the bulk-remove path of setComponents).
    expect(
      await db.$transaction(async (tx) =>
        workItemComponentRepository.removeMany(c.issue.id, [toId, fromId], tx),
      ),
    ).toBe(1);

    // Per-issue join uniqueness + idempotent removes, mirroring labels.
    await expect(
      db.$transaction(async (tx) =>
        workItemComponentRepository.create({ workItemId: issue2.id, componentId: toId }, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await db.$transaction(async (tx) => workItemComponentRepository.remove(issue2.id, toId, tx)),
    ).toBe(1);
    expect(
      await db.$transaction(async (tx) => workItemComponentRepository.remove(issue2.id, toId, tx)),
    ).toBe(0);
  });

  it('createMany/removeMany guard empty input; cascades shed an issue’s joins; SetNull clears a departed default assignee', async () => {
    const c = await makeOrganisationFixture();
    expect(
      await db.$transaction(async (tx) => workItemComponentRepository.createMany([], tx)),
    ).toBe(0);
    expect(
      await db.$transaction(async (tx) =>
        workItemComponentRepository.removeMany(c.issue.id, [], tx),
      ),
    ).toBe(0);

    const user = await createTestUser({ name: 'Departing' });
    const id = await addComponent(c, 'Theirs', { defaultAssigneeId: user.id });
    await db.$transaction(async (tx) =>
      workItemComponentRepository.create({ workItemId: c.issue.id, componentId: id }, tx),
    );

    // Issue delete cascades the join (RESTRICT is only on the component side).
    await db.workItem.delete({ where: { id: c.issue.id } });
    expect(await workItemComponentRepository.countByComponent(id)).toBe(0);

    // Deleting the default assignee clears the pointer, never blocks.
    await db.user.delete({ where: { id: user.id } });
    const after = await componentRepository.findById(id);
    expect(after).not.toBeNull();
    expect(after?.defaultAssigneeId).toBeNull();
  });
});

describe('watcherRepository', () => {
  it('add is idempotent (the unique absorbs a re-watch); existsFor and countByWorkItem read it back', async () => {
    const c = await makeOrganisationFixture();
    const first = await db.$transaction(async (tx) =>
      watcherRepository.add(c.issue.id, c.fx.ownerId, tx),
    );
    const again = await db.$transaction(async (tx) =>
      watcherRepository.add(c.issue.id, c.fx.ownerId, tx),
    );
    expect(again.id).toBe(first.id); // upsert no-op, same row

    expect(await watcherRepository.existsFor(c.issue.id, c.fx.ownerId)).toBe(true);
    expect(await watcherRepository.countByWorkItem(c.issue.id)).toBe(1);
  });

  it('remove is an idempotent count; existsFor turns false', async () => {
    const c = await makeOrganisationFixture();
    await db.$transaction(async (tx) => watcherRepository.add(c.issue.id, c.fx.ownerId, tx));

    expect(
      await db.$transaction(async (tx) => watcherRepository.remove(c.issue.id, c.fx.ownerId, tx)),
    ).toBe(1);
    expect(
      await db.$transaction(async (tx) => watcherRepository.remove(c.issue.id, c.fx.ownerId, tx)),
    ).toBe(0);
    expect(await watcherRepository.existsFor(c.issue.id, c.fx.ownerId)).toBe(false);
  });

  it('listByWorkItem pages with a cursor (stable order, user riding along, no skip/repeat at the boundary)', async () => {
    const c = await makeOrganisationFixture();
    const users = [c.fx.owner];
    for (let i = 0; i < 4; i++) users.push(await createTestUser({ name: `Watcher ${i}` }));
    for (const u of users) {
      await db.$transaction(async (tx) => watcherRepository.add(c.issue.id, u.id, tx));
    }

    const page1 = await watcherRepository.listByWorkItem(c.issue.id, { take: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.user.name).toBeTruthy(); // the popover's Avatar · name shape

    const page2 = await watcherRepository.listByWorkItem(c.issue.id, {
      take: 2,
      cursor: page1[1]!.id,
    });
    const page3 = await watcherRepository.listByWorkItem(c.issue.id, {
      take: 2,
      cursor: page2[1]!.id,
    });
    const seen = [...page1, ...page2, ...page3].map((w) => w.userId);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // every watcher exactly once
    expect(await watcherRepository.countByWorkItem(c.issue.id)).toBe(5);
  });

  it('cascades both sides: an issue delete sheds its watchers; a user delete stops their watching', async () => {
    const c = await makeOrganisationFixture();
    const user = await createTestUser({ name: 'Transient' });
    await db.$transaction(async (tx) => {
      await watcherRepository.add(c.issue.id, c.fx.ownerId, tx);
      await watcherRepository.add(c.issue.id, user.id, tx);
    });

    await db.user.delete({ where: { id: user.id } });
    expect(await watcherRepository.countByWorkItem(c.issue.id)).toBe(1);

    await db.workItem.delete({ where: { id: c.issue.id } });
    expect(await db.watcher.count()).toBe(0);
  });
});
