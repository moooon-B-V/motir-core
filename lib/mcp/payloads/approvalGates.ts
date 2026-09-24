import { z } from 'zod/v4';
import {
  approvalGateDecisionSchema,
  approvalGateRecordSchema,
} from '@/lib/api/v1/workItems/schema';
import { definePayload } from './define';

// The APPROVAL-GATE payload shape (Bug MOTIR-6191).
//
// `get_approval_gate` DERIVES from the v1 `ApprovalGateDecision` component rather
// than restating it, which matters here for the same reason it mattered for the
// design verdicts: the two doors exist for the SAME caller in two different
// runtimes — the runbook holds a workspace PAT and calls the tool, a dispatched
// agent holds the CLI grant and calls the route — so a field present on one and
// missing on the other would mean an agent's ability to read a reviewer's note
// depended on which sandbox it happened to be running in. That is precisely the
// asymmetry the bug was about, one level up.
//
// The ENVELOPE (`workItemKey` / `workItemTitle` / `kind` / `routedToLabel` around
// the gate) stays MCP's own, per the seam's own doctrine (ADR Amendment 7 Q6 rule
// 3) — and it happens to be identical to v1's body, because there is nothing an
// agent reads differently about one gate. The PROBE is on the gate itself, which
// is the part that carries the resource.

/** `get_approval_gate` — one gate's decision record, or `gate: null`. */
export const getApprovalGatePayload = definePayload({
  schema: approvalGateRecordSchema.catchall(z.unknown()) as unknown as z.ZodType<
    { gate?: unknown } & Record<string, unknown>
  >,
  probes: [
    {
      resource: 'ApprovalGateDecision',
      // `gate: null` is an ANSWER rather than an omission, and an empty selection
      // is legitimate (`ResourceProbe`'s own contract) — there is no resource in
      // that answer to validate.
      select: (p) => (p.gate === null || p.gate === undefined ? [] : [p.gate]),
    },
  ],
});

/** Kept so the decision schema is imported at the type level where it is probed. */
export type McpApprovalGateDecision = z.infer<typeof approvalGateDecisionSchema>;
