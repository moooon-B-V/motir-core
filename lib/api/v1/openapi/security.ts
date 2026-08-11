import { PERMISSION_CATALOG, type PermissionKey } from '@/lib/permissions/catalog';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';

// The v1 SECURITY SCHEME (Story 11.4 · Subtask 11.4.3 — MOTIR-2184; re-pointed
// onto the permission vocabulary by MOTIR-2577).
//
// ONE scheme, declared once and referenced by every operation: ADR §2 admits
// exactly `Authorization: Bearer motir_pat_…` and nothing else — no cookies, no
// session, no query parameter.
//
// ── Why the requirement is an EXTENSION, not an OAuth scope list ────────────
// OpenAPI carries a `scopes` map only on an `oauth2` scheme. Ours is
// `type: http, scheme: bearer`, which has no such field, so the per-operation
// requirement is emitted as the `x-motir-permission` extension (below) plus a
// sentence in the operation's description. That is the honest shape: inventing
// an `oauth2` scheme to get a scopes map would document a flow this API does not
// implement.
//
// ── The published meaning comes FROM the catalog ────────────────────────────
// There is no hand-written description table here any more. `V1_SCOPE_DESCRIPTIONS`
// was one, and a second hand-maintained copy of what a capability means is the
// drift this story exists to remove: the description a client reads on the
// reference page and the one a teammate reads on Roles & permissions are now the
// SAME i18n key, resolved from `PERMISSION_CATALOG`.

/** The name the emitted document registers the scheme under. */
export const V1_SECURITY_SCHEME_NAME = 'bearerPat';

/**
 * The extension key an operation carries its required permission on.
 *
 * An `x-` extension rather than a bare field: it is our own vocabulary, and a
 * generator that does not understand it must ignore it rather than fail.
 *
 * ⚠️ It REPLACES `x-motir-scope` with NO compatibility window
 * (`docs/decisions/token-permissions.md` §6). Emitting both would publish two
 * names for one requirement, one of which resolves to a scope the token screen
 * cannot grant — worse documented than emitting one. The only in-repo consumer
 * is `packages/cli/src/api/operations.ts`, which moves in the same story and
 * gains a drift check against this document.
 */
export const V1_PERMISSION_EXTENSION = 'x-motir-permission';

/** The OpenAPI security-scheme object for the bearer PAT. */
export const v1SecurityScheme = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'motir_pat_<secret>',
  description:
    'A Motir personal access token, sent as `Authorization: Bearer motir_pat_…`. Mint one in Settings → Account → Tokens. A token is BOUND to one workspace and GRANTS a set of permissions that NARROW — never widen — its owner’s role: an operation is permitted only when the owner’s role allows it AND the token’s grant contains the operation’s permission. The permission each operation requires is published on it as `x-motir-permission`, in the same `resource:action` vocabulary the Roles & permissions screen shows.',
} as const;

/**
 * The i18n key carrying what a permission MEANS, per permission — read from the
 * catalog rather than restated here, so the published meaning and the one on
 * the Roles & permissions screen cannot diverge.
 *
 * Typed over `PermissionKey`, so the vocabulary cannot gain a member without
 * gaining a published meaning; `tests/api/v1/openapi-shared-schemas.test.ts`
 * re-asserts the totality at runtime.
 */
export const V1_PERMISSION_DESCRIPTION_KEYS: Record<PermissionKey, string> = Object.fromEntries(
  Object.values(PERMISSION_CATALOG).map((d) => [d.key, d.descriptionKey]),
) as Record<PermissionKey, string>;

/**
 * The permissions `/api/v1` operations actually REQUIRE — DERIVED from the
 * declarations, never listed.
 *
 * It was a filter over the scope vocabulary; deriving it from the operations
 * themselves is strictly better, because "what does v1 expose?" is a property of
 * v1's operations and nothing else.
 */
export const V1_EXPOSED_PERMISSIONS: readonly PermissionKey[] = GRANTABLE_PERMISSIONS.filter(
  (key) => V1_OPERATIONS.some((operation) => operation.permission === key),
);

/**
 * The grantable permissions `/api/v1` deliberately does not expose.
 *
 * `work_item:delete` is the load-bearing member and the exclusion is ASSERTED
 * rather than assumed: ADR §3 leaves the irreversible cascade delete out of v1's
 * first cut, and `tests/helpers/v1RouteAudit.ts` fails any route that declares
 * it. Emitting it as a required permission would advertise an operation that
 * does not exist.
 *
 * ⚠️ It also excludes ARCHIVE from v1, which is new: archive and delete assert
 * ONE key (ADR §3), so v1's two archive operations declare `work_item:delete`
 * and the audit rule has to admit them by PATH. See that rule for the split.
 */
export const V1_UNEXPOSED_PERMISSIONS: readonly PermissionKey[] = GRANTABLE_PERMISSIONS.filter(
  (key) => !V1_EXPOSED_PERMISSIONS.includes(key),
);
