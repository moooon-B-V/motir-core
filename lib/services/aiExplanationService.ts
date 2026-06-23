import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';

// The "Draft with AI" dispatch side (Subtask 8.8.12): the thin motir-core seam
// between the create-modal / edit-form drafting UI and the motir-ai
// `generate_explanation` job handler (8.8.11). motir-core owns NO drafting logic
// — it forwards the work-item context into a `generate_explanation` job via the
// 7.1.5 client (which mints the job-scoped read-back token internally) and relays
// the job's SSE stream back token-by-token. The browser reaches motir-ai ONLY
// through this service + its routes (the open-core invariant: the client is
// `server-only`, so it can never be bundled into a Client Component).
//
// Mirrors aiChatService exactly (same tenant build, same org resolution); the
// only difference is the job kind + the `explanation` context hole. Project
// resolution + the auth/membership gate happen in the route layer (getSession +
// getActiveProject); this service receives the resolved ProjectContext.

// The work-item fields the draft is generated FROM. Only `title` is required;
// the rest sharpen the draft. The route whitelists these off the client body.
export interface ExplanationDraftInput {
  title: string;
  description?: string | null;
  type?: string | null;
  parentKey?: string | null;
  parentTitle?: string | null;
}

export const aiExplanationService = {
  // Submit a `generate_explanation` job for the actor's active project. The
  // work-item context rides in the `explanation` context hole; motir-ai drafts +
  // streams the markdown. Returns the jobId the stream route subscribes to.
  async submitExplanationDraft(
    input: ExplanationDraftInput,
    ctx: ProjectContext,
  ): Promise<{ jobId: string }> {
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
    const explanation = {
      title: input.title,
      description: input.description ?? null,
      type: input.type ?? null,
      parent:
        input.parentKey || input.parentTitle
          ? { key: input.parentKey ?? null, title: input.parentTitle ?? null }
          : null,
    };
    return submitJob('generate_explanation', tenant, { explanation }, { userId: ctx.userId });
  },

  // The live channel the drafting UI subscribes to: relay the motir-ai job stream
  // (token frames + the terminal `explanation` frame + status). A transport
  // failure throws a typed MotirAiError before the first yield (the route maps
  // that to an HTTP status); the generator ends when motir-ai closes the stream.
  // (The terminal-failure REASON — e.g. out-of-credits — is appended by the
  // stream ROUTE; see lib/ai/jobStream.failureReasonFrame.)
  streamExplanation(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },
};
