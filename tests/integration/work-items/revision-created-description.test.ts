import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Direct repository coverage for `findCreatedDescription` (Story MOTIR-4930 ·
// MOTIR-5851): the body an item was CREATED with, read from its `created`
// revision's diff. The write-back's predicate rests on it, and the revision
// `diff` is untyped JSON, so every malformed shape must read as "no body"
// rather than throw. Real Postgres, per CLAUDE.md.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function created(fx: WorkItemFixture, descriptionMd?: string) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'A card',
      ...(descriptionMd ? { descriptionMd } : {}),
    },
    fx.ctx,
  );
}

const read = (fx: WorkItemFixture, workItemId: string) =>
  withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workItemRevisionRepository.findCreatedDescription(workItemId, tx),
  );

/** Rewrite the item's `created` revision diff to a shape under test. */
async function setCreatedDiff(workItemId: string, diff: Prisma.InputJsonValue) {
  await adminDb.workItemRevision.updateMany({
    where: { workItemId, changeKind: 'created' },
    data: { diff },
  });
}

describe('workItemRevisionRepository.findCreatedDescription', () => {
  it('returns the description the item was created with — not the current one', async () => {
    const fx = await makeWorkItemFixture();
    const item = await created(fx, 'The body at filing.');
    await workItemsService.updateWorkItem(item.id, { descriptionMd: 'Edited later.' }, fx.ctx);
    expect(await read(fx, item.id)).toBe('The body at filing.');
  });

  it('is null for an item with no revision rows at all', async () => {
    const fx = await makeWorkItemFixture();
    const item = await created(fx, 'x');
    await adminDb.workItemRevision.deleteMany({ where: { workItemId: item.id } });
    expect(await read(fx, item.id)).toBeNull();
  });

  it.each([
    ['a JSON array diff', ['descriptionMd']],
    ['a scalar diff', 'descriptionMd'],
    ['a diff with no descriptionMd cell', { title: { from: null, to: 'A card' } }],
    ['a descriptionMd cell that is an array', { descriptionMd: ['x'] }],
    ['a descriptionMd cell that is a string', { descriptionMd: 'x' }],
    ['a descriptionMd cell whose `to` is not a string', { descriptionMd: { from: null, to: 7 } }],
    ['a descriptionMd cell created blank', { descriptionMd: { from: null, to: null } }],
  ])('is null for %s', async (_label, diff) => {
    const fx = await makeWorkItemFixture();
    const item = await created(fx, 'x');
    await setCreatedDiff(item.id, diff as Prisma.InputJsonValue);
    expect(await read(fx, item.id)).toBeNull();
  });
});
