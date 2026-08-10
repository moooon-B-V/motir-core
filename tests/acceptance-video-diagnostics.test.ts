import { describe, expect, it } from 'vitest';
import {
  buildClientDiagnostics,
  DIAGNOSTIC_TAIL,
  isCancelledRscPrefetch,
  type DiagnosticEvent,
} from './e2e/_helpers/acceptance-diagnostics';

// ── The acceptance lane's failure report (MOTIR-2600) ────────────────────────
//
// The lane's failures are read from an artifact, not from a person's memory of a
// red run — that is the whole point of the card. So the artifact is a shipped
// surface with a contract, and this is its guard.
//
// The contract that matters is the VERDICT line: the same "element(s) not found"
// message is produced by three different faults, and the diagnostics exist to
// tell them apart. MOTIR-2506 shipped a 60 s budget on the reading that the page
// was merely slow; the trace of the recurrence (job 93452609448) showed the page
// was not painting at ANY number — the RSC payload returned in 7.5 ms and then
// nothing at all happened for 60 s. Getting that reading wrong cost a card.

/** A response event, `n` seconds into the recording. */
function response(t: number, text = '200 GET http://localhost:3200/planning'): DiagnosticEvent {
  return { t, kind: 'response', text };
}

/** A failed request, written the way `acceptance-video.ts`'s recorder writes it. */
function requestFailed(t: number, url: string, errorText: string): DiagnosticEvent {
  return { t, kind: 'requestfailed', text: `GET ${url} — ${errorText}` };
}

/** A `next/link` prefetch the browser cancelled — the MOTIR-2643 shape. */
function cancelledPrefetch(t: number, path: string, token = 'a1lfIFwHJR6paYKN'): DiagnosticEvent {
  return requestFailed(t, `http://localhost:3200${path}?_rsc=${token}`, 'net::ERR_ABORTED');
}

/**
 * The burst run 31427351588 (2026-08-10 20:05 UTC, shard 1/4) actually
 * recorded, replayed at its real timestamps: nine prefetches cancelled inside
 * 40 ms on an ordinary docs page, while the failure being diagnosed was a
 * Playwright strict-mode violation ~16 s later (MOTIR-2620).
 */
const CANCELLED_PREFETCH_BURST: DiagnosticEvent[] = [
  cancelledPrefetch(1.592, '/docs/mcp'),
  cancelledPrefetch(1.593, '/docs/cli'),
  cancelledPrefetch(1.595, '/docs/api'),
  cancelledPrefetch(1.595, '/docs/sandbox'),
  cancelledPrefetch(1.612, '/sign-up'),
  cancelledPrefetch(1.613, '/sign-in'),
  cancelledPrefetch(1.614, '/docs'),
  cancelledPrefetch(1.618, '/'),
  cancelledPrefetch(1.632, '/explore'),
];

const base = {
  card: 'MOTIR-2600',
  test: 'acceptance-contextual-plan-confirm.spec.ts › Discard declines the plan',
  status: 'failed',
  error: "expect(locator).toBeVisible() failed\nLocator: getByRole('complementary')",
  page: {},
  console: [],
  pageErrors: [],
  requests: [],
};

