// `/ready` EXPAND seed (Story MOTIR-5266 · MOTIR-7878).
//
// A tenant whose ready set is near-drained, plus the STUBS the nudge nominates:
// a THIN one (a title and nothing else — the planner asks what to plan), a CLEAR
// one (a body that says what it wants — the planner proposes), and two fresh ones
// for the reload and the zh chapters, so each chapter starts on a stub with no
// conversation yet. Seeded entirely through the SHIPPED services, as
// `planning-anchor-seed.ts` is.
//
// The nudge itself is stubbed at `/api/ready/nudge` by the spec — the nomination
// rule is not this story's — so these stubs only have to be real work items the
// overlay can anchor on.

import { adminDb } from '@/tests/helpers/adminDb';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

export const READY_EXPAND_PASSWORD = 'ready-expand-e2e-pass-7';

export interface ReadyStub {
  id: string;
  key: string;
  title: string;
}

export interface ReadyExpandSeed {
  email: string;
  password: string;
  projectId: string;
  projectName: string;
  /** A title-only story — what the planner cannot plan without asking. */
  thin: ReadyStub;
  /** A story whose body says what it wants — what the planner proposes for. */
  clear: ReadyStub;
  /** A fresh stub for the reload chapter. */
  reload: ReadyStub;
  /** A fresh stub for the zh chapter. */
  zh: ReadyStub;
}

export async function seedReadyExpand(email: string): Promise<ReadyExpandSeed> {
  const owner = await usersService.createUser({
    email,
    password: READY_EXPAND_PASSWORD,
    name: 'Ready Expand Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Ready Expand E2E',
    ownerUserId: owner.id,
  });
  const projectName = 'Relay';
  const project = await projectsService.createProject({
    name: projectName,
    identifier: 'RLY',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const story = async (title: string, descriptionMd?: string): Promise<ReadyStub> => {
    const created = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title, ...(descriptionMd ? { descriptionMd } : {}) },
      ctx,
    );
    return { id: created.id, key: created.identifier, title };
  };

  const thin = await story('Notifications');
  const clear = await story(
    'Report exports',
    [
      'People download a report as CSV or PDF from the report page.',
      '',
      '- an Export button on the report page',
      '- CSV and PDF formats',
      '- a download link that expires after a day',
    ].join('\n'),
  );
  const reload = await story('Audit log');
  const zh = await story('Billing history');

  // The one READY leaf that makes the set "near-drained" rather than empty, so the
  // lanes render beside the nudge as they do for a real project.
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Rotate the signing key' },
    ctx,
  );

  // The immutable onboarding-ran marker — without it the overlay opens on its
  // onboarding routing first, which this journey is not about.
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });

  return {
    email,
    password: READY_EXPAND_PASSWORD,
    projectId: project.id,
    projectName,
    thin,
    clear,
    reload,
    zh,
  };
}
