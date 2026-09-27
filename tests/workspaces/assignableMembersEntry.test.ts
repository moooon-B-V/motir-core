import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Who can be assigned or mentioned on a project (Story MOTIR-6169 · MOTIR-6547):
// exactly the people who can ENTER it — the entry rule's `canEnter`, reused by
// every people-picker. A contractor with a Limited scope is never offered on a
// project they cannot open; a Full member is never offered on a Members-only
// project they were not added to.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function setup(mode: ProjectAccessMode) {
  const fx = await makeWorkItemFixture({ name: `AME ${seq}`, identifier: `AME${seq++}` });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: {
      accessMode: mode,
      accessLevel: mode === 'workspace' ? 'open' : mode === 'members' ? 'private' : 'public',
    },
  });
  const person = async (
    label: string,
    scope: 'full' | 'limited',
    added: boolean,
    role: 'member' | 'viewer' = 'member',
  ) => {
    const u = await usersService.createUser({
      email: `ame-${label}-${seq++}@example.com`,
      password: 'hunter2hunter2',
      name: label,
    });
    await workspacesService.addMember({
      userId: u.id,
      workspaceId: fx.workspaceId,
      workspaceRole: role,
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: u.id, workspaceId: fx.workspaceId } },
      data: { accessScope: scope },
    });
    if (added) {
      await adminDb.projectMembership.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          userId: u.id,
          role: 'member',
        },
      });
    }
    return u;
  };
  return {
    fx,
    fullAdded: await person('FullAdded', 'full', true),
    fullNotAdded: await person('FullNotAdded', 'full', false),
    limitedAdded: await person('LimitedAdded', 'limited', true),
    limitedNotAdded: await person('LimitedNotAdded', 'limited', false),
  };
}

const idsOf = async (
  projectId: string,
  accessMode: ProjectAccessMode,
  ctx: { userId: string; workspaceId: string },
) =>
  (await assignableMembersService.list({ projectId, accessMode, ctx })).map((m) => m.userId).sort();

describe('assignableMembersService.list — the people who can enter', () => {
  it('on a members project: the added people and the Managers, not a Full member who was not added', async () => {
    const s = await setup('members');
    expect(await idsOf(s.fx.projectId, 'members', s.fx.ctx)).toEqual(
      [s.fx.ownerId, s.fullAdded.id, s.limitedAdded.id].sort(),
    );
  });

  it('on a workspace project: every Full member plus the added Limited ones — never a Limited member not added', async () => {
    const s = await setup('workspace');
    expect(await idsOf(s.fx.projectId, 'workspace', s.fx.ctx)).toEqual(
      [s.fx.ownerId, s.fullAdded.id, s.fullNotAdded.id, s.limitedAdded.id].sort(),
    );
  });

  it('on a public project: the same people as workspace — a Limited member not added is a visitor, not assignable', async () => {
    const s = await setup('public');
    const ids = await idsOf(s.fx.projectId, 'public', s.fx.ctx);
    expect(ids).toContain(s.fullNotAdded.id);
    expect(ids).not.toContain(s.limitedNotAdded.id);
  });
});

describe('the mention gate follows the same rule', () => {
  it('a comment mentioning someone who cannot enter drops them; someone who can enter stays', async () => {
    const s = await setup('workspace');
    const item = await createTestWorkItem(s.fx, { kind: 'task', title: 'Mention me' });
    const token = (u: { id: string; name: string | null }) => `[@${u.name}](mention:${u.id})`;
    const dto = await commentsService.addComment(
      item.id,
      { bodyMd: `cc ${token(s.limitedNotAdded)} and ${token(s.fullNotAdded)}` },
      s.fx.ctx,
    );
    expect(dto.mentionedUserIds).toEqual([s.fullNotAdded.id]);
  });
});
