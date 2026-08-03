import type { PmTier } from '@/lib/billing/entitlements';

// The PROVISIONING GATE's two CAPS (Story MOTIR-1916 · MOTIR-1922) — the pure
// configuration half of admission control. The counting, the locking and the
// decision live in `ciRunnerAdmissionService`; nothing here reads the database.
//
// `docs/decisions/ci-runner-fleet.md` §9 is why both numbers exist and why they
// are DIFFERENT KINDS of number:
//
//   * The PER-PROJECT cap is a PRODUCT allowance — how much concurrency a tenant
//     has bought. It therefore keys off the org's plan TIER, in the shape every
//     CI product uses (Vercel: Hobby 1 concurrent build, Pro 12; Netlify the
//     same). It is fairness first and a per-tenant cost bound second.
//   * The FLEET-WIDE ceiling is an INFRASTRUCTURE bound — how much compute Motir
//     is willing to have running at once, whoever asked for it and WHATEVER
//     WORKLOAD it is (MOTIR-1997). It therefore keys off the ENVIRONMENT, not off
//     any tenant, and no tenant flag lifts it.
//
// ⚠️ THE FLEET CEILING IS THE ONLY THING THAT BOUNDS MOTIR'S TOTAL FLEET SPEND
// (§9). Fly offers neither a spending cap nor a billing alert — *"We don't
// support billing alerts (yet), so budget accordingly"*, *"there's no soft
// ceiling. If you go over, we'll bill you"* — so there is no provider-side
// backstop under this number, and per-project caps do not substitute for it:
// they multiply by an unbounded project count. `notes.html` #185 is the lesson
// that put it here rather than in a vendor console: express enforcement in terms
// the product controls, so that changing provider changes nothing about what
// stops the spend.
//
//   * The INDEX caps (MOTIR-1990) are a third kind again: a WORKLOAD bound and a
//     per-TENANT bound on that workload, both underneath the ceiling. The global
//     one keys off the environment (it is sized against the fleet spend cap); the
//     per-workspace one keys off NEITHER environment nor tier — it is DERIVED as
//     `ceil(global / 2)`, because the property being enforced is a relation
//     ("no tenant holds more than half"), not a number.
//
// ⚠️ THE CEILING IS CROSS-WORKLOAD AS OF MOTIR-1997, and the env var is
// unchanged on purpose. `MOTIR_FLEET_MAX_IN_FLIGHT` used to mean "CI runners";
// it now means "containers, of any workload" — CI runners, MOTIR-1981/1990's
// code-graph index containers, Epic 9's hosted agents — because those share one
// Fly org and therefore one invoice. An operator who tuned it against CI alone
// should re-tune it: the number did not change, the set it counts did. Which
// workloads exist and where each is counted from is `workloads.ts`; the summing
// and the lock are `fleetCeilingService`.

/** The env var an operator raises or lowers the fleet ceiling with. */
const FLEET_CEILING_ENV = 'MOTIR_FLEET_MAX_IN_FLIGHT';

/** The env var an operator raises or lowers the INDEX workload's own cap with
 *  (MOTIR-1990). Fairness and throughput, UNDERNEATH the ceiling above. */
const INDEX_CAP_ENV = 'MOTIR_INDEX_MAX_IN_FLIGHT';

/** The env var that tunes how long an unreleased slot keeps occupying capacity
 *  before the safety net ages it out. */
const FLEET_SLOT_TTL_ENV = 'MOTIR_FLEET_SLOT_TTL_SECONDS';

/**
 * The fleet-wide in-flight ceiling when the environment sets none.
 *
 * 24 concurrent containers, which at §8's ~$0.00195/minute for the 2-core fleet
 * size is a bounded worst case of roughly $2.80/hour if every slot stayed full —
 * generous enough that ordinary bursts never touch it, small enough that a
 * runaway is a rounding error rather than an incident. It is a STARTING number
 * an operator is expected to tune against MOTIR-1924's real spend data, not a
 * capacity claim.
 */
export const DEFAULT_FLEET_IN_FLIGHT_CEILING = 24;

