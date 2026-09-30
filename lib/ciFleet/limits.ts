// THE FLEET'S LIMITS (Story MOTIR-1916 · MOTIR-1922, re-cut by MOTIR-6906 ·
// MOTIR-6907) — the pure configuration half of admission control. The counting,
// the locking and the decision live in `fleetCeilingService` and the admission
// services; nothing here reads the database.
//
// `docs/decisions/fleet-per-org-pool.md` is why the numbers are what they are:
//
//   * THE ORGANISATION'S POOL — `MOTIR_FLEET_ORG_MAX_IN_FLIGHT`, default 500 (§2).
//     Each organisation holds its own pool, so one org's burst never queues
//     another's. It is sized to the WORKLOAD (ten concurrent pull requests of a
//     50-job repository), not to a price: the org's credits are what bound its
//     spend (§3), and the attribution reconciler removes anything no paying org
//     owns (§5). An enterprise org may carry its own number, set by platform
//     staff on the org row (`Organization.fleetPoolCap`); it is never a per-org
//     env var.
//   * THE KILL SWITCH — `MOTIR_FLEET_MAX_IN_FLIGHT` (§6). It USED to be the one
//     fleet-wide ceiling (MOTIR-1997, default 24) and the only bound on Motir's
//     invoice. It is now the operator's kill switch and nothing else: `0` stops
//     every new boot of every workload, and unset or any positive number imposes
//     NO platform ceiling. An environment that still sets it to 24 keeps the old
//     number in its config and none of its meaning in the gate.
//   * The per-project tier caps (`PROJECT_IN_FLIGHT_CAPS`,
//     `MOTIR_FLEET_PROJECT_CAP_*`) are RETIRED (§6): how an org shares its pool
//     between its own projects is its own business.
//   * The INDEX caps (MOTIR-1990) keep their shape. The global one keys off the
//     environment and is now the one Motir-side bound on a workload nobody is
//     charged for (§7); the per-tenant one is DERIVED as `ceil(global / 2)` and
//     is now per ORGANISATION, because the org is the unit of capacity.
//
// ⚠️ AGENT INSTANCES ARE NOT IN THE ORG POOL (`docs/decisions/agent-instances.md`
// AMENDMENT 2). They are an `own`-pool workload: slotted under the same lock,
// bounded by their own `MOTIR_INSTANCE_MAX_RUNNING`, and never summed into an
// org's pool — a long-lived per-minute machine must not take CI's capacity. The
// kill switch still stops them.

/** The env var an operator sets to `0` to stop every new boot — the kill switch. */
const FLEET_KILL_SWITCH_ENV = 'MOTIR_FLEET_MAX_IN_FLIGHT';

/** The env var an operator raises or lowers every organisation's pool with. */
const ORG_POOL_ENV = 'MOTIR_FLEET_ORG_MAX_IN_FLIGHT';

/** The env var an operator raises or lowers the INDEX workload's own cap with
 *  (MOTIR-1990). Fairness and throughput, UNDERNEATH the ceiling above. */
const INDEX_CAP_ENV = 'MOTIR_INDEX_MAX_IN_FLIGHT';

/** The env var that tunes how long an unreleased slot keeps occupying capacity
 *  before the safety net ages it out. */
const FLEET_SLOT_TTL_ENV = 'MOTIR_FLEET_SLOT_TTL_SECONDS';

/**
 * THE ORGANISATION'S POOL when the environment sets none — how many containers
 * of the shared workloads (CI runners, hosted-agent runs, index containers) ONE
 * organisation may have in flight at once (`fleet-per-org-pool.md` §2).
 *
 * 500 is about ten pull requests' worth of a real repository's CI (≈ 50 jobs
 * each, motir-core#3243) — a number no single org reaches in ordinary use. It is
 * deliberately not a tier ladder: the money is the limit (§3), so an org that
 * does reach it is still bounded by its credits.
 */
