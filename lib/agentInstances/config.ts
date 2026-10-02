// The agent-instance lane's NUMBERS (Story MOTIR-6860 · MOTIR-6872) — each one
// `docs/decisions/agent-instances.md`'s, named once. Read at CALL time, so a
// deployment that sets the two cap variables changes behaviour without a build.

/** §3: the home volume, fixed, no auto-extend. */
export const INSTANCE_VOLUME_SIZE_GB = 10;

/** §1: the volume is mounted at the sandbox image's `HOME`. */
export const INSTANCE_HOME_PATH = '/home/node';

/** §1: repositories are cloned under the HOME, because the rootfs resets on every wake. */
export const INSTANCE_WORKSPACE_PATH = `${INSTANCE_HOME_PATH}/workspace`;

/** §2: an instance with no activity for this long hibernates. */
export const INSTANCE_IDLE_WINDOW_MS = 30 * 60 * 1000;

/** §2: no running interval lasts longer than this; the sweep hibernates at it. */
export const INSTANCE_INTERVAL_BACKSTOP_MS = 12 * 60 * 60 * 1000;

/**
 * §6: a slot's safety net — the backstop plus one sweep's margin. The decision
 * sized it for a 5-minute sweep (12 h 15 min); the sweep runs on the job
 * substrate's clustered 30-minute cadence (`agentInstanceSweepService`'s header),
 * so the margin is one 30-minute sweep plus a quarter hour: 12 h 45 min.
 */
export const INSTANCE_SLOT_TTL_SECONDS = 12 * 60 * 60 + 45 * 60;

/**
 * `agent-instance-storage.md` §2: what one agent's storage costs its organisation
 * per UTC day on which it existed at any moment — running, hibernated or failed —
 * in whole credits. Derived there (volume + one full snapshot copy, + the agent
 * lane's ~20% margin, rounded UP) and re-derived there when a measured snapshot
 * size or Fly's prices move; this constant changes with a note in that record.
 */
export const INSTANCE_STORAGE_CREDITS_PER_DAY = 10;

/** §6: live (not deleted) instances one user may hold, across projects. */
export const INSTANCE_MAX_PER_USER = 10;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Running agent instances ONE ORGANISATION may hold at once:
 * `MOTIR_INSTANCE_MAX_RUNNING`, default 50 (`agent-instances.md` AMENDMENT 3,
 * `agent-instance-storage.md` §3). It was one count across every organisation
 * (AMENDMENT 2); Motir is multi-tenant, so one busy organisation must never slow
 * another, and the count is now keyed on the slot's organisation, under the same
 * fleet admission lock that takes the slot. Reaching it refuses
 * `org_running_cap` with the organisation's own limit in the words.
 *
 * Motir's own organisations (`isMeta` / `internalBilling`) have no running cap
 * ({@link isUnlimitedAgentOrg}). There is no fleet-wide agent cap any more:
 * `MOTIR_FLEET_MAX_IN_FLIGHT=0` stays the operator's kill switch for every
 * workload. Agents keep their OWN pool: this number is not a share of an org's
 * fleet pool (`MOTIR_FLEET_ORG_MAX_IN_FLIGHT`).
 */
export function instanceMaxRunning(): number {
  return positiveIntFromEnv('MOTIR_INSTANCE_MAX_RUNNING', 50);
}

/** How long a create or wake waits in the REQUEST for the machine to report running
 *  before leaving the rest to the sweep (the boot settle is idempotent). */
export const INSTANCE_INLINE_BOOT_WAIT_MS = 20_000;

/** How long a hibernate waits in the request for the machine to report stopped. */
export const INSTANCE_INLINE_STOP_WAIT_MS = 15_000;

/** A name: lower-case letters, digits and dashes, starting with a letter or digit. */
export const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Motir's own organisations have NO agent limits (`agent-instances.md`
 * AMENDMENT 3; the product owner, 2026-09-29: "meta org and internal org have no
 * limit"). The meta org (`isMeta`) and every internal org (`internalBilling`) skip
 * the per-user cap, the per-organisation running cap and the credit gate — at
 * create, at wake and in the sweep — and are still CHARGED like any org. The ONE
 * predicate: this reads the two flags and gives neither a new meaning.
 */
export function isUnlimitedAgentOrg(org: { isMeta: boolean; internalBilling: boolean }): boolean {
  return org.isMeta || org.internalBilling;
}

/**
 * What one agent's storage COSTS MOTIR per month, in USD per GB-month — the two
 * Fly prices `agent-instance-storage.md` §2 derives the day rate from (volume
 * $0.15, snapshot $0.08 on one full copy of the volume, UNMEASURED). Decimal
 * strings: the platform meter report (MOTIR-7294) sends the cost exactly. Moves
 * with that record, like the credit rate above.
 */
export const INSTANCE_VOLUME_USD_PER_GB_MONTH = '0.15';
export const INSTANCE_SNAPSHOT_USD_PER_GB_MONTH = '0.08';
/** The record's month: §2 divides a month's cost by 30 to reach a day. */
export const INSTANCE_STORAGE_DAYS_PER_MONTH = 30;
