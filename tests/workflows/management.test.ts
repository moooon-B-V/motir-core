import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CannotDeleteInitialStatusError,
  DefaultStatusProtectedError,
  NotProjectAdminError,
  StatusInUseError,
  StatusKeyConflictError,
  WorkflowStatusNotFoundError,
  WorkflowTransitionNotFoundError,
} from '@/lib/workflows/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';
import { inngest } from '@/lib/jobs/client';

// Workflow management writes (Story 2.2 · Subtask 2.2.5). Real Postgres. The
// fixture owner can manage; a member can't. Projects come from createTestProject
// (→ createProject, auto-seeded: todo[initial]/blocked/in_progress/in_review/
// done/cancelled, with done + cancelled both category=done).

beforeEach(async () => {
  // Stub the Inngest publish: the status-transition paths now emit
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'wf-mgmt-owner@example.com',
    password: 'hunter2hunter2',
    name: 'WF Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'WF Mgmt', ownerUserId: owner.id });
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { ownerId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

async function statusId(fx: Fixture, key: string): Promise<string> {
  const s = await workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId);
  if (!s) throw new Error(`seeded status ${key} missing`);
  return s.id;
}

describe('assertProjectAdmin gate', () => {
  it('a non-owner member cannot manage the workflow', async () => {
    const fx = await makeFixture();
    const member = await usersService.createUser({
      email: 'wf-member@example.com',
      password: 'hunter2hunter2',
      name: 'WF Member',
    });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await expect(
      workflowsService.setPolicyMode({
        userId: member.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        mode: 'open',
      }),
    ).rejects.toThrow(NotProjectAdminError);
  });
});

describe('createStatus', () => {
  it('appends a new status and rejects a duplicate key', async () => {
    const fx = await makeFixture();
    const created = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'on_hold',
      label: 'On Hold',
      category: 'todo',
    });
    expect(created.key).toBe('on_hold');
    const all = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    expect(all.map((s) => s.key)).toContain('on_hold');
    expect(all[all.length - 1]!.key).toBe('on_hold'); // appended last

    await expect(
      workflowsService.createStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'todo',
        label: 'Dup',
        category: 'todo',
      }),
    ).rejects.toThrow(StatusKeyConflictError);
  });
});

describe('updateStatus', () => {
  it('renames a custom status', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'qa',
      label: 'QA',
      category: 'in_progress',
    });
    const updated = await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: custom.id,
      label: 'Review',
    });
    expect(updated.label).toBe('Review');
  });

  it('flipping isInitial onto a custom status atomically unsets the previous initial', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'triage',
      label: 'Triage',
      category: 'todo',
    });
    // Making the custom status initial internally unsets `todo` (the seeded
    // initial). That internal unset is NOT blocked by the default-protection
    // gate, which only guards a direct edit of the targeted status.
    await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: custom.id,
      isInitial: true,
    });
    const all = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    expect(all.filter((s) => s.isInitial).map((s) => s.key)).toEqual(['triage']); // exactly one
  });
});

describe('default status protection (finding #49)', () => {
  it('allows recoloring a default status', async () => {
    const fx = await makeFixture();
    const updated = await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: await statusId(fx, 'in_progress'),
      color: '#ff0000',
    });
    expect(updated.color).toBe('#ff0000');
  });

  it('rejects renaming, recategorizing, reordering, or re-initialing a default', async () => {
    const fx = await makeFixture();
    const id = await statusId(fx, 'in_review');
    const changes = [
      { label: 'QA' },
      { category: 'done' as const },
      { isInitial: true },
      { position: 'a1' },
    ];
    for (const change of changes) {
      await expect(
        workflowsService.updateStatus({
          userId: fx.ownerId,
          workspaceId: fx.workspaceId,
          statusId: id,
          ...change,
        }),
      ).rejects.toThrow(DefaultStatusProtectedError);
    }
  });

  it('rejects deleting a default status', async () => {
    const fx = await makeFixture();
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: await statusId(fx, 'in_review'),
      }),
    ).rejects.toThrow(DefaultStatusProtectedError);
  });
});

// These protections now apply to CUSTOM statuses only — every default status is
// non-deletable (protected), so the default-protection gate would fire first.
// (CannotDeleteLastTerminalStatusError is consequently unreachable in practice:
// the two default terminals `done`/`cancelled` can never be removed, so a
// project always keeps ≥2 terminals. The guard stays as defensive code.)
describe('deleteStatus protections (custom statuses)', () => {
  it('refuses to delete a custom status made initial', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'intake',
      label: 'Intake',
      category: 'todo',
    });
    await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: custom.id,
      isInitial: true,
    });
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: custom.id,
      }),
    ).rejects.toThrow(CannotDeleteInitialStatusError);
  });

  it('refuses to delete a custom status still referenced by a work item', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'on_hold',
      label: 'On Hold',
      category: 'todo',
    });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T' },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    await db.workItem.update({ where: { id: item.id }, data: { status: 'on_hold' } });
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: custom.id,
      }),
    ).rejects.toThrow(StatusInUseError);
  });

  it('deletes a deletable custom status and cascades its transitions away', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'on_hold',
      label: 'On Hold',
      category: 'todo',
    });
    await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: await statusId(fx, 'todo'),
      toStatusId: custom.id,
    });
    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: custom.id,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).not.toContain('on_hold');
    // No surviving transition references the deleted status.
    expect(
      wf.transitions.some((t) => t.fromStatusId === custom.id || t.toStatusId === custom.id),
    ).toBe(false);
  });
});

