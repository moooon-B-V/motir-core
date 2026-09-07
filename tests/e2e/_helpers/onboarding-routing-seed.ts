import { writeFileSync } from 'node:fs';
import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  E2E_INDEX_REPOS,
  indexRepoRef,
  recordIndexSucceeded,
  seedConnectedRepos,
} from './migrate-index-seed';

// SEED + BOUNDARY FIXTURE for the story's three destinations (Story MOTIR-4753 ·
// MOTIR-4762).
//
// ⚠️ WHAT IS REAL AND WHAT IS MOCKED, stated once so the recording is not read
// as proving something it does not. The SUBSTRATE is real — a genuine GitHub
// grant mirror row and a genuine succeeded `system.code-graph-index` ledger row,
// both written the way the product writes them, so `readOnboardingSubstrate`
// answers from committed state. The VERDICT is `motir-ai`'s and is mocked at the
// open-core boundary, which is the only interceptable seam and the same one
// every other cloud spec uses: the planner's judgement is the `motir-ai` gate's
// to prove, and from here it is exercised through the product, as a user meets
// it.

/** The boundary mock's fixture file — the acceptance lane sets this path. */
export const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

export interface RoutingVerdictFixture {
  outcome: 'continue' | 'onboard_new_project' | 'onboard_existing_project';
  message: string;
  keptSteps?: string[];
  missing?: string[];
}

/**
 * Declare what the NEXT routing run decides.
 *
 * ⚠️ WRITTEN PER CHAPTER, not once for the file. The mock re-reads the fixture on
 * every request, so each journey declares its own destination immediately before
 * the window opens — which is also what keeps the three chapters independent of
 * the order Playwright happens to run them in.
 */
export function declareRoutingVerdict(verdict: RoutingVerdictFixture): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ routing: [verdict] }, null, 2));
}

/** A project that has a repository Motir can READ — connected AND indexed. */
export async function seedReadableRepository(workspaceId: string): Promise<string> {
  const repo = E2E_INDEX_REPOS[0];
  await seedConnectedRepos(workspaceId, [repo]);
  const ref = indexRepoRef(repo);
  await recordIndexSucceeded(workspaceId, ref);
  return ref;
}

/** A project with a repository CONNECTED but no code graph yet — the shape the
 *  reading state draws differently, and the one a starter usually arrives in. */
export async function seedConnectedOnlyRepository(workspaceId: string): Promise<string> {
  const repo = E2E_INDEX_REPOS[0];
  await seedConnectedRepos(workspaceId, [repo]);
  return indexRepoRef(repo);
}

export const ROUTING_JOURNEY_PASSWORD = 'RoutingJourney1!';

export interface RoutingJourneySeed {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

/**
 * A project whose FIRST PLAN HAS NEVER BEEN APPROVED — which is the whole
 * population this story is about, and the default a freshly created project has.
 *
 * ⚠️ `onboardingRanAt` IS LEFT NULL DELIBERATELY, and never stamped by this
 * helper. It is what tells the layout to resolve a substrate and the plan window
 * to ask for a verdict; a seed that stamped it would produce a recording of the
 * ESTABLISHED path, which is the path this story does not change.
 */
export async function seedRoutingJourney(
  email: string,
  opts: { items?: number; identifier?: string } = {},
): Promise<RoutingJourneySeed> {
  const owner = await usersService.createUser({
    email,
    password: ROUTING_JOURNEY_PASSWORD,
    name: 'Routing Journey Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Routing Journey E2E',
    ownerUserId: owner.id,
  });
  const identifier = opts.identifier ?? 'ROUTE';
  const project = await projectsService.createProject({
    name: 'Acme Widgets',
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin it active — the plan window is active-project scoped, and so is the
  // layout read that resolves the substrate.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  for (let i = 0; i < (opts.items ?? 0); i += 1) {
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title: `Imported story ${i + 1}` },
      ctx,
    );
  }
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: identifier,
  };
}
