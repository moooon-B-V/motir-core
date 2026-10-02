// THE ONE HOME of "a plan read never names the model MOTIR planned with"
// (Story MOTIR-7220 · Subtask MOTIR-7225) — pure, no I/O.
//
// Motir abstracts its own model: platform staff choose it per audience in the
// operator console, and a tenant never sees which one ran. `toWorkItemDto`
// already strips the model from a NATIVELY planned work item; this module is
// the same rule for the PLAN reads, which carry the model in three places:
//
//   - a native `add` proposal's `planningProvenance.model` (motir-ai stamps it
//     from the run's model),
//   - a native plan revision's actor model (`PlanRevision.actorModel`),
//   - a plan's own author model, when its author is native.
//
// REDACT AT THE READ, NEVER AT THE WRITE. The stored rows keep the real id —
// it is Motir's internal cost and quality record, and `materialize` reads the
// ROW (not a DTO) to stamp `WorkItem.planningModel`. An agent-authored (`mcp`)
// plan keeps the model its author self-reported: that is the customer's own
// agent, and Decision 5 of `docs/decisions/work-item-provenance.md` exposes it.
//
// Every serialiser calls one of these two functions rather than writing the
// rule inline, so there is exactly one place it can drift.

/** Is this source Motir's own planner? */
function isNative(source: string | null | undefined): boolean {
  return source === 'native';
}

/**
 * A proposal's planning provenance as a tenant may read it: the model nulled
 * when the source is native, anything else returned as-is (an `mcp` triple,
 * and an absent or null provenance, which has nothing to redact).
 */
export function redactNativeProvenance<
  P extends { source?: string; harness?: string | null; model?: string | null },
>(provenance: P | null | undefined): P | null | undefined {
  if (!provenance || !isNative(provenance.source)) return provenance;
  return { ...provenance, model: null };
}

/**
 * An actor's or author's model as a tenant may read it: null when the
 * source is native, the model unchanged otherwise.
 */
export function redactNativeActor(
  source: string | null | undefined,
  model: string | null | undefined,
): string | null {
  return isNative(source) ? null : (model ?? null);
}
