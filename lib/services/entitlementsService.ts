import type { Prisma } from '@prisma/client';
import { isCloudBilling } from '@/lib/billing/availability';
import { entitlementsFor, pmTierForOrg, type PmTier } from '@/lib/billing/entitlements';
import { EntitlementExceededError } from '@/lib/billing/errors';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// The §4 PM-core entitlement-cap ENFORCEMENT service (Story 8.1.11) — the
// gating + counting half (the pure tier→limits policy is `lib/billing/
// entitlements.ts`). It is called by the create paths (work item / project /
// workspace / org) and the upload path, and is INERT off-cloud: every method
// returns early when `isCloudBilling()` is false, so a self-hosted (GPL-3.0)
// build has every cap lifted (ADR §6 — billing + caps are cloud-only).
//
// ── How a cap is enforced (the warm-pool TOCTOU contract) ──────────────────
// A cap is a read-then-write guard: count, compare, then create. Two concurrent
// creates with no shared lock both observe `count = limit - 1`, both pass, and
// both insert → an off-by-one overage (warm-pool TOCTOU, CLAUDE.md §
// lock-before-read-derived). So every count-cap LOCKS THE ORG ROW `FOR UPDATE`
// first (`organizationRepository.lockByIdForUpdate`) — the single shared row all
// of an org's creates contend on — then counts under the lock. The second racer
// blocks until the first commits, re-counts, and correctly sees the limit. The
// caller MUST run the assert INSIDE the same transaction as the create it guards.
//
// ── How an org's tier is resolved ──────────────────────────────────────────
// `pmTierForOrg` resolves from the org's full cap context: the META org
// (`Organization.isMeta` — moooon B.V.) short-circuits to the internal `meta`
// tier (every cap lifted); any other org keys off `scaledTrackerSubscription`
// (§4 — NOT the AI PlanTier): an ACTIVE subscription is `scaled` (caps lifted),
// anything else is `free`. A missing/hidden org collapses to `free` (safe
// default: caps apply). Resolving here means every cap below — and any future
// cap — honours the meta exemption through this one chokepoint.

async function tierForOrgInTx(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<PmTier> {
  return pmTierForOrg(await organizationRepository.findCapContextInTx(organizationId, tx));
}

async function tierForOrg(organizationId: string): Promise<PmTier> {
  return pmTierForOrg(await organizationRepository.findCapContext(organizationId));
}

function isScaledActive(sub: ScaledTrackerSubscription | null): boolean {
  return sub?.status === 'active';
}

export const entitlementsService = {
  /**
   * §4.1 — block the create of a work item that would push the org past its
   * work-item cap. Counts ALL work items in the org (archived AND active — §4:
   * archiving does NOT free room). MUST be called inside the create transaction,
   * before `workItemRepository.create`, so the org lock serializes concurrent
   * creates (the required real-concurrency contract).
   */
  async assertWithinWorkItemCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await organizationRepository.lockByIdForUpdate(organizationId, tx);
    const { maxWorkItems } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxWorkItems === null) return;
    const current = await workItemRepository.countByOrganization(organizationId, tx);
    if (current >= maxWorkItems) {
      throw new EntitlementExceededError('work_items', { limit: maxWorkItems, usage: current });
    }
  },

  /** §4.2 — block the create of a project past the org's project cap. */
  async assertWithinProjectCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await organizationRepository.lockByIdForUpdate(organizationId, tx);
    const { maxProjects } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxProjects === null) return;
    const current = await projectRepository.countByOrganization(organizationId, tx);
    if (current >= maxProjects) {
      throw new EntitlementExceededError('projects', { limit: maxProjects, usage: current });
    }
  },

  /** §4.4 — block the create of a workspace past the org's workspace cap. */
  async assertWithinWorkspaceCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await organizationRepository.lockByIdForUpdate(organizationId, tx);
    const { maxWorkspaces } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxWorkspaces === null) return;
    const current = await workspaceRepository.countByOrganization(organizationId, tx);
    if (current >= maxWorkspaces) {
      throw new EntitlementExceededError('workspaces', { limit: maxWorkspaces, usage: current });
    }
  },

  /**
   * §4.5 — the org-CREATION gate. A user's FIRST org is always free (they
   * own/admin none yet). Creating a 2nd+ org requires the user to own/admin ≥1
   * org with an ACTIVE scaled-tracker subscription — otherwise a free account
   * could spin up N free orgs to dodge the per-org caps. Called inside the create
   * tx (covers both `organizationsService.createOrganization` AND the
   * mint-own-org branch of `workspacesService.insertWorkspaceWithOwner`).
   */
  async assertCanCreateOrganization(
    actorUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    const orgs = await organizationMembershipRepository.findOwnerAdminOrgsWithSubscription(
      actorUserId,
      tx,
    );
    if (orgs.length === 0) return; // the first org — always free
    // A scaled-active OR the META org (moooon B.V.) clears the gate — meta is
    // treated as paid so its owners can freely spin up orgs/workspaces.
    const hasUncappedOrg = orgs.some(
      (o) =>
        o.isMeta ||
        isScaledActive((o.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null),
    );
    if (!hasUncappedOrg) {
      throw new EntitlementExceededError('organizations', { limit: orgs.length });
    }
  },

  /**
   * §4.3a — the tier-derived PER-FILE upload limit in bytes. The 10 MB per-file
   * size is an OPERATIONAL BASELINE on EVERY build (it predates billing —
   * Subtask 2.3.7, `MAX_UPLOAD_BYTES`); what §4 adds on cloud is the SCALED
   * UPGRADE to 100 MB. So off-cloud (and on cloud `free`) this is the 10 MB
   * baseline; a cloud `scaled` org gets 100 MB. (Distinct from the count +
   * total-storage caps, which are purely commercial and FULLY lifted off-cloud.)
   * A read-only path (no create tx); resolves the org's tier via the db singleton.
   */
  async resolvePerFileLimitBytes(organizationId: string): Promise<number> {
    if (!isCloudBilling()) return entitlementsFor('free').maxUploadBytes;
    return entitlementsFor(await tierForOrg(organizationId)).maxUploadBytes;
  },

  /**
   * §4.3b — block an upload that would push the org past its TOTAL storage cap
   * (free 2 GB / scaled 100 GB). Sums `Attachment.sizeBytes` across the org and
   * rejects when `current + incoming > limit`. No FOR UPDATE — §4: a single-file
   * race overage is benign (storage, not money). Read-only path (no create tx).
   */
  async assertWithinStorageCap(organizationId: string, incomingBytes: number): Promise<void> {
    if (!isCloudBilling()) return;
    const { maxTotalStorageBytes } = entitlementsFor(await tierForOrg(organizationId));
    if (maxTotalStorageBytes === null) return;
    const current = await attachmentRepository.sumSizeByOrganization(organizationId);
    if (current + incomingBytes > maxTotalStorageBytes) {
      throw new EntitlementExceededError('storage', {
        limit: maxTotalStorageBytes,
        usage: current,
      });
    }
  },
};
