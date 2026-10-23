import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { getOrgSubscription } from '@/lib/ai/motirAiClient';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { isCloudBilling } from '@/lib/billing/availability';

// ONE READ OF AN ORGANISATION'S AI PLAN (Story MOTIR-9363 · MOTIR-9372), shared by
// the paid-plan gate (`aiPlanGateService`) and the plan caps (`planCapsService`).
//
// Admission asks both questions per container — *may this org spend at all?* and
// *how much may it run at once?* — and a burst of one org's CI is hundreds of
// containers in seconds. Both answers come from the same subscription, so they
// come from ONE read per organisation per 30 seconds rather than two round trips
// to motir-ai per container.
//
// The rules are the gate's, unchanged (MOTIR-6909):
//   * a build with no billing (`!isCloudBilling()`) is `exempt`, without a read;
//   * Motir's own organisations (`isMeta` / `internalBilling`) are `exempt` from
//     their own row, BEFORE any remote read, so an unreachable motir-ai can never
//     fail them closed;
//   * anything that cannot be read is `unknown`, and `unknown` is NEVER cached, so
//     the next call after motir-ai recovers reads again.

export type OrgPlanRead =
  | { kind: 'exempt' }
  | { kind: 'subscription'; subscription: RawSubscriptionResponse }
  | { kind: 'unknown' };

/** How long one read is reused. Short, so a plan change takes effect within a
 *  minute; `unknown` is never cached, so recovery is immediate. */
export const PLAN_CACHE_TTL_MS = 30_000;

type CachedRead = Exclude<OrgPlanRead, { kind: 'unknown' }>;

const readCache = new Map<string, { read: CachedRead; expiresAt: number }>();

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

function remember(organizationId: string, read: CachedRead): CachedRead {
  readCache.set(organizationId, { read, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
  return read;
}

/** Is this organisation one of Motir's own? `null` when its row cannot be read. */
async function readExemption(organizationId: string): Promise<boolean | null> {
  try {
    const org = await withOrgServiceWriteContext(organizationId, (tx) =>
      organizationRepository.findByIdInTx(organizationId, tx),
    );
    if (!org) {
      console.error('[orgPlanReader] the organization row could not be found', {
        organizationId,
      });
      return null;
    }
    return org.isMeta || org.internalBilling;
  } catch (err) {
    console.error('[orgPlanReader] could not read the organization', {
      organizationId,
      detail: detailOf(err),
    });
    return null;
  }
}

/** The organisation's plan, read once per 30 s. Never throws. */
export async function readOrgPlan(organizationId: string): Promise<OrgPlanRead> {
  if (!isCloudBilling()) return { kind: 'exempt' };

  const cached = readCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.read;

  const exempt = await readExemption(organizationId);
  if (exempt === null) return { kind: 'unknown' };
  if (exempt) return remember(organizationId, { kind: 'exempt' });

  try {
    const subscription = await getOrgSubscription({ coreOrganizationId: organizationId });
    return remember(organizationId, { kind: 'subscription', subscription });
  } catch (err) {
    console.error('[orgPlanReader] could not read the AI plan — refusing (fail-closed)', {
      organizationId,
      detail: detailOf(err),
    });
    return { kind: 'unknown' };
  }
}

/** Test seam: forget every cached read. */
export function _resetOrgPlanCache(): void {
  readCache.clear();
}
