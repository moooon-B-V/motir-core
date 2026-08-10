import {
  PERMISSIONS,
  isPermissionKey,
  sortByCatalogOrder,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { LEGACY_SCOPE_PERMISSIONS, isLegacyTokenScope } from '@/lib/mcp/scopes';

// What an API token GRANTS (Story MOTIR-2572 · Subtask MOTIR-2574), decided in
// `docs/decisions/token-permissions.md`. Pure data + pure functions: no Prisma,
// no IO, no React, and every import is either a type or another leaf — so this
// module loads identically in a service, a client component and a bare test,
// the same property `lib/permissions/catalog.ts` holds.
//
// ⚠️ A GRANT NARROWS; IT DOES NOT REPLACE THE ROLE CHECK (ADR §4). An operation
// is permitted only when the owner's project role allows it AND the grant
// contains the operation's permission — `granted ∩ role`, exactly as
// `scope ∩ role` was. A token can grant LESS than its owner's access, never
// more, which is the sentence the Roles & permissions screen already promises.

/**
 * What a token may do: a set of permission keys from the catalog.
 *
 * NOT a per-resource access LEVEL. Motir's catalog is not uniform CRUD
 * (`work_item:triage`, `saved_filter:manage` and `ai:plan` are not read/write
 * pairs of anything), so a level selector would have to invent an ordering the
 * catalog does not carry — ADR §1.
 */
export type TokenGrant = readonly PermissionKey[];

/**
 * The permission the acceptance-video publish requires
 * (`lib/acceptanceEvidence/publishAuth.ts`) — the one token-reachable operation
 * that is neither MCP nor `/api/v1`. `acceptanceEvidenceService` resolves the
 * story and asserts `work_item:edit`, so the route asks for the same thing.
 *
 * Named here rather than inlined because it is a DERIVATION SOURCE for
 * {@link GRANTABLE_PERMISSIONS}: it is exactly the caller that is easy to miss,
 * and a grantable set that forgot it would silently stop being total.
 */
export const ACCEPTANCE_PUBLISH_PERMISSION: PermissionKey = 'work_item:edit';

/**
 * Permissions reachable ONLY through `/api/v1` — i.e. asserted by some v1
 * operation and by no MCP tool and not by the publish route.
 *
 * **Empty today, and that is a measured fact, not an assumption**: every one of
 * the 40 declarations names a key that {@link TOOL_PERMISSIONS} already carries.
 * It exists as the extension point so a future v1-only operation widens the
 * grantable set HERE, with a reason, instead of silently failing the derivation
 * guard — `tests/tokens/grant.test.ts` asserts the v1 declarations are a subset
 * of {@link GRANTABLE_PERMISSIONS} and will name the offender if one appears.
 *
 * `lib/api/v1/**` is deliberately NOT imported to compute this: those modules
 * pull in Zod and every request/response schema, and this module is consumed by
 * the create-token modal in the browser. The guard closes that seam at test
 * time; the import would open it at bundle time.
 */
export const V1_ONLY_PERMISSIONS: readonly PermissionKey[] = [];

/**
 * The permissions a token may be granted — DERIVED, never hand-listed.
 *
 * A permission is grantable **because a token-reachable operation asserts it**
 * (ADR §2): `lib/permissions/catalog.ts` opens by forbidding a key with no
 * operation behind it, and a picker switch that gates nothing is that same lie
 * one level up. So the set is computed from the three sources a token can
 * reach — the MCP tool map, the `/api/v1` declarations (via
 * {@link V1_ONLY_PERMISSIONS}, guarded), and the acceptance publish — and
 * returned in catalog order so every surface renders it the same way.
 *
 * `tests/tokens/grant.test.ts` proves the derivation in BOTH directions: no
 * grantable key without an operation, and no operation whose key is ungrantable.
 */
export const GRANTABLE_PERMISSIONS: readonly PermissionKey[] = sortByCatalogOrder([
  ...Object.values(TOOL_PERMISSIONS),
  ...V1_ONLY_PERMISSIONS,
  ACCEPTANCE_PUBLISH_PERMISSION,
]);

/**
 * The keys the catalog carries that a token can never exercise.
 *
 * Named so the picker's absence of them is a checked property rather than a
 * side effect, and so a reader can see at a glance that `board:configure` and
 * friends are missing on purpose.
 */
export const UNGRANTABLE_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.filter(
  (key) => !GRANTABLE_PERMISSIONS.includes(key),
);

/**
 * The IRREVERSIBLE keys — the ones a surface must set apart and the default
 * grant must withhold. `work_item:delete` cascades to the whole subtree
 * (`lib/mcp/tools/deleteWorkItem.ts`); nothing else a token can reach is
 * unrecoverable.
 */
export const IRREVERSIBLE_PERMISSIONS: readonly PermissionKey[] = ['work_item:delete'];

/** Whether an irreversible key is in the grant — the surfaces' danger flag. */
export function grantsIrreversible(grant: TokenGrant): boolean {
  return IRREVERSIBLE_PERMISSIONS.some((key) => grant.includes(key));
}

/**
 * The grant a token minted WITHOUT an explicit choice receives: every grantable
 * permission EXCEPT the irreversible ones (ADR §8) — the same "all but delete"
 * rule `DEFAULT_TOKEN_SCOPES` encoded, now derived rather than filtered by hand.
 */
export const DEFAULT_TOKEN_GRANT: readonly PermissionKey[] = GRANTABLE_PERMISSIONS.filter(
  (key) => !IRREVERSIBLE_PERMISSIONS.includes(key),
);

/** Whether `value` is a permission a token may actually be granted. */
export function isGrantable(value: unknown): value is PermissionKey {
  return isPermissionKey(value) && GRANTABLE_PERMISSIONS.includes(value);
}

/**
 * Whether `grant` admits an operation requiring `permission`.
 *
 * The whole decision, in one pure function, so the two dispatch seams and their
 * tests share it rather than each re-implementing membership.
 */
export function grantAllows(grant: TokenGrant, permission: PermissionKey): boolean {
  return grant.includes(permission);
}

/**
 * Expand ONE stored `api_token.scopes` value into the permissions it confers.
 *
 * Three arms, and the third is the one that matters (ADR §5):
 *   * a permission key passes through;
 *   * one of the six legacy `TokenScope` strings expands through
 *     {@link LEGACY_SCOPE_PERMISSIONS};
 *   * anything else yields NOTHING. A row we cannot interpret must degrade to
 *     LESS access, never to a default grant nobody chose — the two failure
 *     directions are not symmetric.
 */
function expandStoredValue(value: string): readonly PermissionKey[] {
  if (isGrantable(value)) return [value];
  if (isLegacyTokenScope(value)) return LEGACY_SCOPE_PERMISSIONS[value];
  return [];
}

/** One unrecognised stored value, as {@link expandStoredGrant} reports it. */
export interface UnrecognisedGrantValue {
  value: string;
}

/**
 * Resolve a stored `api_token.scopes` array into the {@link TokenGrant} it
 * confers — the ONE function every reader shares, so no caller can forget the
 * legacy expansion and read the raw column as if it were permissions.
 *
 * Returns the de-duplicated grant in catalog order, plus whatever it could not
 * interpret so the caller can log it. Nothing is rewritten: expansion happens on
 * READ, and no migration ever touches a live credential's row.
 */
export function expandStoredGrant(stored: readonly string[]): {
  grant: PermissionKey[];
  unrecognised: UnrecognisedGrantValue[];
} {
  const grant = new Set<PermissionKey>();
  const unrecognised: UnrecognisedGrantValue[] = [];
  for (const value of stored) {
    const expanded = expandStoredValue(value);
    if (expanded.length === 0) {
      unrecognised.push({ value });
      continue;
    }
    for (const key of expanded) grant.add(key);
  }
  return { grant: sortByCatalogOrder(grant), unrecognised };
}
