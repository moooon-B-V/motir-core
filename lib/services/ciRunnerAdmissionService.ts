import type { CiRunnerProvisioningIntent } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
  projectAdmissionScope,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { pmTierForOrg, type PmTier } from '@/lib/billing/entitlements';
import { isCloudBilling } from '@/lib/billing/availability';
import { fleetInFlightCeiling, projectInFlightCapFor } from '@/lib/ciFleet/limits';

// THE PROVISIONING GATE (Story MOTIR-1916 · MOTIR-1922) — the one place that
// answers *should this intent get a runner at all?*, decided under a lock before
// anything is spent.
//
// Three guards, one call site, because they are three answers to the same
// question about the same intent:
//
//   1. THE PER-PROJECT IN-FLIGHT CAP — how much concurrency this tenant has
//      bought (the Vercel/Netlify shape). Fairness first: without it one project
//      can occupy the whole fleet and starve every other tenant. A per-tenant
//      cost bound second.
//   2. THE FLEET-WIDE CEILING — how much compute Motir is willing to run at
//      once, whoever asked. ⚠️ THE ONLY THING THAT BOUNDS MOTIR'S TOTAL CI
//      SPEND: `docs/decisions/ci-runner-fleet.md` §9 records that Fly offers
//      neither a spending cap nor a billing alert, so there is no provider-side
//      backstop under this number, and per-project caps do not add up to one —
//      they multiply by an unbounded project count.
//   3. THE CREDIT REFUSAL — `ci_credits_exhausted` declines to boot. The state
//      comes from the SHIPPED `ciAllowanceService.getEntitlementState` and is
//      never re-derived here, so the billing panel, MOTIR-1907's Actions pause,
//      and this gate cannot come to disagree about whether an org is exhausted.
//
// ⚠️ WHY THIS EXISTS AT ALL — the safety valve that was removed. Moving off
// GitHub-hosted runners removed the account-wide 60-concurrent-job cap, which
// had been bounding BOTH one tenant's spend and one tenant's ability to starve
// the others, by accident rather than by design. Nothing external replaces it.
// `notes.html` #185 is the lesson that says what must: enforcement expressed in
// terms the PRODUCT controls, so that changing provider changes nothing about
// what stops the spend.
//
// ── THE DELIBERATE ASYMMETRY (the card states it; it is implemented here) ────
// Guard 3 fails OPEN: if the entitlement read throws, BOOT and log. Motir's own
// outage must never read to a user as "you are out of credits", and §6.4 already
// prices the bounded overshoot that letting a run through can cause.
// Guards 1–2 fail CLOSED: if the counts cannot be established, do NOT boot. The
// failure mode on the other side is unbounded spend on an account with no
// provider-side cap, and a queued job is recoverable while a runaway invoice is
// not.
//
// ── WHY THE CREDIT READ IS NOT INSIDE THE LOCKED TRANSACTION ────────────────
// It cannot be, and it should not be. `getEntitlementState` opens its own
// transaction under the ORG GUC (its membership read has no `system_admin`
// escape) and crosses the open-core boundary to motir-ai for the balance. Holding
// the FLEET-WIDE lock — which every admission in the system queues behind —
// across an HTTP call to another service would serialize the entire fleet behind
// motir-ai's latency, and a motir-ai timeout would become a fleet outage. So the
// caps are decided and the slot is CLAIMED under the lock; the credit state is
// read after, and a refusal RELEASES the claim. The window between them is
// microseconds of local work and errs toward the cap, never past it: for that
// moment the intent occupies a slot it may not keep.
//
// This ordering is also the cheaper one under load. When the fleet is saturated —
// exactly when the gate is busiest — guards 1–2 answer from local reads and the
// cross-boundary call never happens.

/** Why an intent was not admitted. Every one of these leaves the intent PENDING,
 *  so the provisioning sweep retries it — a deferral, never a rejection. */
export type AdmissionDeferralReason =
  /** The project is at its plan tier's concurrency allowance. */
  | 'project_cap'
  /** The whole fleet is at its ceiling — §9.1, the spend bound. */
  | 'fleet_ceiling'
  /** The org is past its pool AND out of credits. */
  | 'ci_credits_exhausted'
  /** The gate itself could not decide. FAIL-CLOSED: an unestablished count is
   *  treated as a full fleet, not an empty one. */
  | 'gate_unavailable';