describe('transitions', () => {
  it('adds a transition, is idempotent on a duplicate, and removes it', async () => {
    const fx = await makeFixture();
    const todoId = await statusId(fx, 'todo');
    const doneId = await statusId(fx, 'done');

    const added = await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: todoId,
      toStatusId: doneId,
    });
    // Duplicate → returns the SAME row (idempotent, no throw).
    const again = await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: todoId,
      toStatusId: doneId,
    });
    expect(again.id).toBe(added.id);

    await workflowsService.removeTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      transitionId: added.id,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.transitions.some((t) => t.id === added.id)).toBe(false);
  });
});

describe('setPolicyMode', () => {
  it('flips the project policy mode', async () => {
    const fx = await makeFixture();
    const mode = await workflowsService.setPolicyMode({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      mode: 'open',
    });
    expect(mode).toBe('open');
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.policyMode).toBe('open');
  });
});

// 2.6.4 coverage fill — the management-write error/branch paths the per-feature
// 2.2/2.3 tests left uncovered (the admin-gate no-existence-leak, the
// not-found guards on every id-keyed write, the custom-status category/position
// edits, and deleting a CUSTOM category=done status that is NOT the last
// terminal). Net-new in 2.6, no duplication of the inherited happy-path cases.
describe('management writes — guard & branch coverage (2.6.4)', () => {
  it('assertProjectAdmin 404s a nonexistent project AND a cross-workspace one (no existence leak)', async () => {
    const fx = await makeFixture();

    // Nonexistent projectId → !project branch.
    await expect(
      workflowsService.setPolicyMode({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: 'does-not-exist',
        mode: 'open',
      }),
    ).rejects.toThrow(ProjectNotFoundError);

    // A project that exists but belongs to ANOTHER workspace → workspace-mismatch
    // branch (same 404, indistinguishable from never-existed).
    const otherOwner = await usersService.createUser({
      email: 'wf-mgmt-other@example.com',
      password: 'hunter2hunter2',
      name: 'Other Owner',
    });
    const otherWs = await workspacesService.createWorkspace({
      name: 'WF Mgmt Other',
      ownerUserId: otherOwner.id,
    });
    const otherProject = await createTestProject({
      workspaceId: otherWs.workspace.id,
      actorUserId: otherOwner.id,
    });
    await expect(
      workflowsService.setPolicyMode({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: otherProject.id,
        mode: 'open',
      }),
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('createStatus persists an explicit color', async () => {
    const fx = await makeFixture();
    const created = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'staging',
      label: 'Staging',
      category: 'in_progress',
      color: '#00aa55',
    });
    expect(created.color).toBe('#00aa55');
  });

  it('updateStatus throws WorkflowStatusNotFoundError for an unknown status id', async () => {
    const fx = await makeFixture();
    await expect(
      workflowsService.updateStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: 'no-such-status',
        label: 'X',
      }),
    ).rejects.toThrow(WorkflowStatusNotFoundError);
  });

  it('updateStatus edits a custom status category and position', async () => {
    const fx = await makeFixture();
    const custom = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'qa',
      label: 'QA',
      category: 'todo',
    });
    const updated = await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: custom.id,
      category: 'in_progress',
      position: 'a5',
    });
    expect(updated.category).toBe('in_progress');
    expect(updated.position).toBe('a5');
  });

  it('deleteStatus throws WorkflowStatusNotFoundError for an unknown status id', async () => {
    const fx = await makeFixture();
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: 'no-such-status',
      }),
    ).rejects.toThrow(WorkflowStatusNotFoundError);
  });

  it('deletes a CUSTOM category=done status when it is not the last terminal', async () => {
    const fx = await makeFixture();
    // Defaults already carry two terminals (done, cancelled); a third custom
    // terminal can be removed without tripping the last-terminal guard.
    const wontFix = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'wont_fix',
      label: "Won't Fix",
      category: 'done',
    });
    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: wontFix.id,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).not.toContain('wont_fix');
    // The two default terminals survive.
    expect(
      wf.statuses
        .filter((s) => s.category === 'done')
        .map((s) => s.key)
        .sort(),
    ).toEqual(['cancelled', 'done']);
  });

  it('removeTransition throws WorkflowTransitionNotFoundError for an unknown transition id', async () => {
    const fx = await makeFixture();
    await expect(
      workflowsService.removeTransition({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        transitionId: 'no-such-transition',
      }),
    ).rejects.toThrow(WorkflowTransitionNotFoundError);
  });
});
