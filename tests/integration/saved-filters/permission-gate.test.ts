import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { encodeFilterParam } from '@/lib/filters/ast';
import type { FilterAst } from '@/lib/filters/ast';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { SavedFilterForbiddenError } from '@/lib/savedFilters/errors';
import { makeWorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The `saved_filter:manage` GATE (Story MOTIR-2291 · Subtask MOTIR-2352).
//
// This domain is the one member-facing key whose service ALREADY consulted the
// access policy, so the card is mostly a re-pointing — and the tests worth having
// are the ones that pin the line it must not cross:
//
//   * the WRITES ask the key, so a `viewer` stops authoring, starring and
//     subscribing to shared queries;
//   * the READS stay at `project:browse`, so the same viewer still LISTS and RUNS
//     every filter they can see. Narrowing that would break the issues sidebar
//     for read-only accounts, which is not what this story is for;
//   * the per-ROW rules survive alongside the key: holding `saved_filter:manage`
//     does not make you the owner of somebody else's filter.

const AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
};
const param = (): string => encodeFilterParam(AST);

interface Team {
  fx: WorkItemFixture;
  key: string;
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  viewerCtx: ServiceContext;
}

let seq = 0;

async function makeTeam(): Promise<Team> {
  seq += 1;
  const fx = await makeWorkItemFixture({ identifier: `SG${String(seq).padStart(2, '0')}` });
  const key = fx.projectIdentifier;
  async function enroll(
    slug: string,
    role: 'admin' | 'member' | 'viewer',
  ): Promise<ServiceContext> {
    const user = await createTestUser({ email: `sfgate-${slug}-${seq}@example.com`, name: slug });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
    return { userId: user.id, workspaceId: fx.workspaceId };
  }
  return {
    fx,
    key,
    ownerCtx: fx.ctx,
    memberCtx: await enroll('member', 'member'),
    viewerCtx: await enroll('viewer', 'viewer'),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the WRITES ask saved_filter:manage', () => {
  it('refuses a project viewer authoring a filter', async () => {
    const t = await makeTeam();
    await expect(
      savedFiltersService.create(
        t.key,
        { name: 'Viewer’s', visibility: 'private', filterParam: param() },
        t.viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses a viewer starring, updating, deleting and reassigning', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.ownerCtx,
    );
    await expect(savedFiltersService.star(t.key, filter.id, t.viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      savedFiltersService.update(t.key, filter.id, { name: 'Renamed' }, t.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(savedFiltersService.delete(t.key, filter.id, t.viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      savedFiltersService.changeOwner(t.key, filter.id, t.viewerCtx.userId, t.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses a viewer SUBSCRIBING — the one operation that reached no project gate', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.ownerCtx,
    );
    await expect(
      savedFilterSubscriptionsService.subscribe(
        t.key,
        filter.id,
        { schedule: 'daily', hour: 9 },
        t.viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    // and nothing was written
    expect(await savedFilterSubscriptionsService.getMine(t.key, filter.id, t.viewerCtx)).toBeNull();
  });

  it('still admits a project MEMBER on every write', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Mine', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await expect(savedFiltersService.star(t.key, filter.id, t.memberCtx)).resolves.toBeTruthy();
    await expect(
      savedFilterSubscriptionsService.subscribe(
        t.key,
        filter.id,
        { schedule: 'daily', hour: 9 },
        t.memberCtx,
      ),
    ).resolves.toBeTruthy();
    await expect(
      savedFiltersService.update(t.key, filter.id, { name: 'Mine, renamed' }, t.memberCtx),
    ).resolves.toBeTruthy();
  });
});

describe('the READS stay at project:browse', () => {
  it('lets a viewer LIST and RUN a shared filter they may not author', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.ownerCtx,
    );
    const listed = await savedFiltersService.list(t.key, {}, t.viewerCtx);
    expect(listed.items.map((f) => f.id)).toContain(filter.id);
    await expect(savedFiltersService.resolve(t.key, filter.id, t.viewerCtx)).resolves.toBeTruthy();
    await expect(
      savedFiltersService.getDependents(t.key, filter.id, t.viewerCtx),
    ).resolves.toBeTruthy();
    // …and their own subscription state is still readable (it is their account,
    // not project management).
    expect(await savedFilterSubscriptionsService.getMine(t.key, filter.id, t.viewerCtx)).toBeNull();
  });
});

describe('the per-ROW rules survive alongside the key', () => {
  it('refuses a MEMBER who holds saved_filter:manage but is not the owner', async () => {
    // The distinction the card insists on: the key answers "may this actor manage
    // saved filters in this project at all", and the row rule then answers "may
    // they do it to THIS row". A member holds the key and still cannot reassign a
    // filter they do not own — that refusal is `SavedFilterForbiddenError`, not
    // the permission one, which is how the two stay legible in a log.
    const t = await makeTeam();
    const owned = await savedFiltersService.create(
      t.key,
      { name: 'Owner’s', visibility: 'project', filterParam: param() },
      t.ownerCtx,
    );
    await expect(
      savedFiltersService.changeOwner(t.key, owned.id, t.memberCtx.userId, t.memberCtx),
    ).rejects.toBeInstanceOf(SavedFilterForbiddenError);
  });
});
