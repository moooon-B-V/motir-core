import type { ApprovalGateKindDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';

// Client read of the approval OVERLAY's one gate (Story MOTIR-5214 · Subtask
// MOTIR-5224) from `GET /api/work-items/approval-gate?key=&kind=` (MOTIR-5223).
//
// The overlay is a client island, so it may not reach a service; this is the
// CLIENT half beside `lib/planning/planningAnchorClient.ts`, and a consumer calls
// this, never the route path.
//
// A `404` is the no-existence-leak contract answering *there is nothing here you
// may see* — an unknown, foreign or non-browsable key, all one answer — and a
// `400` is an address the route will not read at all. Both resolve `null`, which
// the overlay draws as § 22's Panel 5a. Any other non-`2xx` THROWS, and an abort
// propagates as the caller's `AbortError`, so a superseded read is
// distinguishable from a failed one.

export async function fetchApprovalGateOverlay(
  key: string,
  kind: ApprovalGateKindDTO,
  signal?: AbortSignal,
): Promise<ApprovalGateOverlayReadDTO | null> {
  const qs = new URLSearchParams({ key, kind });
  const res = await fetch(`/api/work-items/approval-gate?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
    // A gate's state changes under the reader by design; the route says
    // `no-store` and the client does not second-guess it.
    cache: 'no-store',
    signal,
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    throw new Error(`Approval gate read failed (${res.status})`);
  }
  return (await res.json()) as ApprovalGateOverlayReadDTO;
}
