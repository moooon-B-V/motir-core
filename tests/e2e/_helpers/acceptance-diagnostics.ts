// The MOTIR-2600 failure report — the PURE half of the acceptance lane's
// client diagnostics, in its own module so it can be unit-tested.
//
// It is separate from `acceptance-video.ts` for one reason: that file imports
// `@playwright/test` to extend the fixture set, and a vitest suite cannot pull
// the Playwright runner into its own process. The artifact this lane leaves
// behind on a red run IS the deliverable of MOTIR-2600's first half, so its
// shape needs a guard like any other shipped surface — see
// `tests/acceptance-video-diagnostics.test.ts`. The fixture that FEEDS it
// (the page listeners, the renderer read, the attachment) lives next door.

/**
 * How many of each kind of client event the failure buffer keeps (most recent
 * wins). A cap rather than the full stream: a 90 s acceptance test can emit
 * thousands of responses, and the diagnostic value is entirely in the tail
 * around the failure.
 */
export const DIAGNOSTIC_TAIL = 200;

/** One page-side event the failure report replays. */
export interface DiagnosticEvent {
  /** Seconds since the test's page was created — the video's own clock. */
  t: number;
  kind: 'console' | 'pageerror' | 'response' | 'requestfailed';
  text: string;
}

export interface ClientDiagnostics {
  card: string;
  test: string;
  status: string;
  error: string | null;
  /** What the renderer said about itself at the moment of failure. */
  page: Record<string, unknown>;
  console: DiagnosticEvent[];
  pageErrors: DiagnosticEvent[];
  /** The request ledger's TAIL — the last {@link DIAGNOSTIC_TAIL} responses and
   *  every failed request, in the order the page saw them. */
  requests: DiagnosticEvent[];
  /** The one-line reading a person should start from. */
  verdict: string;
}

/** What the recorder puts between a request's target and why it failed. */
const FAILURE_SEPARATOR = ' — ';

/** The error text the browser reports for a request it tore down itself. */
const CANCELLED = 'net::ERR_ABORTED';

/** An RSC payload request — what `next/link` prefetching actually asks for. */
const RSC_PAYLOAD = /[?&]_rsc=/;

/**
 * Split a `requestfailed` event's text back into what was requested and why it
 * failed. The recorder writes `METHOD URL — errorText`
 * (`acceptance-video.ts`); a text with no separator is treated as BOTH halves
 * so the caller's checks still see it — a format change makes the filter below
 * over-eager at worst, never silently inert.
 */
function splitFailure(text: string): { target: string; failure: string } {
  const at = text.lastIndexOf(FAILURE_SEPARATOR);
  return at === -1
    ? { target: text, failure: text }
    : { target: text.slice(0, at), failure: text.slice(at + FAILURE_SEPARATOR.length) };
}

/**
 * A cancelled RSC prefetch — ordinary page behaviour wearing a failure's
 * clothes (MOTIR-2643).
 *
 * `next/link` prefetches every link it can see and the browser routinely
 * cancels those requests, which Playwright reports as `requestfailed` with
 * `net::ERR_ABORTED`. On the capture's first live failure that produced NINE of
 * them in a 40 ms burst at t≈1.6 s, on a healthy docs page — enough for the
 * failed-request rung to pre-empt the idle-renderer rung and announce a network
 * cause for a strict-mode locator violation.
 *
 * So they are excluded from the TALLY that picks the verdict, and left in the
 * `requests` ledger untouched: the ledger is evidence, the tally is judgement.
 * The filter is deliberately narrow — aborted AND carrying an `_rsc` marker —
 * because `net::ERR_ABORTED` alone is not synonymous with harmless (a real
 * navigation torn down mid-flight reports it too).
 */
export function isCancelledRscPrefetch(event: DiagnosticEvent): boolean {
  if (event.kind !== 'requestfailed') return false;
  const { target, failure } = splitFailure(event.text);
  return failure.includes(CANCELLED) && RSC_PAYLOAD.test(target);
}

/**
 * Turn the captured buffers into the report that gets attached (MOTIR-2600).
 *
 * Pure, and exported, so the shape a failing lane leaves behind is asserted by
 * `tests/acceptance-video-diagnostics.test.ts` rather than only by staring at a
 * red run — the artifact IS the deliverable of this card's first half, so it
 * needs a guard like any other.
 *
 * The `verdict` line is the point. Three readings are separable from what is
 * captured, and naming which one the evidence supports is what stops the next
 * occurrence being re-derived from scratch:
 *   * a page error or a failed request in the tail → the client threw / a
 *     resource never arrived; the message names it. Cancelled RSC prefetches
 *     do NOT count as failures here — see {@link isCancelledRscPrefetch}.
 *   * no error, and the last response landed LONG before the failure → nothing
 *     was in flight: the transition is dead or the renderer was starved. This is
 *     the shape the 2026-08-10 recurrence had.
 *   * no error, and requests were still arriving → the page genuinely is slow,
 *     and the budget is the right lever after all.
 */
export function buildClientDiagnostics(input: {
  card: string;
  test: string;
  status: string;
  error?: string | null;
  page: Record<string, unknown>;
  console: DiagnosticEvent[];
  pageErrors: DiagnosticEvent[];
  requests: DiagnosticEvent[];
}): ClientDiagnostics {
  // The tally, not the ledger: a cancelled RSC prefetch stays in `requests`
  // below and is kept out of the count that chooses the verdict (MOTIR-2643).
  const failedRequests = input.requests.filter(
    (r) => r.kind === 'requestfailed' && !isCancelledRscPrefetch(r),
  );
  const idleMs = input.page['sinceLastResourceMs'];
  const verdict =
    input.pageErrors.length > 0
      ? `The page threw: ${input.pageErrors[input.pageErrors.length - 1]?.text ?? ''}`
      : failedRequests.length > 0
        ? `${failedRequests.length} request(s) failed; last: ${failedRequests[failedRequests.length - 1]?.text ?? ''}`
        : typeof idleMs === 'number' && idleMs >= 5_000
          ? `No request completed for ${Math.round(idleMs / 1000)}s before the failure — nothing was in ` +
            'flight, so this is a dead client transition or a starved renderer, NOT a slow page. ' +
            'Do not raise the timeout (MOTIR-2600).'
          : 'Requests were still arriving when the assertion expired — the page was doing work.';
  return {
    card: 'MOTIR-2600',
    test: input.test,
    status: input.status,
    error: input.error ?? null,
    page: input.page,
    console: input.console,
    pageErrors: input.pageErrors,
    requests: input.requests,
    verdict,
  };
}