/**
 * How long a slot taken by a slot-backed workload keeps counting if nobody ever
 * releases it — 6 hours.
 *
 * ⚠️ THIS IS A SAFETY NET, NOT A TIMEOUT. Release is an explicit delete when the
 * container ends; this only bounds the damage of a release that never runs. The
 * number is therefore deliberately LONGER than any container Motir boots (§6's
 * budget and every workload's own hard-kill sit far inside it) — a TTL shorter
 * than a container's real life would stop counting a container that is still
 * running and spending, which is the one direction this must never err in. It is
 * long enough to be safe and short enough that a crashed dispatcher's debris
 * clears within a working day rather than never.
 */
export const DEFAULT_FLEET_SLOT_TTL_SECONDS = 6 * 60 * 60;

/**
 * THE GLOBAL INDEX CAP when the environment sets none — how many code-graph
 * INDEX containers may run at once, across every tenant (MOTIR-1990,
 * `docs/decisions/code-graph-index-fleet.md` §7).
 *
 * ⚠️ IT IS NOT THE SPEND BOUND, and §7.2 is explicit that it must not be read as
 * one: `MOTIR_FLEET_MAX_IN_FLIGHT` bounds the invoice, over every workload, with
 * nothing but Motir's own counter underneath it. THIS number is index fairness
 * and index throughput — it keeps one workload from consuming the whole ceiling
 * and starving CI, and it is the number an operator moves when the fleet spend
 * cap moves.
 *
 * Six, chosen against the two figures that bracket it: the ceiling it sits under
 * (`DEFAULT_FLEET_IN_FLIGHT_CEILING = 24`, so indexing can take at most a
 * quarter of the fleet and CI is never squeezed out by a repo-connect burst),
 * and the value it replaces (the job's `concurrency: 2`, which under the stepped
 * supervision shape would have held its Inngest slot for the CONTAINER'S WHOLE
 * LIFE and hard-capped the fleet at two regardless of what was configured here).
 * It is a starting number to tune against MOTIR-1995's real index spend, not a
 * capacity claim.
 */
export const DEFAULT_INDEX_IN_FLIGHT_CAP = 6;

/**
 * The PER-TIER concurrency allowance — the §4-style "tunable policy" table, the
 * same shape as `PM_ENTITLEMENTS`, so raising a tier's concurrency is a one-line
 * edit with no migration.
 *
 * `null` means the per-project cap does not apply to that tier. That is NOT
 * "unbounded compute": the fleet ceiling still binds every one of these, which
 * is exactly why an unlimited tier is safe to express at all.
 *
 * `meta` is null because the ACCEPTANCE CRITERION says so — moooon B.V. is
 * exempt from the per-tenant allowance. It is emphatically not exempt from the
 * fleet ceiling; a meta-org runaway costs Motir exactly as much as any other.
 */
export const PROJECT_IN_FLIGHT_CAPS: Record<PmTier, number | null> = {
  /** The Hobby shape: one job at a time, so a free project cannot occupy the
   *  fleet — the fairness half of the card, in one number. */
  free: 1,
  /** The Pro shape. Twelve concurrent jobs comfortably runs a matrix build. */
  scaled: 12,
  /** Custom deals negotiate their own concurrency; the fleet ceiling still binds. */
  enterprise: null,
  /** The internal dogfood org — exempt per the card, and ONLY from this cap. */
  meta: null,
};

/**
 * Read a non-negative integer from the environment, or fall back.
 *
 * ZERO IS LEGAL AND MEANINGFUL, which is why this is not a "positive int" read:
 * `MOTIR_FLEET_MAX_IN_FLIGHT=0` is the product-side kill switch §9 wants — one
 * env change stops the fleet booting anything, without touching a provider
 * console and without stopping containers that are already serving someone's
 * job. A malformed or negative value is a misconfiguration, and it falls back to
 * the sane default WITH A WARNING rather than being read as zero: silently
 * interpreting a typo as "stop everything" would be an outage caused by the
 * safety mechanism.
 */
