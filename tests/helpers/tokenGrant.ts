import { LEGACY_SCOPE_PERMISSIONS, type TokenScope } from '@/lib/mcp/scopes';
import type { PermissionKey } from '@/lib/permissions/catalog';

/**
 * The grant a token minted with these LEGACY scopes confers (MOTIR-2572).
 *
 * Suites written before this story express a caller as "a token with these
 * scopes", and that is still exactly what they mean — a credential narrowed the
 * way a real pre-MOTIR-2572 token was. Translating through the SHIPPED forward
 * map rather than rewriting each call site keeps those assertions intact and
 * makes every one of them exercise the compatibility promise on every run: if
 * `LEGACY_SCOPE_PERMISSIONS` ever stopped covering an operation a legacy token
 * could reach, these suites go red.
 *
 * A test asserting something about the NEW vocabulary should pass permission
 * keys directly instead of coming through here.
 */
export function grantForLegacyScopes(scopes: readonly TokenScope[]): PermissionKey[] {
  return [...new Set(scopes.flatMap((scope) => LEGACY_SCOPE_PERMISSIONS[scope]))];
}
