// Seed for the onboarding GitHub-connect acceptance walk (Story MOTIR-8241 ·
// MOTIR-8477).
//
// It builds the state each test STARTS from and nothing further: a person with
// one project, a work item for the plan-window return address to name, and a
// migrate run whose saved step is `connect`. Everything after that (the press,
// the install start, the setup callback, the advance) is the shipped path the
// spec drives. The person, project and item ride the real services, the
// sanctioned cross-layer reach every other E2E seed uses
// (`onboarding-routing-seed.ts`).
//
// ⚠️ THE RUN IS STARTED, AND READ BACK, THROUGH ITS OWN ROUTES — not by importing
// `migrateOnboardingService` into the runner. That module's import graph reaches
// `lib/theme/styles.ts` → `@motir/design-system`, an ESM-only package with no
// `require` export, so Playwright's CommonJS loader cannot load it (`No "exports"
// main defined`), and the whole spec file fails to collect. The routes call the
// same service methods (`startMigration`, `getById`) as the signed-in person.
//
// ⚠️ NO GITHUB IDENTITY IS SEEDED, deliberately. The card's assumption was that
// the setup callback reads the account and repositories with the actor's user
// token; it does not. `bindInstallationForWorkspace` reads the account with the
// App JWT (`GET /app/installations/{id}`) and the repositories with an
// installation token, both answered by the lane's `E2E_TEST_GITHUB_ACCOUNTS`
// seam. A user-token row would be state nothing on this path reads.

import { adminDb } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { encodeInstallState, type InstallReturnContext } from '@/lib/github/installState';
import type { APIRequestContext } from '@playwright/test';
import type { MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

export const CONNECT_JOURNEY_PASSWORD = 'ConnectJourney1!';

export interface ConnectJourneySeed {
  email: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  /** A work item's key: the plan window the hand-off's return address names. */
  itemKey: string;
}

/**
 * A person with one project and nothing connected. `onboardingRanAt` stays null
 * (a stamped project is sent away from the wizard), and the project is pinned
 * active, because the migrate page, its routes and the install start all read
 * the active project. The run itself is {@link startRun}'s.
 */
export async function seedConnectJourney(email: string): Promise<ConnectJourneySeed> {
  const owner = await usersService.createUser({
    email,
    password: CONNECT_JOURNEY_PASSWORD,
    name: 'Connect Journey Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Connect Journey E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Acme Widgets',
    identifier: 'CONN',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Checkout redesign' },
    ctx,
  );
  return {
    email,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    itemKey: item.identifier,
  };
}

/** Start the signed-in person's migrate run: `POST /api/onboarding/migrate`,
 *  the wizard's own start (`migrateOnboardingService.startMigration`). A new run
 *  is saved at its first step, `connect`. */
export async function startRun(request: APIRequestContext): Promise<MigrateOnboardingDto> {
  const res = await request.post('/api/onboarding/migrate', { data: {} });
  if (res.status() !== 200) {
    throw new Error(`starting the migrate run answered ${res.status()}: ${await res.text()}`);
  }
  return (await res.json()) as MigrateOnboardingDto;
}

/** The run, read back through `GET /api/onboarding/migrate/[id]`, which is
 *  `migrateOnboardingService.getById` as the signed-in person. */
export async function readRun(
  request: APIRequestContext,
  runId: string,
): Promise<MigrateOnboardingDto> {
  const res = await request.get(`/api/onboarding/migrate/${runId}`);
  if (res.status() !== 200) {
    throw new Error(`reading the migrate run answered ${res.status()}: ${await res.text()}`);
  }
  return (await res.json()) as MigrateOnboardingDto;
}

/**
 * An install state for this person's connect step that EXPIRED an hour ago,
 * signed with the product's own encoder. The ten-minute TTL cannot be waited out
 * inside a test, so this is the only state the walk mints itself; every other one
 * is captured from the install URL the step's own action produced.
 *
 * The runner must sign with the server's `BETTER_AUTH_SECRET`; the spec checks
 * that against a captured state before it relies on this.
 */
export function expiredConnectState(
  seed: ConnectJourneySeed,
  context?: InstallReturnContext,
): string {
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
  return encodeInstallState(
    {
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      origin: 'onboardingMigrateConnect',
      ...(context ? { context } : {}),
    },
    anHourAgo,
  );
}
