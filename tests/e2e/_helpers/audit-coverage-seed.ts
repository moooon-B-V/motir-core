import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';

// Seed for the audit-coverage E2E (MOTIR-2253): one workspace with a project
// ADMIN and a plain MEMBER, an onboarded project, and a THREE-repo installation.
//
// Three repos because the story's two triggers need different shapes to be
// distinguishable: one repo with a report (so "Re-audit" appears and the bulk
// action must not touch it) and TWO without (so the bulk action's scope is
// visibly plural, not the same thing as the row action).

export const AUDIT_COVERAGE_PASSWORD = 'audit-coverage-e2e-pass-9';

export const AUDITED_REPO = 'moooon/motir-core';
export const UNAUDITED_REPOS = ['moooon/motir-ai', 'moooon/motir-meta'] as const;

export interface AuditCoverageSeed {
  adminEmail: string;
  memberEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

export async function seedAuditCoverage(prefix: string): Promise<AuditCoverageSeed> {
  const adminEmail = `${prefix}-admin@example.com`;
  const memberEmail = `${prefix}-member@example.com`;

  const admin = await usersService.createUser({
    email: adminEmail,
    password: AUDIT_COVERAGE_PASSWORD,
    name: 'Coverage Admin',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Audit Coverage E2E',
    ownerUserId: admin.id,
  });
  const project = await projectsService.createProject({
    name: 'Audit Coverage',
    identifier: 'ACV',
    workspaceId: workspace.id,
    actorUserId: admin.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: admin.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  // The MEMBER: a real second account in the same workspace, with no project
  // admin capability. The story's negative case is asserted with this session
  // rather than by omitting an assertion.
  const member = await usersService.createUser({
    email: memberEmail,
    password: AUDIT_COVERAGE_PASSWORD,
    name: 'Coverage Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: member.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  // Three connected repos, so the list renders at all (it is not drawn at N = 1).
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `inst-${prefix}`,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [AUDITED_REPO, ...UNAUDITED_REPOS].map((ref, i) => {
      const [owner, name] = ref.split('/');
      return {
        providerRepoId: `${9100 + i}`,
        owner: owner!,
        name: name!,
        defaultBranch: 'main',
        archived: false,
      };
    }),
  });

  // `/planning` forwards a never-onboarded project to /onboarding; this story's
  // surface is the ESTABLISHED-project workspace.
  await db.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });

  return {
    adminEmail,
    memberEmail,
    password: AUDIT_COVERAGE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}
