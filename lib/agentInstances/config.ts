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

/** §6: live (not deleted) instances one user may hold, across projects. */
export const INSTANCE_MAX_PER_USER = 10;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The agent pool's safety valve — running instances fleet-wide, across every
 * organisation: `MOTIR_INSTANCE_MAX_RUNNING`, default 50 (AMENDMENT 2).
 *
 * ⚠️ NOT A PRODUCT LIMIT. Who may run how many is decided by credits (charged
 * while a machine runs) and by {@link INSTANCE_MAX_PER_USER}; there is no
 * per-organisation cap. This bounds only what Motir has running on Fly at once if
 * everything else failed — Fly offers no spending cap of its own — so it sits well
 * above ordinary use and an operator raises it as usage grows. Agents have their
 * OWN pool: this number is not a share of an org's fleet pool
 * (`MOTIR_FLEET_ORG_MAX_IN_FLIGHT`).
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
