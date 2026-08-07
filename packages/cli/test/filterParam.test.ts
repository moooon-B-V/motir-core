import { describe, expect, it } from 'vitest';
import { encodeFilterParam } from '../src/adapters/filterParam.js';
import { inFlightFilter, sprintFilter, FILTER_VERSION } from '../src/render.js';
import type { SearchFilterEnvelope } from '../src/client.js';

// The `?filter=` encoder (Story 11.5 · Subtask 11.5.17 — MOTIR-2319).
//
// ⚠️ This is the ONE place the CLI reimplements a server-side codec, so it is
// the one place a silent divergence is possible: the server's `decodeFilterParam`
// lives in `lib/filters/ast.ts`, which this package cannot import. So the tests
// below DECODE the output by hand — version prefix, base64url, compact tuple
// form — rather than round-tripping through the encoder's own inverse, which
// would agree with any mistake it made.
//
// The end-to-end proof that a real route accepts what this produces is
// `tests/cli/cli-story.test.ts`, which drives the built binary against the real
// `/api/v1` handlers and asserts `motir sprint` returns the sprint's items.

/** Peel the param apart the way the server's decoder does. */
function decode(param: string): { version: string; compact: unknown } {
  const sep = param.indexOf(':');
  expect(sep).toBeGreaterThan(0);
  const version = param.slice(0, sep);
  const json = Buffer.from(param.slice(sep + 1), 'base64url').toString('utf8');
  return { version, compact: JSON.parse(json) };
}

describe('encodeFilterParam', () => {
  it('emits `<version>:<base64url>` of the compact TUPLE form', () => {
    const envelope: SearchFilterEnvelope = {
      version: 'v1',
      combinator: 'and',
      conditions: [
        { field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] },
        { field: 'kind', operator: 'is', value: 'subtask' },
      ],
    };

    const { version, compact } = decode(encodeFilterParam(envelope));

    expect(version).toBe('v1');
    // Tuples, not objects — the form `lib/filters/ast.ts` documents, chosen to
    // keep a shared URL short. An object-per-condition encoding decodes to
    // "not an array" and the whole filter is refused as invalid.
    expect(compact).toEqual({
      c: 'and',
      f: [
        ['status', 'is_any_of', ['todo', 'in_progress']],
        ['kind', 'is', 'subtask'],
      ],
    });
  });

  it('carries the combinator, and an empty condition list, verbatim', () => {
    const { compact } = decode(
      encodeFilterParam({ version: 'v1', combinator: 'or', conditions: [] }),
    );
    expect(compact).toEqual({ c: 'or', f: [] });
  });

  it('uses base64URL — never a `+`, `/` or `=` that a URL would have to escape', () => {
    // A payload chosen to land `+` and `/` in standard base64: without the
    // url-safe alphabet the param needs percent-encoding, and a server reading
    // it raw sees a different string than the one that was sent.
    const param = encodeFilterParam({
      version: 'v1',
      combinator: 'and',
      conditions: [{ field: 'title', operator: 'contains', value: '??ÿ>>>???' }],
    });
    expect(param.slice(param.indexOf(':') + 1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('survives non-Latin-1 text — a title in Chinese is not a crash', () => {
    // `btoa` throws on anything outside Latin-1, which would take down `motir
    // sprint` for a tenant whose filters name a non-ASCII value.
    const { compact } = decode(
      encodeFilterParam({
        version: 'v1',
        combinator: 'and',
        conditions: [{ field: 'title', operator: 'contains', value: '规划' }],
      }),
    );
    expect(compact).toEqual({ c: 'and', f: [['title', 'contains', '规划']] });
  });

  it('sends the ENVELOPE’s version, not a constant of its own', () => {
    // A CLI built against a newer grammar must let the server refuse with
    // `UNSUPPORTED_FILTER_VERSION` and send the user to upgrade. Overwriting the
    // prefix would have the server decode a newer filter under older rules —
    // a wrong answer instead of a clean refusal.
    const { version } = decode(
      encodeFilterParam({ version: 'v9', combinator: 'and', conditions: [] }),
    );
    expect(version).toBe('v9');
  });

  it('encodes the two envelopes the CLI actually builds', () => {
    // The builders live in `render.ts` and are untouched by the port: what
    // changed is only how their output reaches the server.
    expect(decode(encodeFilterParam(inFlightFilter())).version).toBe(FILTER_VERSION);
    expect(decode(encodeFilterParam(sprintFilter('sprint-1', ['subtask']))).compact).toEqual({
      c: 'and',
      f: [
        ['sprint', 'is_any_of', ['sprint-1']],
        ['kind', 'is_any_of', ['subtask']],
      ],
    });
  });
});
