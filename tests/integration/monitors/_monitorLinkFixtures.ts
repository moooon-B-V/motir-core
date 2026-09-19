import type { WorkItem } from '@/generated/prisma/client';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../../helpers/adminDb';
import { createTestUser } from '../../fixtures/userFixtures';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// Shared set-up for the Errors-section read and the hand-made link (Story
// MOTIR-4932 · Subtasks MOTIR-5730 / MOTIR-5731): a project with TWO monitored
// projects bound, a way to plant a link row directly, and an actor holding a
// CUSTOM role — the only way to express "can read the card, cannot edit it"
// (never a built-in role, which pairs the keys).

let seq = 0;

export interface MonitorLinkScenario {
  fx: WorkItemFixture;
  /** `fake-web`, org `fake-org`. */
  webConnectionId: string;
  /** `fake-worker`, same grant. */
  workerConnectionId: string;
}

export async function monitorLinkScenario(label = 'Links'): Promise<MonitorLinkScenario> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `${label} ${n}`, identifier: `LNK${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-links-${label}-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const web = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  const worker = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-worker', externalProjectSlug: 'worker' },
    fx.ctx,
  );
  return { fx, webConnectionId: web.id, workerConnectionId: worker.id };
}

export function card(fx: WorkItemFixture, title = 'A card'): Promise<WorkItem> {
  return createTestWorkItem(fx, { kind: 'bug', title });
}

/** Plant a `monitor_issue` row directly — test SET-UP, never the path under test. */
export function plantLink(
  s: MonitorLinkScenario,
  input: {
    connectionId: string;
    externalIssueId: string;
    workItemId: string | null;
    identifier?: string | null;
    lastSeenAt: Date;
    eventCount?: number;
    extra?: Record<string, unknown>;
  },
) {
  return adminDb.monitorIssue.create({
    data: {
      connectionId: input.connectionId,
      projectId: s.fx.projectId,
      workspaceId: s.fx.workspaceId,
      externalIssueId: input.externalIssueId,
      title: `Error ${input.externalIssueId}`,
      culprit: `lib/${input.externalIssueId}.ts`,
      level: 'error',
      permalink: `https://fake.invalid/issues/${input.externalIssueId}`,
      eventCount: input.eventCount ?? 1,
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
      lastSeenAt: input.lastSeenAt,
      workItemId: input.workItemId,
      filedWorkItemIdentifier: input.identifier ?? null,
      ...(input.extra ?? {}),
    },
  });
}

/** A workspace member whose project role is a CUSTOM definition holding exactly
 *  `permissions`. */
export async function memberWithPermissions(
  fx: WorkItemFixture,
  permissions: PermissionKey[],
  email: string,
): Promise<ServiceContext> {
  const user = await createTestUser({ email, name: email.split('@')[0] });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const definition = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: `Custom ${email}`,
      permissions,
    },
  });
  // The membership has to EXIST before the definition can be set on it —
  // `setRoleDefinition` is an UPDATE, not an upsert.
  await adminDb.$transaction(async (tx) => {
    await projectMembershipRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        userId: user.id,
        role: CUSTOM_ROLE_TIER,
      },
      tx,
    );
    await projectMembershipRepository.setRoleDefinition(
      user.id,
      fx.projectId,
      { roleDefinitionId: definition.id, role: CUSTOM_ROLE_TIER },
      tx,
    );
  });
  return { ...fx.ctx, userId: user.id };
}
