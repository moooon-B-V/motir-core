import { submitJob, getPreplanState as fetchPreplanState } from '@/lib/ai/motirAiClient';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';

// The FRESH-establish coding-convention TRIGGER, motir-core side (Subtask 7.3.10 ·
// MOTIR-839). At the end of FRESH onboarding — the first time a project's plan is
// approved + materialized (plansService.approvePlan) — this ESTABLISHES a coding
// convention by submitting the `propose_convention` job in fresh establish-only
// mode. There is NO derivation logic here (that is motir-ai's fresh handler,
// MOTIR-1601), NO adopt UI (7.14.5 · MOTIR-926), and NO audit (fresh has no code,
// Story 7.15). This service only READS the pinned stack over the 7.1 boundary and
// TRIGGERS the job, so a `status: proposed` `CodingConvention` exists for the user
// to adopt.
//
// 4-layer (CLAUDE.md): a thin service over the `server-only` 7.1.5 client — no
// `motir-ai` import, no AI table, no Prisma transaction (the reads go through the
// existing `resolveCodeContext` / `resolveTenantOrg` / preplan-read helpers). The
// caller fires it BEST-EFFORT after its own transaction commits.

export interface EstablishConventionInput {
  userId: string;
  workspaceId: string;
  projectId: string;
  /** The project's `identifier` (the `MOTIR`-style key) — the tenant projectKey. */
  projectKey: string;
}

export type EstablishConventionResult =
  | { submitted: true; jobId: string; stackHint: string | undefined }
  | { submitted: false; reason: 'has_connected_repo' };

// Map the discovery doc's inferred `platform` to the stack hint keyword motir-ai's
// fresh deriver resolves (`resolveStack` → node_ts | python | go | jvm | generic).
// We only claim a stack where Motir has a KNOWN default starter: the `web` platform
// (and the `null` = web default) ships the Next.js + Prisma + Postgres starter — a
// TypeScript/Node stack — so we hint `'typescript'`. Every other platform
// (desktop / mobile / other) has no pinned starter stack yet, so we send NO hint
// and let motir-ai derive a `generic` convention — never inventing a stack Motir
// hasn't decided.
export function platformToStackHint(platform: string | null | undefined): string | undefined {
  if (platform === undefined || platform === null || platform === 'web') return 'typescript';
  return undefined;
}

export const conventionEstablishService = {
  /**
   * Trigger the fresh `propose_convention` job for a just-onboarded project. The
   * caller gates on "first onboarding"; this method additionally applies the
   * FRESH gate and never throws for a non-fresh project — it returns
   * `{ submitted: false }` instead.
   */
  async establishForFreshProject(
    input: EstablishConventionInput,
  ): Promise<EstablishConventionResult> {
    // FRESH gate: only a project with NO connected code repo establishes its
    // convention from the stack alone. A connected repo means motir-ai has (or
    // will have) an indexed code graph, so the convention is DERIVED by the
    // migrate/audit path (Story 7.15 orchestration · MOTIR-931) — not this
    // trigger. This mirrors motir-ai's own fresh-vs-migrate auto-selection (it
    // branches on an indexed graph), so firing here for a repo-backed project
    // would otherwise hit the not-yet-wired migrate seam.
    const code = await resolveCodeContext({
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    if (code) return { submitted: false, reason: 'has_connected_repo' };

    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    const stackHint = await resolveStackHint(input.workspaceId, input.projectId);

    const { jobId } = await submitJob(
      'propose_convention',
      {
        organizationId,
        isMeta,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        projectKey: input.projectKey,
      },
      // Fresh establish-only envelope: a stack HINT only, no repoRef / no repos —
      // motir-ai's fresh path (MOTIR-1601) derives the convention from the stack
      // alone and records it `status: proposed`. `context.code` is always an
      // object so the handler's parser reads `context.code.stack` without a guard.
      { code: stackHint ? { stack: stackHint } : {} },
      { userId: input.userId },
    );
    return { submitted: true, jobId, stackHint };
  },
};

// Read the pinned stack from the discovery/direction doc over the 7.1 boundary
// (the 7.3.25 preplan read). BEST-EFFORT: any read failure — a not-yet-started
// session, an unknown platform, or a transport error — yields NO hint, and motir-ai
// derives a `generic` convention. Never throws: the caller fires the establish at
// onboarding completion and a stack read must not fail the approve.
async function resolveStackHint(
  workspaceId: string,
  projectId: string,
): Promise<string | undefined> {
  try {
    const state = await fetchPreplanState({
      coreWorkspaceId: workspaceId,
      coreProjectId: projectId,
    });
    return platformToStackHint(state.session?.platform ?? null);
  } catch {
    return undefined;
  }
}
