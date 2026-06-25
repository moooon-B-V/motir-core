import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import {
  toDirectionDocView,
  type DirectionDocKind,
  type DirectionDocView as DirectionDocModel,
} from '@/lib/onboarding/directionDoc';

// The single BROWSER-side read of the active project's resumable pre-plan state
// (`GET /api/ai/pre-plan`, MOTIR-1188 / 7.3.70). Shared by the onboarding resume
// loop (`useDiscoveryChat`) and the on-canvas tier-doc viewer (`TierDocModal`,
// MOTIR-1355) so neither hand-rolls the request. The project is resolved from the
// active-project context server-side (never a client-supplied key), so this call
// carries no project argument.
//
// Returns null on any non-OK response — 401 (unauth), 404 (no active project), or
// 502 (motir-ai upstream failure): the caller renders its own empty / error state
// rather than this throwing. An aborted fetch (the component unmounted / the tier
// changed) rejects as usual and the caller's seq guard discards it.
export async function fetchPreplanState(signal?: AbortSignal): Promise<PreplanStateDTO | null> {
  const res = await fetch('/api/ai/pre-plan', {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as PreplanStateDTO;
}

// Find one tier's produced doc in a pre-plan read, mapped to the read-only
// `DirectionDocView` model (834) via `toDirectionDocView`. Null when that tier has
// not been drafted yet — the viewer's EMPTY state.
export function findTierDoc(
  state: PreplanStateDTO,
  kind: DirectionDocKind,
): DirectionDocModel | null {
  const log = state.docs.find((d) => d.kind === kind);
  return log ? toDirectionDocView(log) : null;
}

// The kinds of the tiers a project has produced (DTO journey order) — the
// `DirectionDocView` cross-link footer set.
export function producedTierKinds(state: PreplanStateDTO): DirectionDocKind[] {
  return state.docs.map((d) => d.kind);
}
