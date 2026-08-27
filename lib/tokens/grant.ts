import {
  PERMISSIONS,
  isPermissionKey,
  sortByCatalogOrder,
  withImpliedPermissions,
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
 * The permission the DESIGN-RESULT publish requires
 * (`lib/designEvidence/publishAuth.ts`, Story MOTIR-2664) — the SECOND
 * token-reachable operation that is neither MCP nor `/api/v1`.
 * `designEvidenceService` resolves the target leaf and asserts `work_item:edit`,
 * so the route asks for the same thing, exactly as the acceptance publish does.
 *
 * It happens to equal {@link ACCEPTANCE_PUBLISH_PERMISSION} today, and is named
 * separately anyway for the reason that constant gives for existing at all: it
 * is a DERIVATION SOURCE for {@link GRANTABLE_PERMISSIONS}, and the set stays
 * total only if every such caller is named here. Aliasing the two would make the
 * next publisher's permission look already-covered when it may not be.
 */
export const DESIGN_PUBLISH_PERMISSION: PermissionKey = 'work_item:edit';

/**
 * Permissions reachable ONLY through `/api/v1` — i.e. asserted by some v1
 * operation and by no MCP tool and not by the publish route.
 *
 * **No longer empty (MOTIR-3188), and the extension point worked exactly as it
 * was built to.** It held zero entries for as long as every v1 declaration named
 * a key {@link TOOL_PERMISSIONS} already carried. `ai:decide_plan` is the first
 * key that does not: it gates `approvePlan` / `declinePlan`, neither of which is
 * an MCP tool, and `POST /api/v1/work-items/{key}/plan-approval` (MOTIR-3021 —
 * the bounded entrance `motir auto --auto-approve-replan` drives) is the ONE
 * operation any token can reach it through.
 *
 * ⚠️ ITS ABSENCE WOULD HAVE FAILED LOUDLY, WHICH IS THE POINT — the guard in
 * `tests/tokens/grant.test.ts` asserts the v1 declarations are a subset of
 * {@link GRANTABLE_PERMISSIONS} and names the offender. The two cards' own
 * records predicted this exact pairing before either merged
 * (`docs/decisions/agent-authored-plans.md` AMENDMENT 5): whichever landed
 * second owed the route AND this entry, and doing one without the other is a red
 * build rather than a silently unusable operation.
 *
 * `declinePlan` gains nothing from this. It has no v1 entrance and no tool, so
 * the key is grantable because of approval alone.
 *
 * `lib/api/v1/**` is deliberately NOT imported to compute this: those modules
 * pull in Zod and every request/response schema, and this module is consumed by
 * the create-token modal in the browser. The guard closes that seam at test
 * time; the import would open it at bundle time.
 */
export const V1_ONLY_PERMISSIONS: readonly PermissionKey[] = ['ai:decide_plan'];

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
  DESIGN_PUBLISH_PERMISSION,
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
 *
 * ⚠️ `work_item:archive` IS NOT ONE, AND THAT UNDOES A NARROWING (MOTIR-3629).
 * ADR §8 recorded that {@link DEFAULT_TOKEN_GRANT} had stopped conferring archive
 * — not because anyone chose to withhold a recoverable operation, but because
 * archive and delete shared one key and "all but the irreversible one"
 * necessarily withheld both. With the key split, archive is grantable and
 * reversible, so it falls into the default grant by the SAME derivation that had
 * excluded it, with no arm added here. A token minted with the default grant can
 * archive again and still cannot delete — which is what §8 said it wanted and
 * could not have.
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

/**
 * The permissions THIS actor may confer on a token bound to THIS project
 * (MOTIR-2606; `docs/decisions/token-permissions.md` Amendment 1 §A.4).
 *
 * `held` is what `projectAccessService.getPermissions` resolved for the actor in
 * the bound project. Intersecting it with {@link GRANTABLE_PERMISSIONS} is the
 * whole rule — *you can grant less than your own access, never more* — expressed
 * once, so the picker's OFFER and `create`'s VALIDATION cannot disagree. Two
 * implementations of this would agree the day they were written and drift the
 * first time an access level changed, and the drift would be invisible: an offer
 * the create call rejects, or worse, one it should have.
 *
 * ⚠️ ONE ARM, deliberately. A union-across-the-workspace arm was considered and
 * is dead: the only tokens without a project are the ones whose grant is FIXED
 * (`CLI_TOKEN_GRANT`, which the approval screen shows and cannot edit), and a
 * fixed grant is never chosen from an offer. Amendment 1 §A.4 records why, so a
 * reader does not re-derive it as a missing case.
 *
 * Returns catalog order, so every surface renders the same sequence.
 */
export function grantableFor(held: ReadonlySet<PermissionKey>): PermissionKey[] {
  return GRANTABLE_PERMISSIONS.filter((key) => held.has(key));
}

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
  // The IMPLICATIONS, applied to the whole grant rather than per stored value
  // (MOTIR-3629) — so a row carrying `work_item:delete` confers
  // `work_item:archive` too, and no token minted before the archive key existed
  // lost an operation on the day it shipped. This is the token half of the
  // back-compatibility decision (`docs/decisions/token-permissions.md` §10); the
  // role half is `resolvePermissions`. It runs here, inside the ONE reader of the
  // column, so the grant a surface DISPLAYS and the grant a gate CHECKS are the
  // same set — an implied key that only the gate could see would put the token
  // list in the position of describing a credential it cannot describe.
  //
  // Nothing is rewritten, exactly as before: the expansion is on READ, and no
  // migration touches a live credential's row.
  return { grant: sortByCatalogOrder(withImpliedPermissions(grant)), unrecognised };
}