export const DEFAULT_ORG_POOL_CAP = 500;

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
 * ⚠️ IT IS NOW THE ONE MOTIR-SIDE BOUND ON INDEXING (`fleet-per-org-pool.md` §7).
 * It was sized as "a quarter of the fleet" under the retired ceiling of 24; with
 * that ceiling gone, and with Motir charging nobody for indexing, money cannot
 * bound this workload the way it bounds CI — so this number does, the same shape
 * as `MOTIR_INSTANCE_MAX_RUNNING`'s safety valve.
 *
 * Six, kept from MOTIR-1990 (it replaced the job's `concurrency: 2`, which under
 * the stepped supervision shape would have held its Inngest slot for the
 * CONTAINER'S WHOLE LIFE and hard-capped the fleet at two). It is a starting
 * number to tune against MOTIR-1995's real index spend, not a capacity claim.
 */
export const DEFAULT_INDEX_IN_FLIGHT_CAP = 6;

/**
 * Read a non-negative integer from the environment, or fall back.
 *
 * ZERO IS LEGAL AND MEANINGFUL, which is why this is not a "positive int" read:
 * `MOTIR_FLEET_MAX_IN_FLIGHT=0` is the product-side kill switch §6 keeps — one
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
 * IS THE KILL SWITCH ENGAGED? — true exactly when `MOTIR_FLEET_MAX_IN_FLIGHT`
 * is `0` (`fleet-per-org-pool.md` §6).
 *
 * `0` stops every new boot of every workload — CI, indexing, hosted runs and
 * agent instances alike — without touching a provider console and without
 * stopping a container that is already serving someone's job. Unset, or ANY
 * positive number, imposes no platform ceiling at all: the ceiling this env var
 * used to be (MOTIR-1997) is retired, and a leftover `24` must not quietly keep
 * bounding the fleet. A malformed value reads as not engaged, with the reader's
 * warning — a typo must not stop everything.
 */
export function fleetKillSwitchEngaged(): boolean {
  return readCeilingEnv(FLEET_KILL_SWITCH_ENV, null) === 0;
}

/**
 * THE ORGANISATION'S POOL — how many shared-workload containers one org may have
 * in flight at once.
 *
 * `override` is the org's own number, set by platform staff for an enterprise
 * deal (`Organization.fleetPoolCap`, §2); when it is a non-negative integer it
 * wins over the environment. Otherwise `MOTIR_FLEET_ORG_MAX_IN_FLIGHT`, read on
 * every call so an operator can move it without a deploy, else
 * {@link DEFAULT_ORG_POOL_CAP}. Always a number: an org whose pool is unbounded
 * is not expressible, and `0` legitimately means "this org boots nothing".
 */
export function orgPoolCap(override: number | null = null): number {
  if (override !== null && Number.isInteger(override) && override >= 0) return override;
  /* istanbul ignore next -- the `?? 0` is UNREACHABLE: a non-null fallback means
     the shared reader cannot answer null here. */
  return readCeilingEnv(ORG_POOL_ENV, DEFAULT_ORG_POOL_CAP) ?? 0;
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
  /* istanbul ignore next -- unreachable for the same reason as the pool
     above: a non-null fallback means the reader never answers null. */
  return readCeilingEnv(FLEET_SLOT_TTL_ENV, DEFAULT_FLEET_SLOT_TTL_SECONDS) ?? 0;
}

/**
 * THE GLOBAL INDEX CAP — the maximum number of code-graph index containers the
 * whole fleet may have in flight at once, across every tenant.
 *
 * Read from the environment on every call, never captured in a module constant,
 * so moving it needs no code change. With no fleet ceiling left it is the one
 * Motir-side bound on a workload nobody is charged for (`fleet-per-org-pool.md`
 * §7): money cannot bound indexing the way it bounds CI. Always a number — an
 * unbounded index workload is not expressible — and `0` is the index-only kill
 * switch, stopping indexing without touching CI.
 */
export function indexInFlightCap(): number {
  /* istanbul ignore next -- the `?? 0` is UNREACHABLE for the same reason as
     `orgPoolCap`'s: a non-null fallback means the shared reader cannot answer
     null here. */
  return readCeilingEnv(INDEX_CAP_ENV, DEFAULT_INDEX_IN_FLIGHT_CAP) ?? 0;
}

/**
 * THE PER-ORGANISATION INDEX CAP — `ceil(global / 2)`, so no single organisation
 * can hold more than half the index lane (`fleet-per-org-pool.md` §7, replacing
 * MOTIR-1990's per-WORKSPACE share: the organisation is now the unit of
 * capacity, so it is the tenant that must not hold more than half).
 *
 * ⚠️ DERIVED, NEVER SEPARATELY CONFIGURED, and that is the decision rather than
 * an implementation detail (`code-graph-index-fleet.md` §7). Two independent
 * numbers drift — an operator raises one and forgets the other, and the fairness
 * property silently stops holding — while the invariant that actually matters,
 * *"no tenant takes more than half"*, is only expressible as a RELATION between
 * them. So there is deliberately no `MOTIR_INDEX_MAX_IN_FLIGHT_PER_ORG`.
 *
 * `ceil`, not `floor`: at a global cap of 1 the floor would be 0, which is not
 * "fair" but "nothing indexes, ever". The rounding always errs toward work
 * happening, and the global cap is what keeps that bounded.
 */
export function orgIndexInFlightCap(globalCap: number): number {
  return Math.ceil(globalCap / 2);
}