describe('buildClientDiagnostics — the verdict (MOTIR-2600)', () => {
  it('names a PAGE ERROR first — a thrown exception outranks every timing reading', () => {
    // If the client threw, the answer is in the message and nothing else needs
    // interpreting. This is the reading the lane could not reach at all before:
    // it kept no `pageerror` channel, so a crashed transition and a starved one
    // were indistinguishable.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400 },
      pageErrors: [
        { t: 12.1, kind: 'pageerror', text: 'ChunkLoadError: Loading chunk 0i_fqt failed.' },
      ],
      requests: [response(11.9)],
    });
    expect(report.verdict).toContain('The page threw');
    expect(report.verdict).toContain('ChunkLoadError');
  });

  it('names a FAILED REQUEST when nothing threw — a resource that never arrived', () => {
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 100 },
      requests: [
        response(11.9),
        {
          t: 12.0,
          kind: 'requestfailed',
          text: 'GET http://localhost:3200/_next/static/chunks/0i_fqt.js — net::ERR_CONNECTION_RESET',
        },
      ],
    });
    expect(report.verdict).toContain('1 request(s) failed');
    expect(report.verdict).toContain('ERR_CONNECTION_RESET');
  });

  it('calls a SILENT TAIL what it is — a dead transition, and NOT a slow page', () => {
    // The 2026-08-10 recurrence, reproduced from its own trace: every request
    // 200, the last one ~60 s before the assertion expired, no error anywhere.
    // The report must say "do not raise the timeout" in as many words, because
    // raising it is precisely what the previous two cards did.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400, resourceCount: 140 },
      requests: [response(11.9)],
    });
    expect(report.verdict).toContain('No request completed for 59s');
    expect(report.verdict).toContain('dead client transition or a starved renderer');
    expect(report.verdict).toContain('Do not raise the timeout');
  });

  it('does NOT cry stall when requests were still landing — then the page really is slow', () => {
    // The other direction, and the one that keeps the verdict honest: if work was
    // in flight when the assertion expired, the budget IS the right lever and the
    // report must not talk the reader out of it.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 240, resourceCount: 140 },
      requests: [response(59.8)],
    });
    expect(report.verdict).toContain('still arriving');
    expect(report.verdict).not.toContain('Do not raise the timeout');
  });

  it('abstains rather than guessing when the renderer could not be read', () => {
    // A crashed or closed page cannot answer `page.evaluate`, so there is no idle
    // measurement to reason from. Saying nothing is right; inventing a stall
    // would put a false cause in front of the next reader.
    const report = buildClientDiagnostics({
      ...base,
      page: { unavailable: 'Error: Target page, context or browser has been closed' },
      requests: [response(11.9)],
    });
    expect(report.verdict).not.toContain('No request completed');
    expect(report.page).toEqual({
      unavailable: 'Error: Target page, context or browser has been closed',
    });
  });

  it('carries the failing test, its error and the request ledger — the report is self-contained', () => {
    // A reader opening `client-diagnostics.json` out of a shard's artifact has no
    // other context: which of the four legs, which test, what failed.
    const requests = [response(1), response(2)];
    const report = buildClientDiagnostics({ ...base, requests });
    expect(report.card).toBe('MOTIR-2600');
    expect(report.test).toContain('Discard declines the plan');
    expect(report.status).toBe('failed');
    expect(report.error).toContain('toBeVisible');
    expect(report.requests).toEqual(requests);
  });

  it('treats a null error as null rather than dropping the key', () => {
    const report = buildClientDiagnostics({ ...base, error: undefined });
    expect(report).toHaveProperty('error', null);
  });
});

// ── Cancelled RSC prefetches are not failures (MOTIR-2643) ──────────────────
//
// `next/link` prefetches every visible link and the browser routinely cancels
// those requests. Each cancellation arrives as a `requestfailed`, so on the
// capture's FIRST live failure the failed-request rung fired on a healthy page
// and pre-empted the idle-renderer rung — the one rung that separates the two
// readings MOTIR-2621 exists to decide between. The tally is the judgement and
// had to be corrected; the ledger is the evidence and must not be.

