// AI plan-generation E2E seed (Subtask 7.4.7 / MOTIR-849).
//
// The generation entry (7.4.9 / MOTIR-1396) is ACTIVE-PROJECT scoped and reaches
// motir-ai (the `generate_tree` job) — which has no presence in CI. So this
// fixture, like `plans-review-seed.ts`, mints its own sign-in-able tenant (owner +
// workspace + project, the project PINNED active) entirely through the SHIPPED
// services, and pre-opens ONE `generating` Plan bound to a known `sourceJobId`.
//
// The spec then STUBS the browser→motir-ai boundary (`/api/ai/plan/generate` +
// its stream + `/api/ai/pre-plan` + `/api/ai/access`) so no live model runs, and
// drives the REAL per-node append by calling `plansService.addProposals` against
// this seeded plan — the same service the internal append seam wraps, and the one
// sanctioned cross-layer reach for E2E setup (exactly as this seed's siblings use
// `plansService` / `backlogService`). The running app's reveal poll
// (`GET /api/plans/:id`) then surfaces those REAL `PlanItem` rows on the canvas.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as plans-review-seed's).
export const AI_GEN_SEED_PASSWORD = 'ai-plan-gen-e2e-pass-7';

// The job id the stubbed `POST /api/ai/plan/generate` returns and the seeded
// Plan's `sourceJobId` — they only need to be internally consistent for the stub.
export const AI_GEN_JOB_ID = 'job_e2e_generation';

export interface AiPlanGenerationSeed {
  email: string;
  password: string;
  /** The acting context for driving `plansService.addProposals` / `markPlanned`. */
  ctx: ServiceContext;
  projectId: string;
  /** The pre-opened `generating` Plan the stubbed generate route hands back. */
  planId: string;
}

/** A sign-in-able tenant with its project pinned active + one `generating` Plan. */
export async function seedAiPlanGeneration(email: string): Promise<AiPlanGenerationSeed> {
  const owner = await usersService.createUser({
    email,
    password: AI_GEN_SEED_PASSWORD,
    name: 'Generation Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Generation E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Plan Generation',
    identifier: 'GEN',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active for the owner so the active-project-scoped /onboarding
  // generation entry + /api/plans/:id read resolve it on sign-in.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  // The Plan the stubbed generate route returns — opened `generating`, with the
  // known job id. The spec appends proposals into it live, then marks it planned.
  const plan = await plansService.createPlan(
    project.id,
    { title: 'Generated plan', sourceJobId: AI_GEN_JOB_ID },
    ctx,
  );

  return { email, password: AI_GEN_SEED_PASSWORD, ctx, projectId: project.id, planId: plan.id };
}
