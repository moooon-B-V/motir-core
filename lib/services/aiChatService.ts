import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';

// The chat front door's dispatch side (Subtask 7.3.4): the thin motir-core seam
// between the chat UI (7.3.5) and the motir-ai `discovery` job handler (7.3.3).
// motir-core owns NO planning logic here — it forwards a user turn into a
// `discovery` job via the 7.1.5 client (which mints the job-scoped read-back
// token internally) and relays the job's SSE stream back. The browser reaches
// motir-ai ONLY through this service + its routes (the open-core invariant: the
// client is `server-only`, so it can never be bundled into a Client Component).
//
// Project resolution + the auth/membership gate happen in the route layer
// (getSession + getActiveProject, the project analogue of getSession — mirrors
// /api/board); this service receives the already-resolved ProjectContext and
// builds the tenant from it. The project fields come straight off the context
// (no second project round-trip); the only extra read is the workspace's ORG —
// the billing entity the job-submit tenant must carry (7.2.16), resolved the
// same RLS-aware way aiJobsService does.

export const aiChatService = {
  // Submit a user turn into a `discovery` job for the actor's active project.
  // The prompt rides in the context bag; motir-ai owns the interview state
  // across turns. Returns the jobId the stream route subscribes to.
  async submitDiscoveryTurn(prompt: string, ctx: ProjectContext): Promise<{ jobId: string }> {
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
    return submitJob('discovery', tenant, { prompt }, { userId: ctx.userId });
  },

  // The live channel the 7.3.5 UI subscribes to: relay the motir-ai job stream
  // (assistant-turn tokens + progress + terminal status). A transport failure
  // throws a typed MotirAiError before the first yield (the route maps that to
  // an HTTP status); the generator ends when motir-ai closes the stream on a
  // terminal state. (The terminal-failure REASON — e.g. out-of-credits — is
  // appended by the stream ROUTE, which owns the iterator so client-disconnect
  // cancellation stays prompt; see lib/ai/jobStream.failureReasonFrame.)
  streamDiscovery(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },
};
