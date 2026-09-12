'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

// THE ITEM PAGE'S OPTIMISTIC STATUS CHANNEL (Bug MOTIR-5212).
//
// ⚠️ WHAT THIS EXISTS FOR, IN ONE SENTENCE: a decision taken in ONE client
// island moves the card's status, and the surface that DRAWS the status is a
// DIFFERENT island fed by a server prop — so without a channel between them the
// rail cannot repaint until a server render lands, however fast the write was.
//
// The page-state contract (`CLAUDE.md`) routes the rail to case 2: a
// server-rendered surface elsewhere on the page, reached by `router.refresh()`.
// That is a correct classification and it is not enough on its own. MOTIR-5118
// measured the gap: the refresh fires and returns 200 in 113 ms while the rail
// keeps its pre-decision value for TWENTY SECONDS — *"a SECOND, separate apply
// that is intermittently lost, not a request that never happens."* Its remedy
// added a server-side `revalidatePath` beside the refresh and kept both. That
// narrowed the window; it could not close it, because BOTH halves still end in
// an RSC apply the browser may drop. **The rail had no in-browser path at all.**
//
// This is that path, and it is MOTIR-4496's shipped remedy one panel over:
// derive the value in the browser from the write's own response, apply it
// optimistically, let the refresh reconcile it.
//
// ⚠️ THE VALUE IS NOT DERIVED BY THE CLIENT — IT IS READ OFF THE SERVER'S OWN
// RECORD OF WHAT IT DID, AND THAT IS THE WHOLE REASON THIS IS SAFE.
// `ApprovalGateDTO.outcomeRef` is written as `effect.statusWritten`
// (`approvalGatesService.decide` step 6) — the status KEY the deciding
// transaction actually applied, written under the same lock, in the same write
// as the decision. So the caller does not re-implement "approving a design is
// terminal" in the browser and hope the two agree; it repeats a fact the server
// stated. Two consequences worth holding:
//
//   · A decision that moved NOTHING carries `outcomeRef: null` — the
//     `request_changes_moves_nothing`, `merge_writes_done` and
//     `no_status_in_target_category` arms all set `statusWritten: null`. So
//     "Request changes must not move the rail" is satisfied by there being
//     nothing to apply, not by a branch here that could drift from the handler.
//   · A kind whose terminal status is later re-decided needs no edit here. The
//     server says which key it wrote; this file has no opinion about it.
//
// ⚠️ AND THE REFRESH WINS. That is the reconciliation, and it is a DERIVATION
// rather than a race: the override is stored WITH the server status it was
// applied over (its `baseline`), and it is only honoured while the server still
// reads that baseline. The instant a server render arrives carrying anything
// else — the predicted value, or a value that DISAGREES with it — the override
// stops applying in the very same render. There is no window in which a stale
// optimistic value outlives the truth, and no branch deciding who wins.

interface StatusOverride {
  /** The status key the server RECORDED writing — what the rail should read. */
  readonly optimistic: string;
  /** The server status this override was applied OVER. While the server still
   *  reads this, no server render has landed yet and the override stands. */
  readonly baseline: string;
}

interface OptimisticStatusContextValue {
  /** The status the rail should DRAW: the override while it stands, else the
   *  server's own. */
  readonly status: string;
  /**
   * Record the status a mutation's response says the server wrote, so every
   * surface on this page can draw it before the server tree arrives.
   *
   * A `null` is the ordinary answer for a decision that moved nothing and is
   * NOT a rollback — it applies no override, which is exactly right: there is
   * no optimistic claim to make about a status nobody changed.
   */
  applyOptimisticStatus: (statusKey: string | null) => void;
  /**
   * Drop any standing override and fall back to the server's value.
   *
   * The refresh reconciles on its own (above), so this is for the case the
   * derivation cannot see: a caller that applied an override and then learned
   * its write did not stand.
   */
  clearOptimisticStatus: () => void;
}

const OptimisticStatusContext = createContext<OptimisticStatusContextValue | null>(null);

/**
 * Read the status the page should DRAW.
 *
 * ⚠️ IT TAKES THE SERVER'S VALUE AS AN ARGUMENT AND FALLS BACK TO IT, so a
 * surface rendered OUTSIDE the provider draws exactly what it drew before this
 * existed. That matters because `CoreFieldsPanel` has unit-test call sites and
 * peek/quick-view call sites that mount it without the page around it — none of
 * them should have to learn about a channel they do not use.
 */
export function useDisplayedStatus(serverStatus: string): string {
  const ctx = useContext(OptimisticStatusContext);
  return ctx ? ctx.status : serverStatus;
}

/**
 * The WRITE half — for the island that took the decision.
 *
 * Returns a no-op outside a provider, for the same reason as above: the frame
 * renders on the Workbench's Approvals tab too, where there is no status rail
 * to move and no provider to move it.
 */
export function useOptimisticStatusWriter(): Pick<
  OptimisticStatusContextValue,
  'applyOptimisticStatus' | 'clearOptimisticStatus'
> {
  const ctx = useContext(OptimisticStatusContext);
  return ctx ?? NO_PROVIDER;
}

const NO_PROVIDER = {
  applyOptimisticStatus: () => {},
  clearOptimisticStatus: () => {},
} as const;

export function OptimisticStatusProvider({
  serverStatus,
  children,
}: {
  /** The card's status as the CURRENT server render reads it. */
  serverStatus: string;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<StatusOverride | null>(null);

  // THE RECONCILE, as a derivation — see the header note. The override applies
  // only while the server still reads the value it was applied over.
  const superseded = override !== null && override.baseline !== serverStatus;

  // AND AS A LATCH, DURING RENDER RATHER THAN IN AN EFFECT. The derivation is
  // what makes the swap atomic; this is what makes it PERMANENT — without it a
  // card whose status later returned to the baseline value (reopened by hand,
  // moved back by a sibling) would resurrect an override a server render had
  // already answered.
  //
  // ⚠️ IT IS A RENDER-PHASE `setState` ON PURPOSE, and that is React's own
  // *adjusting state when a prop changes* pattern rather than a shortcut past
  // `react-hooks/set-state-in-effect`. Guarded by the condition it is a
  // no-op on every render but the one where the server value actually moved;
  // React re-runs this component immediately and commits only the second pass,
  // so no frame is ever painted from the superseded override. In an effect the
  // same repair costs a committed render showing a value the server has already
  // contradicted — which, on a page whose whole defect is a stale status, is
  // the one thing not to do.
  if (superseded) setOverride(null);

  const status = override !== null && !superseded ? override.optimistic : serverStatus;

  const applyOptimisticStatus = useCallback(
    (statusKey: string | null) => {
      if (statusKey === null) return;
      setOverride({ optimistic: statusKey, baseline: serverStatus });
    },
    [serverStatus],
  );

  const clearOptimisticStatus = useCallback(() => setOverride(null), []);

  return (
    <OptimisticStatusContext.Provider
      value={{ status, applyOptimisticStatus, clearOptimisticStatus }}
    >
      {children}
    </OptimisticStatusContext.Provider>
  );
}
