import type { SearchFilterEnvelope } from '../client.js';

// The `?filter=` ENCODER (Story 11.5 · Subtask 11.5.17 — MOTIR-2319).
//
// The MCP tool took the filter as a JSON argument, so the CLI never had to
// serialise one. `/api/v1` takes it as a query parameter — `?filter=v1:<…>` —
// the SAME carrier the product's own list views and saved filters use, which is
// what makes "the CLI and the web app cannot disagree about what is in a
// sprint" true rather than aspirational. So the encode has to exist here.
//
// ⚠️ This is the ONE piece of server-side logic this package reimplements, and
// that is a deliberate cost. `packages/cli` publishes to npm and cannot import
// the Next app; the alternative — a second endpoint taking the expanded JSON —
// would be a public API shape that exists only because one client could not
// encode, and it would give the CLI a filter grammar the web app does not
// share. The compact form is small and frozen: `lib/filters/ast.ts` documents it
// as the wire form, and a change to it is a `FILTER_PARAM_VERSION` bump, which
// the server reports as `UNSUPPORTED_FILTER_VERSION` rather than as a wrong
// answer. `test/filterParam.test.ts` pins this encoder against that decoder's
// documented shape.

/**
 * Base64URL, no padding — the alphabet the param uses so it needs no
 * percent-encoding inside a URL.
 *
 * `Buffer` rather than `btoa`: the JSON can carry any Unicode a title or label
 * contains, and `btoa` throws on anything outside Latin-1.
 */
function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * Encode a filter envelope into the `?filter=` parameter.
 *
 * The compact form is `{ c: combinator, f: [[field, operator, value], …] }` —
 * TUPLES, not objects, because this rides in shareable URLs. The envelope's own
 * `version` becomes the prefix rather than a constant pinned here: if a future
 * CLI is built against a newer grammar, the server must be able to say
 * `UNSUPPORTED_FILTER_VERSION` and send the user to upgrade. Overwriting the
 * version with whatever this file believes would turn that clean refusal into a
 * filter the server decodes under the wrong rules.
 */
export function encodeFilterParam(envelope: SearchFilterEnvelope): string {
  const compact = {
    c: envelope.combinator,
    f: envelope.conditions.map((row) => [row.field, row.operator, row.value]),
  };
  return `${envelope.version}:${toBase64Url(JSON.stringify(compact))}`;
}
