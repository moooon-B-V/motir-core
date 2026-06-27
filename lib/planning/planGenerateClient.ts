// Client trigger for the 7.4 generation ENTRY (Subtask 7.4.9 / MOTIR-1396). It
// POSTs `/api/ai/plan/generate` (7.4.4 / MOTIR-846) to open a `generating` Plan +
// submit the `generate_tree` job, returning `{ jobId, planId }` the entry then
// streams (`GET …/:jobId/stream`) + reveals live, before handing a `planned` plan
// to the 7.21 review surface (`/plans/:id`).
//
// Out-of-credits is a FIRST-CLASS typed outcome (7.2 metering): the route maps the
// credit gate's refusal to a DISTINCT 402 (`MOTIR_AI_OUT_OF_CREDITS`), so the
// entry branches to the credits prompt — NEVER collapsed into a generic failure.
// Mirrors `planReviewClient`'s `PlanRequestError` shape (the 7.21 read/write side).

export const OUT_OF_CREDITS_CODE = 'MOTIR_AI_OUT_OF_CREDITS';

export class PlanGenerateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Plan generation request failed (${status})`);
    this.name = 'PlanGenerateError';
  }

  /** The credit gate refused (7.2.8 → 402) — the entry shows the credits prompt,
   *  not the generic failure state. The route uses 402 AND the typed code, so we
   *  accept either signal. */
  get isOutOfCredits(): boolean {
    return this.status === 402 || this.code === OUT_OF_CREDITS_CODE;
  }
}

export interface StartPlanGenerationResult {
  jobId: string;
  planId: string;
}

export interface StartPlanGenerationInput {
  /** Optional seed prompt (the workspace's framing of what to generate); the
   *  onboarding hand-off omits it — generation seeds from the pre-plan baseline. */
  prompt?: string | null;
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

/** Start a plan generation for the actor's active project. Throws
 *  `PlanGenerateError` on a non-2xx (402 ⇒ `isOutOfCredits`). */
export async function startPlanGeneration(
  input: StartPlanGenerationInput = {},
  signal?: AbortSignal,
): Promise<StartPlanGenerationResult> {
  const res = await fetch('/api/ai/plan/generate', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.prompt ?? null }),
    signal,
  });
  if (!res.ok) throw new PlanGenerateError(res.status, await readErrorCode(res));
  return (await res.json()) as StartPlanGenerationResult;
}
