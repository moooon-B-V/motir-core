import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  createPage,
  emptyState,
  markdownToUpdate,
  pageStoreFor,
  renamePage,
  savePageUpdate,
  stateToMarkdown,
  systemClock,
} from '@/lib/pages';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The `PageStore` ADAPTER on real Postgres (Story MOTIR-5752 · MOTIR-7276):
// `@motir/pages`' procedures running against `pageStoreFor(tx)` inside
// `withWorkspaceContext`, the row lock a save depends on, and the `bytea`
// round-trip through the mapper.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `page-adapter-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page Adapter ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Adapter ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Page Adapter ${tag}`,
    identifier: `PA${tag.toUpperCase()}`,
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
}

const inTenant = <T>(t: Tenant, fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: t.userId, workspaceId: t.workspaceId, projectId: t.projectId },
    fn,
  );

const create = (t: Tenant, title?: string) =>
  inTenant(t, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      actorId: t.userId,
      title,
    }),
  );

const save = (t: Tenant, pageId: string, update: Uint8Array) =>
  inTenant(t, (tx) =>
    savePageUpdate(pageStoreFor(tx), systemClock, { pageId, actorId: t.userId, update }),
  );

describe('pageStoreFor(tx) — the package procedures on real Postgres', () => {
  it('creates, saves and renames a page, reading each back', async () => {
    const t = await makeTenant('one');
    const first = await create(t, ' Plan ');
    const second = await create(t);
    expect(first.position < second.position).toBe(true);

    const created = await adminDb.page.findUniqueOrThrow({ where: { id: first.id } });
    expect(created).toMatchObject({
      title: 'Plan',
      revision: 1,
      bodyMarkdown: '',
      bodyText: '',
      bodyJson: { type: 'doc', content: [{ type: 'paragraph' }] },
      createdById: t.userId,
    });

    const revision = await save(t, first.id, markdownToUpdate(emptyState(), '# Hi\n\n- [x] done'));
    expect(revision).toBe(2);
    const saved = await adminDb.page.findUniqueOrThrow({ where: { id: first.id } });
    expect(saved).toMatchObject({
      revision: 2,
      bodyMarkdown: '# Hi\n\n- [x] done',
      bodyText: 'Hi\ndone',
    });
    expect(stateToMarkdown(new Uint8Array(saved.bodyState))).toBe('# Hi\n\n- [x] done');

    const renamed = await inTenant(t, (tx) =>
      renamePage(pageStoreFor(tx), { pageId: first.id, actorId: t.userId, title: 'Roadmap' }),
    );
    expect(renamed).toMatchObject({ id: first.id, title: 'Roadmap', revision: 2 });
    await expect(
      inTenant(t, (tx) =>
        renamePage(pageStoreFor(tx), { pageId: 'missing', actorId: t.userId, title: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
    expect(await inTenant(t, (tx) => pageStoreFor(tx).findPage(first.id))).toMatchObject({
      title: 'Roadmap',
    });
  });

  it('serialises two saves on the row lock: the second merges onto the first', async () => {
    const t = await makeTenant('two');
    const page = await create(t);
    await save(t, page.id, markdownToUpdate(emptyState(), 'Alpha\n\nBeta'));
    const base = (await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).bodyState;
    const a = markdownToUpdate(new Uint8Array(base), 'Alpha one\n\nBeta');
    const b = markdownToUpdate(new Uint8Array(base), 'Alpha\n\nBeta two');

    let locked!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const first = inTenant(t, async (tx) => {
      const revision = await savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: t.userId,
        update: a,
      });
      locked();
      await released;
      return revision;
    });
    await firstHoldsLock;

    let secondDone = false;
    const second = save(t, page.id, b).then((revision) => {
      secondDone = true;
      return revision;
    });
    // The second save is parked on `FOR UPDATE` until the first commits — prove
    // it is waiting on the lock and not merely slow, by reading pg's own view.
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<Array<{ n: bigint }>>`
              SELECT count(*) AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "page"%FOR UPDATE%'
            `
          )[0]!.n,
      )
      .toBe(BigInt(1));
    expect(secondDone).toBe(false);

    release();
    expect(await first).toBe(3);
    expect(await second).toBe(4);
    const merged = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(merged.bodyMarkdown).toBe('Alpha one\n\nBeta two');
  });

  it('cannot lock another workspace’s page under the non-bypass role', async () => {
    const mine = await makeTenant('mine');
    const theirs = await makeTenant('theirs');
    const page = await create(theirs);

    const seen = await inTenant(mine, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return pageRepository.lockById(page.id, tx);
    });
    expect(seen).toBeNull();

    const own = await inTenant(theirs, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return pageRepository.lockById(page.id, tx);
    });
    expect(own?.id).toBe(page.id);
  });

  it('writes a 1 MiB body through updateBody and reads it back byte for byte', async () => {
    const t = await makeTenant('big');
    const page = await create(t);
    const body = new Uint8Array(1_048_576);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 131 + 17) & 0xff;

    await inTenant(t, (tx) =>
      pageStoreFor(tx).updateBody(page.id, {
        state: body,
        json: { type: 'doc', content: [] },
        markdown: '',
        text: '',
        revision: 2,
        updatedById: t.userId,
        updatedAt: new Date(),
      }),
    );
    const locked = await inTenant(t, (tx) => pageStoreFor(tx).lockPage(page.id));
    expect(locked!.bodyState).toBeInstanceOf(Uint8Array);
    expect(locked!.bodyState.byteLength).toBe(1_048_576);
    expect(Buffer.from(locked!.bodyState).equals(Buffer.from(body))).toBe(true);
    expect(locked!.revision).toBe(2);
  });

  it('places pages at the root only, until the tree story', async () => {
    const t = await makeTenant('root');
    await expect(
      inTenant(t, (tx) =>
        pageStoreFor(tx).lockSiblings(t.projectId, { kind: 'page', pageId: 'p' }),
      ),
    ).rejects.toThrow(/MOTIR-5753/);
    await expect(
      inTenant(t, (tx) =>
        pageStoreFor(tx).lastSiblingPosition(t.projectId, { kind: 'folder', folderId: 'f' }),
      ),
    ).rejects.toThrow(/MOTIR-5753/);
    await expect(
      inTenant(t, (tx) => pageStoreFor(tx).replaceDerivedLinks('p', [])),
    ).resolves.toBeUndefined();
    expect(await inTenant(t, (tx) => pageStoreFor(tx).lockPage('missing'))).toBeNull();
    expect(await inTenant(t, (tx) => pageStoreFor(tx).findPage('missing'))).toBeNull();
  });
});
