import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { planRepository } from '@/lib/repositories/planRepository';
import { plansService } from '@/lib/services/plansService';
import { NoPlanForJobError } from '@/lib/plans/errors';
import type { ProposalInput } from '@/lib/dto/plans';

// Issue-tree generation, motir-core side (Subtask 7.4.4 · MOTIR-846). The thin
// seam between the planning workspace and the motir-ai `generate_tree` handler
// (7.4.2 · MOTIR-844), built ON the 7.21 Plan substrate (MOTIR-1336): generation
// EMITS `add` PlanItem PROPOSALS into a `Plan`; nothing materializes here — a real
// work-item tree appears only when the user APPROVES the plan (7.21 approve/
// materialize). motir-core owns NO planning logic: it opens the Plan, submits the
// job (the 7.1.5 client mints the §4b job-scoped read-back token internally),
// relays the job's SSE stream to the browser, and exposes the internal append seam
// the handler calls back into. The browser reaches motir-ai ONLY through this
// service + its routes (the open-core invariant — the client is `server-only`).
//
// Plan ↔ job binding: the Plan's `sourceJobId` is set to the submitted jobId at
// `createPlan`, so the internal seam resolves "the job's Plan" from the jobId the
// handler already holds — no planId threading through motir-ai, no JobContextBag
// change. The lookup is workspace-scoped, so a job token for one tenant can never
// append to another's plan (NoPlanForJobError → 404, the no-leak posture).
//
// 4-layer (CLAUDE.md): this service orchestrates `plansService` (the 7.21 owner of
// the Plan transactions + grammar/ref validation) + `planRepository` for the
// job→plan read; it re-uses `addProposals`' invariants rather than re-implementing
// them. The routes are thin transports over these methods.

export interface StartGenerationInput {
  /** Optional seed prompt for the generation job (the planning workspace's
   *  framing of what to generate); rides in the job context bag. */
  prompt?: string | null;
  /** Optional human label / summary stamped on the opened Plan. */
  title?: string | null;
  summary?: string | null;
}

export const aiGenerationService = {
  // Open a `generating` Plan + submit the `generate_tree` job for the actor's
  // active project; return the ids the surface needs ({ jobId, planId }). The job
  // is submitted FIRST so the Plan can bind to it via `sourceJobId` — and so a
  // submit failure (unreachable / out-of-credits) leaves NO orphan Plan behind.
  // The out-of-credits refusal propagates as a typed MotirAiOutOfCreditsError the
  // route maps to a distinct 402 (7.2 metering), consumable by the 7.4.9 UI.
  async startGeneration(
    ctx: ProjectContext,
    input: StartGenerationInput = {},
  ): Promise<{ jobId: string; planId: string }> {
    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = {
      organizationId,
      isMeta,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      projectKey: ctx.project.identifier,
    };
    const { jobId } = await submitJob(
      'generate_tree',
      tenant,
      { prompt: input.prompt ?? null },
      { userId: ctx.userId },
    );
    const plan = await plansService.createPlan(
      ctx.projectId,
      { title: input.title ?? null, summary: input.summary ?? null, sourceJobId: jobId },
      ctx,
    );
    return { jobId, planId: plan.id };
  },

  // The live channel the 7.4.9 generation UI subscribes to: relay the motir-ai
  // `generate_tree` job stream so `add` PlanItems show up LIVE as the handler
  // appends them. A transport failure throws a typed MotirAiError before the
  // first yield (the route maps it to an HTTP status); the stream ends when
  // motir-ai closes it on a terminal state. The terminal-failure REASON (e.g.
  // out-of-credits) is appended by the stream ROUTE via `failureReasonFrame`.
  streamGeneration(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  // The INTERNAL append seam motir-ai's handler calls (replaces the whole-delta
  // `commitPlanDelta`): append a batch of proposals to the job's `Plan` via the
  // 7.21 `addProposals`, and — when the frontier is complete (`final`) — mark the
  // plan `planned`. Creates NO WorkItem and sets no status on the tree. Returns the
  // created PlanItem ids IN APPEND ORDER — the stable temp-ref keys the handler
  // reuses for intra-plan parent/blocker refs. The plan is resolved by `sourceJobId`
  // (workspace-scoped → NoPlanForJobError/404 cross-tenant); `addProposals` then
  // re-asserts edit access + the `generating` status under its own row lock.
  async appendProposals(
    jobId: string,
    proposals: ProposalInput[],
    ctx: ServiceContext,
    opts: { final?: boolean } = {},
  ): Promise<{ planId: string; planItemIds: string[]; planned: boolean }> {
    const plan = await planRepository.findBySourceJobId(jobId, ctx.workspaceId);
    if (!plan) throw new NoPlanForJobError(jobId);

    let createdIds: string[] = [];
    if (proposals.length > 0) {
      const result = await plansService.addProposals(plan.id, proposals, ctx);
      // A generation job is the SOLE writer of its plan and appends sequentially
      // (the handler awaits each batch), and `addProposals` returns every item in
      // append order (createdAt asc, id asc) — so this call's creations are exactly
      // the last `proposals.length` items.
      createdIds = result.items.slice(result.items.length - proposals.length).map((i) => i.id);
    }

    let planned = false;
    if (opts.final) {
      await plansService.markPlanned(plan.id, ctx);
      planned = true;
    }

    return { planId: plan.id, planItemIds: createdIds, planned };
  },
};
