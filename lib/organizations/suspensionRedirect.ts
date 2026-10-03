import { redirect } from 'next/navigation';
import {
  ORGANIZATION_SUSPENDED_PATH,
  OrganizationSuspendedError,
} from '@/lib/organizations/errors';

/**
 * Where a PAGE sends a member refused by a suspended organization (MOTIR-748):
 * `/organization-suspended?org=<id>`, the design's `member.suspended.*` notice
 * (the page itself is MOTIR-752's).
 */
export function organizationSuspendedHref(organizationId: string): string {
  return `${ORGANIZATION_SUSPENDED_PATH}?org=${encodeURIComponent(organizationId)}`;
}

/**
 * Await a page-side read that reaches the workspace access gate and turn the
 * suspension refusal into the notice redirect — the PAGE door's translation of
 * `OrganizationSuspendedError`, as `requireCompliantWorkspaceContext` is the
 * cookie API's (403). Any other rejection propagates unchanged.
 *
 * `redirect()` throws Next's sentinel, so a caller inside a `Promise.all` (the
 * `(authed)` layout's wave) short-circuits exactly as the 2FA gate does.
 */
export async function redirectIfOrganizationSuspended<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof OrganizationSuspendedError)
      redirect(organizationSuspendedHref(err.organizationId));
    throw err;
  }
}