describe('the verdict does not count cancelled RSC prefetches (MOTIR-2643)', () => {
  it('reads the real 2026-08-10 burst as an IDLE RENDERER, not as nine failed requests', () => {
    // Run 31427351588, shard 1/4, verbatim: nine aborted `_rsc` prefetches, no
    // page error, and a renderer that had been silent for ~59 s. The artifact
    // said "9 request(s) failed; last: GET …/explore?_rsc=… — net::ERR_ABORTED"
    // about a strict-mode locator violation with no network fault anywhere.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400, resourceCount: 140 },
      requests: [response(1.4), ...CANCELLED_PREFETCH_BURST],
    });

    expect(report.verdict).not.toContain('request(s) failed');
    expect(report.verdict).toContain('No request completed for 59s');
    expect(report.verdict).toContain('dead client transition or a starved renderer');
    expect(report.verdict).toContain('Do not raise the timeout');
  });

  it('keeps every cancelled prefetch in the LEDGER — the tally is judgement, the ledger is evidence', () => {
    const requests = [response(1.4), ...CANCELLED_PREFETCH_BURST];
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400 },
      requests,
    });

    expect(report.requests).toEqual(requests);
    expect(report.requests.filter((r) => r.kind === 'requestfailed')).toHaveLength(9);
  });

  it('still names a REAL failed resource — the filter must not swallow a genuine fault', () => {
    // The other side of the line, and the reason the filter is aborted-AND-`_rsc`
    // rather than aborted alone: a chunk that never arrived really is a better
    // explanation than an idle renderer, so the ladder's order stays as it is.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400 },
      requests: [
        response(11.9),
        requestFailed(
          12.0,
          'http://localhost:3200/_next/static/chunks/0i_fqt.js',
          'net::ERR_CONNECTION_RESET',
        ),
      ],
    });

    expect(report.verdict).toContain('1 request(s) failed');
    expect(report.verdict).toContain('ERR_CONNECTION_RESET');
  });

  it('reports the real failure — and a count that excludes the prefetches around it', () => {
    // The mixed case: the burst brackets a genuine fault. The verdict must name
    // the fault, and the number in front of it must be the number of faults.
    const report = buildClientDiagnostics({
      ...base,
      page: { sinceLastResourceMs: 59_400 },
      requests: [
        ...CANCELLED_PREFETCH_BURST,
        requestFailed(
          12.0,
          'http://localhost:3200/_next/static/chunks/0i_fqt.js',
          'net::ERR_CONNECTION_RESET',
        ),
        cancelledPrefetch(12.4, '/planning'),
      ],
    });

    expect(report.verdict).toContain('1 request(s) failed');
    expect(report.verdict).toContain('0i_fqt.js');
    expect(report.verdict).toContain('ERR_CONNECTION_RESET');
    expect(report.verdict).not.toContain('ERR_ABORTED');
  });

  it('holds the line at ABORTED-AND-RSC — neither half alone is enough', () => {
    // `net::ERR_ABORTED` is not synonymous with harmless (a real navigation torn
    // down mid-flight reports it), and an `_rsc` request that genuinely failed
    // is a real fault. Only the two together are the ordinary prefetch teardown.
    expect(isCancelledRscPrefetch(cancelledPrefetch(1.6, '/docs'))).toBe(true);
    expect(
      isCancelledRscPrefetch(
        requestFailed(1.6, 'http://localhost:3200/explore', 'net::ERR_ABORTED'),
      ),
    ).toBe(false);
    expect(
      isCancelledRscPrefetch(
        requestFailed(1.6, 'http://localhost:3200/explore?_rsc=abc', 'net::ERR_CONNECTION_RESET'),
      ),
    ).toBe(false);
    expect(isCancelledRscPrefetch(response(1.6))).toBe(false);
  });

  it('matches the marker as a QUERY PARAMETER, not as a substring of the path', () => {
    // A route whose own path happens to contain the four characters `_rsc` is a
    // real page, and a real failure on it is a real finding.
    expect(
      isCancelledRscPrefetch(
        requestFailed(1.6, 'http://localhost:3200/docs/_rsc-notes', 'net::ERR_ABORTED'),
      ),
    ).toBe(false);
    // …while the marker as the SECOND parameter is still a prefetch.
    expect(
      isCancelledRscPrefetch(
        requestFailed(1.6, 'http://localhost:3200/explore?tab=all&_rsc=abc', 'net::ERR_ABORTED'),
      ),
    ).toBe(true);
  });

  it('does not silently stop filtering if the recorder stops writing a separator', () => {
    // `splitFailure` treats a separator-less text as both halves, so a format
    // change makes this over-eager at worst — never inert, which is the failure
    // mode that produced this card.
    expect(
      isCancelledRscPrefetch({
        t: 1.6,
        kind: 'requestfailed',
        text: 'GET http://localhost:3200/explore?_rsc=abc net::ERR_ABORTED',
      }),
    ).toBe(true);
  });
});

describe('the diagnostic buffers are bounded (MOTIR-2600)', () => {
  it('caps the tail so one report cannot become the artifact', () => {
    // A 90 s acceptance test emits thousands of responses and the value is all in
    // the tail; an uncapped ledger would push a multi-megabyte JSON into every
    // shard's report artifact for no diagnostic gain.
    expect(DIAGNOSTIC_TAIL).toBeGreaterThan(0);
    expect(DIAGNOSTIC_TAIL).toBeLessThanOrEqual(500);
  });
});
