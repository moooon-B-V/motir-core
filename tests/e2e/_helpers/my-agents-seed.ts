import { fakePersistentOrchestrator } from '@motir/orchestrator';
import { adminDb, db } from './db-reset';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { createTestPerson } from './testPerson';
import { writeHostedRunFixture } from './hosted-run-boundary';

// MY AGENTS — the acceptance seed (Story MOTIR-6860 · MOTIR-6877).
//
// One owner with an active project (member and above hold `instance:use`), and a
// VIEWER on the same project who does not. The credit pre-flight and the machine
// debit are answered by the lane's motir-ai mock (`lib/test-hosted-run-mock.ts`),
// driven by the same fixture file the hosted-run spec uses; the fleet is the
// persistent fake, shared with the webServer through `MOTIR_FAKE_PERSISTENT_STATE_PATH`.

export const MY_AGENTS_PASSWORD = 'correct-horse-battery-staple-9';

export interface MyAgentsSeed {
  email: string;
  viewerEmail: string;
  password: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectIdentifier: string;
}

export async function seedMyAgents(tag: string): Promise<MyAgentsSeed> {
  fakePersistentOrchestrator.reset();
  setCredits(true);
  const owner = await createTestPerson({
    email: `agents-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    name: 'Yue Agents',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Agents',
    ownerUserId: owner.id,
  });
  const identifier = `AG${tag.slice(-4).toUpperCase()}`;
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Agents',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const viewer = await createTestPerson({
    email: `agents-viewer-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    name: 'Vera Viewer',
  });
  await db.workspaceMembership.create({
    data: {
      workspaceId: workspace.id,
      userId: viewer.id,
      workspaceRole: 'viewer',
      activeProjectId: project.id,
    },
  });
  return {
    email: `agents-${tag}@example.com`,
    viewerEmail: `agents-viewer-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    userId: owner.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    // The stored key, not the requested one: `createProject` normalises it (5 characters).
    projectIdentifier: project.identifier,
  };
}

/** Whether the organisation's credits can start a machine (the mock's pre-flight answer). */
export function setCredits(mayRun: boolean): void {
  writeHostedRunFixture({ mayRun });
}

/** Arm the next provision to fail — the webServer meets it through the shared sidecar. */
export function failNextProvision(detail: string): void {
  fakePersistentOrchestrator.failNextProvision(detail);
}

/** Seed `count` live agents for the owner directly — for the personal-limit refusal. */
export async function seedAgents(seed: MyAgentsSeed, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await adminDb.agentInstance.create({
      data: {
        workspaceId: seed.workspaceId,
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        ownerId: seed.userId,
        name: `seeded-${i}`,
        profileId: 'claude',
        imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
        imageDigest: 'sha256:seed',
        region: 'iad',
        state: 'hibernated',
      },
    });
  }
}
