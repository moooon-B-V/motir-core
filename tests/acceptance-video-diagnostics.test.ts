import { describe, expect, it } from 'vitest';
import {
  buildClientDiagnostics,
  buildContentionReport,
  buildContentionSamples,
  describeContention,
  DIAGNOSTIC_TAIL,
  isCancelledRscPrefetch,
  LONG_TASK_MS,
  percentileMs,
  type ContentionDrain,
  type ContentionNavigationMark,
  type ContentionReading,
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

// ── The CONTENTION sidecar (MOTIR-2646) ──────────────────────────────────────
//
// The report above fires on a red run. This one fires always, and it exists
// because the stall it characterises happens on ~1 run in 30 — a base rate that
// makes the event itself unmeasurable and forces the measurement onto the
// CONDITION instead. These are the shaping helpers that turn what the page
// hands back into that distribution; they are the whole instrument, so they are
// tested at the same altitude as the verdict is.

/** A reading with the fields a test does not care about already filled in. */
function reading(patch: Partial<ContentionReading> = {}): ContentionReading {
  return {
    timeOrigin: 1_000,
    nowMs: 10_000,
    navigations: [],
    longTasks: [],
    resourceEndsMs: [],
    resourceBufferFull: false,
    ...patch,
  };
}

function navigation(
  atMs: number,
  url = '/docs/mcp',
  kind: 'document' | 'soft' = 'soft',
): ContentionNavigationMark {
  return { atMs, url, kind };
}

function drain(patch: Partial<ContentionDrain> = {}): ContentionDrain {
  return {
    at: '2026-08-11T12:00:00.000Z',
    tSeconds: 1,
    latencyMs: 3,
    timedOut: false,
    ...patch,
  };
}

describe('percentileMs — nearest rank (MOTIR-2646)', () => {
  it('reports zero for an empty signal rather than a null the sidecar would carry', () => {
    expect(percentileMs([], 0.5)).toBe(0);
    expect(percentileMs([], 0.9)).toBe(0);
  });

  it('takes a real sample, never an interpolated one', () => {
    // Interpolation would answer 25 for the median here — a value no navigation
    // produced. At ~20 samples per recording that invention is most of the answer.
    expect(percentileMs([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentileMs([10, 20, 30, 40], 0.9)).toBe(40);
  });

  it('sorts before ranking — the caller hands over samples in navigation order', () => {
    expect(percentileMs([40, 10, 30, 20], 0.5)).toBe(20);
  });

  it('clamps both ends: fraction 0 is the floor, fraction 1 is the max', () => {
    expect(percentileMs([5, 9, 11], 0)).toBe(5);
    expect(percentileMs([5, 9, 11], 1)).toBe(11);
  });

  it('answers a single sample with that sample', () => {
    expect(percentileMs([46_228], 0.5)).toBe(46_228);
  });
});

describe('describeContention (MOTIR-2646)', () => {
  it('summarises one signal as median / p90 / max over its count', () => {
    expect(describeContention([100, 200, 300, 4_000])).toEqual({
      count: 4,
      medianMs: 200,
      p90Ms: 4_000,
      maxMs: 4_000,
    });
  });

  it('reports zeroes for a signal nothing contributed to', () => {
    // A recording that never navigated still writes a well-formed summary; the
    // reader distinguishes "quiet" from "absent" by `count`, not by a null.
    expect(describeContention([])).toEqual({ count: 0, medianMs: 0, p90Ms: 0, maxMs: 0 });
  });
});

describe('buildContentionSamples — one sample per navigation (MOTIR-2646)', () => {
  it('closes each window at the NEXT navigation, and the last one at the read', () => {
    const samples = buildContentionSamples(
      reading({ navigations: [navigation(1_000), navigation(3_000)], nowMs: 9_000 }),
    );
    expect(samples.map((sample) => sample.windowMs)).toEqual([2_000, 6_000]);
    expect(samples.map((sample) => sample.atMs)).toEqual([1_000, 3_000]);
  });

  it('reads the mcp-docs shape: payload in, then nothing, for the whole window', () => {
    // The capture that closed MOTIR-2621 said `sinceLastResourceMs: 46228`. This
    // is that number, computed for a navigation that PASSED — which is the entire
    // point: the same quantity, read continuously instead of once.
    const [sample] = buildContentionSamples(
      reading({
        navigations: [navigation(7_400, '/docs/mcp')],
        resourceEndsMs: [7_421],
        nowMs: 53_649,
      }),
    );
    expect(sample?.idleGapMs).toBe(46_228);
  });

  it('measures the longest gap BETWEEN completions, not only the trailing one', () => {
    const [sample] = buildContentionSamples(
      reading({ navigations: [navigation(0)], resourceEndsMs: [100, 8_000, 8_100], nowMs: 8_500 }),
    );
    expect(sample?.idleGapMs).toBe(7_900);
  });

  it('ignores completions from OUTSIDE the window on either side', () => {
    // The first window is [1000, 2000): the completions at 10 and 500 belong to
    // whatever came before it, and the one at 5000 belongs to the window AFTER
    // it — so its gap is 1400→2000, not 1400→5000. Getting this wrong in the
    // other direction is how a busy run would read as a quiet one.
    const samples = buildContentionSamples(
      reading({
        navigations: [navigation(1_000), navigation(2_000)],
        resourceEndsMs: [10, 500, 1_400, 5_000],
        nowMs: 6_000,
      }),
    );
    expect(samples[0]?.idleGapMs).toBe(600);
    expect(samples[1]?.idleGapMs).toBe(3_000);
  });

  it('sorts marks and completions the page handed over in whatever order', () => {
    const samples = buildContentionSamples(
      reading({
        navigations: [navigation(3_000), navigation(1_000)],
        resourceEndsMs: [2_800, 1_100],
        nowMs: 4_000,
      }),
    );
    expect(samples.map((sample) => sample.atMs)).toEqual([1_000, 3_000]);
    expect(samples[0]?.idleGapMs).toBe(1_700);
  });

  it('windows the long tasks, and charges only the blocking part of each', () => {
    // The Long Tasks API's own definition: a task blocks for what it costs ABOVE
    // the 50 ms threshold. 220 → 170, 90 → 40; the third task is the next
    // window's.
    const samples = buildContentionSamples(
      reading({
        navigations: [navigation(0), navigation(1_000)],
        longTasks: [
          { atMs: 100, durationMs: 220 },
          { atMs: 500, durationMs: 90 },
          { atMs: 1_500, durationMs: 60 },
        ],
        nowMs: 2_000,
      }),
    );
    expect(samples[0]).toMatchObject({ longestTaskMs: 220, blockingMs: 210, longTaskCount: 2 });
    expect(samples[1]).toMatchObject({ longestTaskMs: 60, blockingMs: 10, longTaskCount: 1 });
  });

  it('reports zero CPU rather than a hole when the browser gives no long tasks', () => {
    // `longtask` is Chromium-only and the observer is wrapped in a try/catch, so
    // an empty task list is a supported outcome and not a bug to signal.
    const [sample] = buildContentionSamples(reading({ navigations: [navigation(0)] }));
    expect(sample).toMatchObject({ longestTaskMs: 0, blockingMs: 0, longTaskCount: 0 });
  });

  it('carries the truncation flag onto every sample the document produced', () => {
    // Once the resource-timing buffer fills, the browser stops recording — so a
    // gap measured after that point is an artefact of the buffer, not of the
    // runner. The reader has to be able to see that.
    const samples = buildContentionSamples(
      reading({ navigations: [navigation(0), navigation(10)], resourceBufferFull: true }),
    );
    expect(samples.every((sample) => sample.resourcesTruncated)).toBe(true);
  });

  it('keeps the url and the navigation KIND — a soft transition is the suspect one', () => {
    const samples = buildContentionSamples(
      reading({
        navigations: [navigation(0, '/', 'document'), navigation(500, '/docs/mcp/tools', 'soft')],
      }),
    );
    expect(samples.map((sample) => [sample.kind, sample.url])).toEqual([
      ['document', '/'],
      ['soft', '/docs/mcp/tools'],
    ]);
  });

  it('does not go negative when the read raced ahead of the last mark', () => {
    const [sample] = buildContentionSamples(
      reading({ navigations: [navigation(9_000)], nowMs: 8_000 }),
    );
    expect(sample?.windowMs).toBe(0);
    expect(sample?.idleGapMs).toBe(0);
  });

  it('contributes nothing for a document that never navigated', () => {
    expect(buildContentionSamples(reading())).toEqual([]);
  });
});

describe('buildContentionReport — the sidecar (MOTIR-2646)', () => {
  it('orders documents by their time origin, so a hard navigation does not shuffle the run', () => {
    // One reading per DOCUMENT, keyed by `performance.timeOrigin`: a sign-in
    // reload starts a new origin whose page clock restarts at ~0, so the origin
    // is the only thing that orders them.
    const report = buildContentionReport({
      test: 'acceptance-mcp-docs.spec.ts › the MCP docs',
      status: 'passed',
      readings: [
        reading({ timeOrigin: 2_000, navigations: [navigation(10, '/second')], nowMs: 20 }),
        reading({ timeOrigin: 1_000, navigations: [navigation(10, '/first')], nowMs: 20 }),
      ],
      drains: [],
    });
    expect(report.samples.map((sample) => sample.url)).toEqual(['/first', '/second']);
    expect(report.navigations).toBe(2);
  });

  it('names the WORST navigation — the run’s closest approach to the stall', () => {
    const report = buildContentionReport({
      test: 'spec',
      status: 'passed',
      readings: [
        reading({
          navigations: [navigation(0, '/quiet'), navigation(1_000, '/slow')],
          resourceEndsMs: [900],
          nowMs: 40_000,
        }),
      ],
      drains: [],
    });
    expect(report.worst?.url).toBe('/slow');
    expect(report.idleGap.maxMs).toBe(39_000);
  });

  it('summarises drain latency over the drains that ANSWERED, and counts the rest', () => {
    // A probe that never came back is not a missing sample — it is the strongest
    // reading the instrument can take, so it is counted rather than averaged in.
    const report = buildContentionReport({
      test: 'spec',
      status: 'passed',
      readings: [],
      drains: [
        drain({ latencyMs: 2 }),
        drain({ latencyMs: 40 }),
        drain({ latencyMs: 2_001, timedOut: true }),
      ],
    });
    expect(report.drainLatency).toEqual({ count: 2, medianMs: 2, p90Ms: 40, maxMs: 40 });
    expect(report.unresponsiveDrains).toBe(1);
    expect(report.drains).toHaveLength(3);
  });

  it('stamps itself with the card and the test, and survives a recording with nothing in it', () => {
    const report = buildContentionReport({
      test: 'spec › nothing happened',
      status: 'passed',
      readings: [],
      drains: [],
    });
    expect(report).toMatchObject({
      card: 'MOTIR-2646',
      test: 'spec › nothing happened',
      status: 'passed',
      navigations: 0,
      unresponsiveDrains: 0,
      worst: null,
    });
  });
});

describe('the long-task threshold is the API’s own (MOTIR-2646)', () => {
  it('stays at 50 ms — the value the browser reports against', () => {
    // Not a tuning knob: the browser decides what to emit, and blocking time is
    // defined against the same number. Moving it here would silently redefine
    // `blockingMs` into something no other tool computes.
    expect(LONG_TASK_MS).toBe(50);
  });
});
