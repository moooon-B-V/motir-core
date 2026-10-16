import type {
  PlanningGuideSeedDTO,
  PlanningGuideSeedReadDTO,
  PlanningSeedDTO,
  PlanningSeedReadDTO,
} from '@/lib/dto/planningSeed';

// Client read of the REFUSAL SEED (story MOTIR-6068 · MOTIR-6210) from
// `GET /api/approval-gates/{id}/planning-seed` (MOTIR-6208) — what the planning
// overlay opens with when its address is `planFrom=refused-gate&planGate=<id>`:
// the refused card to anchor on, the first turn to pre-fill UNSENT, and the
// viewer's own recent seeded session to return to instead.
//
// The overlay is a client island, so it reads over the wire; a consumer calls
// this, never the route path — the same shape as `planningAnchorClient.ts`.
//
// Like the anchor read, a `404` and a failure are DIFFERENT answers here, even
// though the one consumer today treats them alike (both open the unseeded
// fall-back, silently — design MOTIR-6206 sheet 8). A `404` is the no-existence-
// leak contract: an unknown, unreadable, foreign or not-refused gate all read the
// same. Anything else is a real failure, and folding it into `null` would make
// an outage look like a gate that does not exist.

/**
 * Fetch the refusal seed for `gateId`.
 *
 * Resolves `null` on `404`. THROWS on any other non-`2xx`, and lets an abort
 * propagate as the `AbortError` the caller's signal raised, so a superseded read
 * is distinguishable from a failed one.
 */
export async function fetchPlanningSeed(
  gateId: string,
  signal?: AbortSignal,
): Promise<PlanningSeedDTO | null> {
  const res = await fetch(`/api/approval-gates/${encodeURIComponent(gateId)}/planning-seed`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Planning seed read failed (${res.status})`);
  }
  const body = (await res.json()) as PlanningSeedReadDTO;
  return { ...body.seed, seededSessionId: body.seed.seededSessionId ?? null };
}

/**
 * Fetch the GUIDE-OFFER seed for `guideTurnId` (story MOTIR-8684 · MOTIR-8692) from
 * `GET /api/ai/guide/offer/{turnId}/planning-seed` — the twin of
 * {@link fetchPlanningSeed}, with the same contract: `null` on `404` (the
 * no-existence-leak answer), a THROW on any other non-`2xx`, and an abort
 * propagates as the caller's `AbortError`. The overlay start calls this on open.
 */
export async function fetchGuidePlanningSeed(
  guideTurnId: string,
  signal?: AbortSignal,
): Promise<PlanningGuideSeedDTO | null> {
  const res = await fetch(`/api/ai/guide/offer/${encodeURIComponent(guideTurnId)}/planning-seed`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Guide offer seed read failed (${res.status})`);
  }
  return ((await res.json()) as PlanningGuideSeedReadDTO).seed;
}
