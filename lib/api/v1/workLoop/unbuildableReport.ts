import { z } from 'zod/v4';
import { RUN_FOUND_REPORT_REASON_MAX } from '@/lib/dispatchRuns/errors';
import type { RunFoundReportAcknowledgement } from '@/lib/services/runFoundReportService';

// The run-found report's RUN door (MOTIR-8698,
// `docs/decisions/run-found-trigger-dispatched-path.md` AMENDMENT 1) —
// `POST /api/v1/dispatch-runs/{id}/unbuildable`. The CLI posts it with the run's own
// credential when its agent stopped on an unbuildable card, so the report reaches
// the server in every lane: a hosted run's agent has no Motir token, and a local
// agent may have no Motir MCP.

/** What the CLI sends: the card the agent stopped on, and the agent's reason. */
export const unbuildableReportBodySchema = z
  .object({
    /** The stopped card's `KEY-<n>` — a card the run holds. */
    targetKey: z.string().trim().min(1),
    /** Why the agent could not build it — the text of its comment on the card. */
    reason: z.string().trim().min(1).max(RUN_FOUND_REPORT_REASON_MAX),
  })
  .strict();
export type V1UnbuildableReportBody = z.infer<typeof unbuildableReportBodySchema>;

/**
 * The whole answer — the same acknowledgement the MCP tool gives. Never the verdict,
 * the plan, the outcome or a bug key: whether the card had an open leg on this run is
 * the one bit it carries.
 */
export const unbuildableReportAcknowledgementSchema = z.object({
  acknowledged: z.literal(true),
  recordedOnRun: z.boolean(),
});
export type V1UnbuildableReportAcknowledgement = z.infer<
  typeof unbuildableReportAcknowledgementSchema
>;

export function presentUnbuildableReportAcknowledgement(
  ack: RunFoundReportAcknowledgement,
): V1UnbuildableReportAcknowledgement {
  return { acknowledged: true, recordedOnRun: ack.recordedOnRun };
}
