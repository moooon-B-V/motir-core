import { TOKEN_SCOPES, type TokenScope } from '@/lib/mcp/scopes';

// The v1 SECURITY SCHEME (Story 11.4 · Subtask 11.4.3 — MOTIR-2184).
//
// ONE scheme, declared once and referenced by every operation: ADR §2 admits
// exactly `Authorization: Bearer motir_pat_…` and nothing else — no cookies, no
// session, no query parameter.
//
// ── Why the scopes live here as DESCRIPTIONS, not as an OAuth scope list ─────
// OpenAPI carries a `scopes` map only on an `oauth2` scheme. Ours is
// `type: http, scheme: bearer`, which has no such field, so the per-operation
// requirement is emitted as the `x-motir-scope` extension (below) plus a
// sentence in the operation's description. That is the honest shape: inventing
// an `oauth2` scheme to get a scopes map would document a flow this API does not
// implement.
//
// ── The totality guarantee ──────────────────────────────────────────────────
// `V1_SCOPE_DESCRIPTIONS` is typed `Record<TokenScope, string>`, so a scope added
// to `TOKEN_SCOPES` without a description is a COMPILE error — the same shape
// `TOOL_SCOPES: Record<McpToolName, TokenScope>` uses in `lib/mcp/scopes.ts`, and
// `tests/api/v1/openapi-shared-schemas.test.ts` re-asserts it at runtime in the
// form `tests/mcp/scopes.test.ts` already uses.

/** The name the emitted document registers the scheme under. */
export const V1_SECURITY_SCHEME_NAME = 'bearerPat';

/**
 * The extension key an operation carries its required scope on.
 *
 * An `x-` extension rather than a bare field: it is our own vocabulary, and a
 * generator that does not understand it must ignore it rather than fail.
 */
export const V1_SCOPE_EXTENSION = 'x-motir-scope';

/** The OpenAPI security-scheme object for the bearer PAT. */
export const v1SecurityScheme = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'motir_pat_<secret>',
  description:
    'A Motir personal access token, sent as `Authorization: Bearer motir_pat_…`. Mint one in Settings → API tokens. A token is BOUND to one workspace and carries a set of scopes that NARROW — never widen — its owner’s role: an operation is permitted only when the owner’s role allows it AND the token carries the operation’s scope.',
} as const;

/**
 * What each scope permits. Typed over `TokenScope`, so the vocabulary cannot
 * gain a member without gaining a published meaning.
 */
export const V1_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  read: 'Read-only access — reads, lists, searches and identity. Never mutates.',
  'work_items:write':
    'Create and update work items, move them through the workflow, comment on them and link them.',
  'work_items:archive': 'Archive and restore a work item — a recoverable soft-remove.',
  'work_items:delete':
    'Irreversible subtree delete. NOT exposed by any `/api/v1` operation; listed because it is a token scope a caller may hold, and a scope this API silently ignored would be worse documented than one it names.',
  'sprints:write': 'Create and update sprints, run their lifecycle, and change their membership.',
  integration:
    'External-agent integration writes — marking work integrated and completing an agent session.',
};

/**
 * The scopes `/api/v1` operations actually REQUIRE.
 *
 * `work_items:delete` is excluded deliberately, and the exclusion is asserted
 * rather than assumed: ADR §3 leaves the irreversible cascade delete out of v1's
 * first cut, and `tests/helpers/v1RouteAudit.ts` already fails any route that
 * declares it (`declares-delete-scope`). Emitting it as a required scope would
 * advertise an operation that does not exist.
 */
export const V1_EXPOSED_SCOPES: readonly TokenScope[] = TOKEN_SCOPES.filter(
  (scope) => scope !== 'work_items:delete',
);

/** The scope `/api/v1` deliberately does not expose. */
export const V1_UNEXPOSED_SCOPES: readonly TokenScope[] = ['work_items:delete'];
