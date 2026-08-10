import { describe, expect, it } from 'vitest';
import {
  buildClientDiagnostics,
  DIAGNOSTIC_TAIL,
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

describe('buildClientDiagnostics — the verdict (MOTIR-2600)', () => {
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

describe('the diagnostic buffers are bounded (MOTIR-2600)', () => {
  it('caps the tail so one report cannot become the artifact', () => {
    // A 90 s acceptance test emits thousands of responses and the value is all in
    // the tail; an uncapped ledger would push a multi-megabyte JSON into every
    // shard's report artifact for no diagnostic gain.
    expect(DIAGNOSTIC_TAIL).toBeGreaterThan(0);
    expect(DIAGNOSTIC_TAIL).toBeLessThanOrEqual(500);
  });
});
