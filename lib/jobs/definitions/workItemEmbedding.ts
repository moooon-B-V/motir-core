import { defineJob } from '../defineJob';
import type { WorkItemEmbeddingRequestedData } from '../types';

// The plan-tree embedding WRITER (Story MOTIR-2694 · Subtask MOTIR-2696, per
// `docs/decisions/plan-tree-embeddings.md` §6.3) — the background half of the
// write path. Its whole reason to exist as a JOB rather than an inline call is
// §6.3.2: embedding is an external network call across the open-core boundary,
// so it runs AFTER the work-item transaction has committed and cannot fail,
// delay, or roll back the card write that triggered it. A gateway outage
// degrades an item to "not yet a candidate"; it never fails a create.
//
// A NEW event with ONE consumer, so the 1:1 id-is-the-event-name convention
// applies (no explicit `trigger`). It is deliberately NOT another consumer of
// `work-item/created` / `work-item/field.changed`: neither of those fires on the
// trigger this needs. `created` would miss every EDIT, and `field.changed` is
// emitted only for the four automatable built-ins (assignee / priority / dueDate
// / estimate) — precisely the fields that must NOT provoke an embedding call.
// The emit gate is the content hash, so it belongs on its own event.
//
// `retryPolicy: 'idempotent'` (5 attempts). The work is fully decoupled from the
// originating write and is idempotent at two layers — the service recomputes the
// content hash and skips when it already matches, and the repository upserts on
// the work item's PK — so a retry is cheap and can never double-write. A
// transient motir-ai outage is worth the full budget; a permanent
// mis-configuration is short-circuited inside the service (no call, no throw),
// so a self-hosted deployment with no AI backend does not dead-letter a job on
// every card edit.
//
// NO DEBOUNCE, deliberately. Coalescing rapid same-item edits looks attractive
// and buys nothing here: §6.3.3's re-read already makes the LAST job authoritative
// whatever the order, and the content-hash skip already makes every job but the
// effective one a single cheap read with no provider call. A debounce would trade
// that for added latency on the common single-edit path.

export const workItemEmbeddingRequested = defineJob(
  { id: 'work-item/embedding.requested', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemEmbeddingRequestedData;
    return ctx.step.run('embed-work-item', () =>
      services.workItemEmbeddings.embedWorkItem({
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
      }),
    );
  },
);
