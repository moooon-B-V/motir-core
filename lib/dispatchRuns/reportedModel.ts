// The ONE validity rule for an agent's self-reported model on the run record
// (MOTIR-7502, `docs/decisions/dispatch-run-record.md` — the leg-model
// amendment).
//
// It restates the CLI's own rule (`readAgentReport` / `MAX_MODEL_LENGTH` in
// `packages/cli/src/agentRun.ts`) on the server, because the server must not
// trust the wire: an older CLI, a hand-rolled reporter or a hosted runner can
// send anything in `data.model`. The back-fill migration
// (`*_dispatch_run_card_model_backfill`, MOTIR-7503) mirrors it in SQL — the
// two MUST agree, and a change here is a change there.

/** Longer than any real model id: an agent that dumped its context into the field. */
export const MAX_REPORTED_MODEL_LENGTH = 200;

/**
 * A reported model, or null. Total: a non-string, a blank, a whitespace-only or
 * an over-long value is the same answer — no model — and a valid one comes back
 * TRIMMED. Rejected rather than truncated: half an identifier is a wrong answer.
 */
export function normalizeReportedModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_REPORTED_MODEL_LENGTH) return null;
  return trimmed;
}

/**
 * The model an `agent_exited` event reports for its leg: the TOP-LEVEL `model`
 * when the event carries one (any CLI from MOTIR-7504 on), else `data.model` —
 * the shape every CLI since MOTIR-2419 already sends, so an installed CLI fills
 * the column without upgrading. Top-level wins when both are present, even when
 * it is invalid: the newer field is the reporter's statement, and a reporter
 * that says "no model" on purpose is not overruled by a stale `data` copy.
 */
export function reportedModelOf(event: { model?: unknown; data?: unknown }): string | null {
  if (event.model !== undefined) return normalizeReportedModel(event.model);
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return normalizeReportedModel((data as { model?: unknown }).model);
}