export type AdmissionVerdict =
  /** Admitted AND CLAIMED — the intent is now `provisioning` and the caller owns
   *  it. The counts are carried out for the caller's log. */
  | { outcome: 'admitted'; projectInFlight: number; fleetInFlight: number }
  /** Another provisioner claimed it first. Not an error; the compare-and-set
   *  worked. */
  | { outcome: 'already_claimed' }
  /** Not admitted. The intent is still `pending`. */
  | { outcome: 'deferred'; reason: AdmissionDeferralReason; detail: string };

/** What the caps resolved to for one org, before any counting. */
interface ResolvedCaps {
  tier: PmTier;
  /** null = the per-project allowance does not apply to this tier (`meta`,
   *  `enterprise`). The fleet ceiling still binds it. */
  projectCap: number | null;
  fleetCeiling: number;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciRunnerAdmissionService = {
  /**
   * Decide whether ONE provisioning intent may boot, and CLAIM it if so.
   *
   * The claim is part of the decision rather than a separate step the caller
   * takes afterwards, and that is the load-bearing detail: the claim is what
   * makes the intent count as in-flight, so a gate that decided and then let
   * someone else claim would be deciding from a count that does not yet include
   * the decisions already made. Deciding and claiming in ONE transaction, under
   * the lock, is what makes the caps exact.
   *
   * Never throws. Every refusal is a typed verdict, because the caller is a
   * background job: a throw becomes an Inngest retry, and retrying "the fleet is
   * full" achieves nothing a queued intent and the next sweep do not.
   */
  async admit(intent: CiRunnerProvisioningIntent): Promise<AdmissionVerdict> {
    const caps = await this.resolveCaps(intent.organizationId);
    if (!caps) {
      // The tier read failed. FAIL CLOSED with the caps, per the asymmetry above:
      // an org whose plan cannot be established must not be handed the largest
      // allowance by default.
      console.error('[ciRunnerAdmissionService] could not resolve the org caps — not booting', {
        intentId: intent.id,
        organizationId: intent.organizationId,
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: "could not resolve the org's concurrency allowance",
      };
    }

    // ── Guards 1 + 2, and the claim — one locked transaction ──────────────────
    let claimed: AdmissionVerdict;
    try {
      claimed = await withSystemContext(async (tx) => {
        // ⚠️ LOCK ORDER IS FIXED — project scope, then fleet — and this is the
        // only site that takes either, so the order cannot be violated from
        // elsewhere. It matters because every admission takes the fleet lock
        // while only same-project admissions contend on the project one; a site
        // that took them the other way round could deadlock against this one.
        if (intent.projectId !== null && caps.projectCap !== null) {
          await locks.ensureScope(projectAdmissionScope(intent.projectId), tx);
          if (!(await locks.lockScope(projectAdmissionScope(intent.projectId), tx))) {
            throw new Error('the project admission lock could not be taken');
          }
        }
        await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
        if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
          throw new Error('the fleet admission lock could not be taken');
        }

        // 1 · THE PER-PROJECT CAP. Skipped for a tier with no allowance, and for
        // an intent naming no project — that intent is refused by the boot for a
        // better reason (no runner group, no tenant to bill), and inventing a
        // per-project cap for a null project would only hide it.
        let projectInFlight = 0;
        if (intent.projectId !== null) {
          projectInFlight = await intents.countInFlightForProject(intent.projectId, tx);
          if (caps.projectCap !== null && projectInFlight >= caps.projectCap) {
            return {
              outcome: 'deferred' as const,
              reason: 'project_cap' as const,
              detail: `project is at its in-flight cap (${projectInFlight}/${caps.projectCap}, tier ${caps.tier})`,
            };
          }
        }

        // 2 · THE FLEET-WIDE CEILING, immediately after guard 1, under the same
        // lock, in the same transaction. NOT bypassed by `isMeta` and not by the
        // tier: it bounds Motir's own invoice, and a meta-org runaway costs
        // exactly as much as any other.
        const fleetInFlight = await intents.countInFlightFleetWide(tx);
        if (fleetInFlight >= caps.fleetCeiling) {
          return {
            outcome: 'deferred' as const,
            reason: 'fleet_ceiling' as const,
            detail: `the fleet is at its in-flight ceiling (${fleetInFlight}/${caps.fleetCeiling})`,
          };
        }

        // 3 · TAKE THE SLOT. The compare-and-set on `pending` is what makes the
        // count above true of the world the moment this transaction commits.
        const took = await intents.claimPending(intent.id, tx);
        if (!took) return { outcome: 'already_claimed' as const };

        return { outcome: 'admitted' as const, projectInFlight, fleetInFlight };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so nothing was claimed and the
      // intent is still pending — the next sweep retries it. A count that could
      // not be established is treated as a full fleet.
      console.error('[ciRunnerAdmissionService] the admission gate failed — not booting', {
        intentId: intent.id,
        organizationId: intent.organizationId,
        detail: detailOf(err),
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the in-flight counts could not be established: ${detailOf(err)}`,
      };
    }

    if (claimed.outcome !== 'admitted') return claimed;

    // ── Guard 3 · the credit refusal, on the claim we now hold ────────────────
    const exhausted = await this.isCreditsExhausted(intent.organizationId);
    if (exhausted) {
      // Give the slot back. A refusal must not leave the intent occupying
      // capacity it is not using — that would let one exhausted org's queue
      // squeeze every paying tenant out of the fleet.
      await this.releaseClaim(intent.id);
      return {
        outcome: 'deferred',
        reason: 'ci_credits_exhausted',
        detail: 'the org is past its included pool and out of credits',
      };
    }

    return claimed;
  },

  /**
   * The two caps for one org, or null when the org's plan could not be read.
   *
   * The tier resolves through `pmTierForOrg` — the SINGLE chokepoint every §4 cap
   * already goes through — so the meta exemption and any future tier are honoured
   * here without this file knowing what a subscription is. Read under the org
   * GUC, like every other no-acting-user org read (`getEntitlementState` does the
   * same, and `withSystemContext` would be the silent bug: the org policies have
   * no system escape in production).
   *
   * ⚠️ TWO BYPASSES OF THE PER-PROJECT CAP, AND NEITHER TOUCHES THE FLEET
   * CEILING:
   *   * OFF-CLOUD (`MOTIR_CLOUD` unset/false) — a plan allowance is a commercial
   *     construct, and a self-hosted GPL build has no plan. Every §4 cap is
   *     already inert off-cloud (`entitlementsService`); this one matches.
   *   * The META tier — the card's own criterion.
   * The ceiling survives both because it is not a tenant's allowance: it is the
   * bound on whoever is paying the container bill, and a self-hoster's runaway
   * fleet is as real as Motir's.
   */
  async resolveCaps(organizationId: string): Promise<ResolvedCaps | null> {
    try {
      const tier = await withOrgServiceWriteContext(organizationId, async (tx) =>
        pmTierForOrg(await organizationRepository.findCapContextInTx(organizationId, tx)),
      );
      return {
        tier,
        projectCap: isCloudBilling() ? projectInFlightCapFor(tier) : null,
        fleetCeiling: fleetInFlightCeiling(),
      };
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not read the org cap context', {
        organizationId,
        detail: detailOf(err),
      });
      return null;
    }
  },

  /**
   * Is this org in the `ci_credits_exhausted` state?
   *
   * ⚠️ FAILS OPEN, and the log is the point: a false here can mean either "the
   * org has credit" or "Motir could not tell", and only the log distinguishes
   * them. Refusing on a failed read would turn a motir-ai blip into every
   * tenant's CI stopping, which is precisely the outcome `getEntitlementState`'s
   * own `balance: null` treatment exists to avoid — this gate must not undo it
   * one layer up.
   *
   * Off-cloud and the meta org need no special case HERE: the shipped service
   * answers `bypassed` for both, which is not `ci_credits_exhausted` and
   * therefore boots. Re-deriving either condition locally is what the card
   * forbids ("do not re-derive the state").
   */
  async isCreditsExhausted(organizationId: string): Promise<boolean> {
    try {
      const state = await ciAllowanceService.getEntitlementState(organizationId, new Date());
      return state.state === 'ci_credits_exhausted';
    } catch (err) {
      console.error(
        '[ciRunnerAdmissionService] could not read CI entitlement — booting anyway (fail-open)',
        { organizationId, detail: detailOf(err) },
      );
      return false;
    }
  },

  /** Put a claimed intent back in the pending pool. Best-effort: the worst case
   *  is an intent that sits in `provisioning` until the stale-claim sweep writes
   *  it off, which is visible and bounded — a throw here would be neither. */
  async releaseClaim(intentId: string): Promise<void> {
    try {
      await withSystemContext((tx) => intents.releaseClaim(intentId, tx));
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not release a claim', {
        intentId,
        detail: detailOf(err),
      });
    }
  },
};