function readCeilingEnv(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn('[ciFleet/limits] ignoring a malformed in-flight limit; using the default', {
      env: name,
      raw,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

/**
 * THE FLEET-WIDE CEILING — the maximum number of containers the whole fleet may
 * have in flight at once, across every tenant AND EVERY WORKLOAD (MOTIR-1997).
 *
 * Always a number, never null: an unbounded fleet is the one state §9 exists to
 * make unreachable, so there is deliberately no way to express it. An operator
 * who wants more raises the env var; an operator who wants none sets it to 0 —
 * and zero now stops CI, indexing and agents alike, which is what a kill switch
 * on an uncapped account should do.
 */
export function fleetInFlightCeiling(): number {
  /* istanbul ignore next -- the `?? 0` is UNREACHABLE and kept only to satisfy
     the shared reader's `number | null` return: this call passes a NON-NULL
     fallback, so `readCeilingEnv` cannot answer null here. It stays rather than
     being widened away because narrowing the reader's type would fork it from
     `projectInFlightCapFor`, whose fallback genuinely is nullable. */
  return readCeilingEnv(FLEET_CEILING_ENV, DEFAULT_FLEET_IN_FLIGHT_CEILING) ?? 0;
}

/**
 * How long an unreleased fleet slot keeps occupying capacity, in seconds.
 *
 * Reuses the same reader as the ceilings, which means ZERO IS LEGAL here too —
 * and it is the honest reading: `MOTIR_FLEET_SLOT_TTL_SECONDS=0` turns the
 * safety net off entirely, so every slot is born already expired and only an
 * explicit release is doing any work. That is a legitimate (if reckless)
 * operator choice on a fleet whose releases are trusted, and it errs toward
 * booting rather than toward refusing — so unlike the ceiling's zero, do not
 * reach for it as a kill switch. A malformed value falls back with a warning
 * rather than being read as zero, for the same reason the ceilings do.
 */
export function fleetSlotTtlSeconds(): number {
  /* istanbul ignore next -- unreachable for the same reason as the ceiling
     above: a non-null fallback means the reader never answers null. */
  return readCeilingEnv(FLEET_SLOT_TTL_ENV, DEFAULT_FLEET_SLOT_TTL_SECONDS) ?? 0;
}

/**
 * THE GLOBAL INDEX CAP — the maximum number of code-graph index containers the
 * whole fleet may have in flight at once, across every tenant.
 *
 * Read from the environment on every call, never captured in a module constant:
 * §7 requires that moving it needs no code change, because it is sized against
 * the fleet spend cap and has to follow when that moves. Always a number for the
 * same reason the ceiling is — an unbounded index workload is not expressible —
 * and `0` is the index-only kill switch, stopping indexing without touching CI.
 */
export function indexInFlightCap(): number {
  /* istanbul ignore next -- the `?? 0` is UNREACHABLE for the same reason as
     `fleetInFlightCeiling`'s: a non-null fallback means the shared reader cannot
     answer null here. */
  return readCeilingEnv(INDEX_CAP_ENV, DEFAULT_INDEX_IN_FLIGHT_CAP) ?? 0;
}

/**
 * THE PER-WORKSPACE INDEX CAP — `ceil(global / 2)`, so no single tenant can hold
 * more than half the index lane.
 *
 * ⚠️ DERIVED, NEVER SEPARATELY CONFIGURED, and that is the decision rather than
 * an implementation detail (§7). Two independent numbers drift — an operator
 * raises one and forgets the other, and the fairness property silently stops
 * holding — while the invariant that actually matters, *"no tenant takes more
 * than half"*, is only expressible as a RELATION between them. So there is
 * deliberately no `MOTIR_INDEX_MAX_IN_FLIGHT_PER_WORKSPACE`.
 *
 * `ceil`, not `floor`: at a global cap of 1 the floor would be 0, which is not
 * "fair" but "nothing indexes, ever". The rounding always errs toward work
 * happening, and the global cap is what keeps that bounded.
 */
export function workspaceIndexInFlightCap(globalCap: number): number {
  return Math.ceil(globalCap / 2);
}

/** The env var that overrides one tier's per-project allowance, e.g.
 *  `MOTIR_FLEET_PROJECT_CAP_FREE`. Exported so the tests name it the same way
 *  the reader does rather than rebuilding the string. */
export function projectCapEnvName(tier: PmTier): string {
  return `MOTIR_FLEET_PROJECT_CAP_${tier.toUpperCase()}`;
}

/**
 * THE PER-PROJECT CAP for an org on `tier` — how many runners one project may
 * have in flight at once, or null when the allowance does not apply.
 *
 * The tier table is the source; the env override exists so an operator can
 * change an allowance for an incident without a deploy. There is no way to
 * express "unlimited" through the env — an override is always a number — which
 * is intentional: lifting a cap should be a reviewed edit to the policy table,
 * not an env var somebody set at 3am.
 */
export function projectInFlightCapFor(tier: PmTier): number | null {
  return readCeilingEnv(projectCapEnvName(tier), PROJECT_IN_FLIGHT_CAPS[tier]);
}
