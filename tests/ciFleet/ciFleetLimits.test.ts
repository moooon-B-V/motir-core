import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLEET_SLOT_TTL_SECONDS,
  DEFAULT_INDEX_IN_FLIGHT_CAP,
  DEFAULT_ORG_POOL_CAP,
  fleetKillSwitchEngaged,
  fleetSlotTtlSeconds,
  indexInFlightCap,
  orgIndexInFlightCap,
  orgPoolCap,
} from '@/lib/ciFleet/limits';

// The gate's CONFIGURATION half (Story MOTIR-1916 · MOTIR-1922, re-cut by
// MOTIR-6907 per `docs/decisions/fleet-per-org-pool.md`) — pure, no DB.
//
// The assertions are about the SOURCES, not about the specific numbers: that
// unset falls back, that a set value wins, that a nonsense value cannot silently
// become a limit, and that zero — the kill switch — is a real value rather than a
// falsy one.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the ORGANISATION's pool is per ENVIRONMENT, with an enterprise override", () => {
  it('defaults to 500 when unset (§2)', () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '');
    expect(DEFAULT_ORG_POOL_CAP).toBe(500);
    expect(orgPoolCap()).toBe(500);
  });

  it('takes the environment value when set', () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '40');
    expect(orgPoolCap()).toBe(40);
  });

  it("lets the org's own number win over the environment", () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '40');
    expect(orgPoolCap(2000)).toBe(2000);
    // Zero is a real override: this org boots nothing.
    expect(orgPoolCap(0)).toBe(0);
  });

  it('ignores a nonsense override and falls back to the environment', () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '40');
    expect(orgPoolCap(-3)).toBe(40);
    expect(orgPoolCap(2.5)).toBe(40);
  });

  it.each(['nonsense', '-1', '3.5'])('falls back to the default for %s', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', raw);
    expect(orgPoolCap()).toBe(DEFAULT_ORG_POOL_CAP);
    expect(warn).toHaveBeenCalled();
  });
});

// §6: the old fleet-wide ceiling survives ONLY as the operator's kill switch.
describe('MOTIR_FLEET_MAX_IN_FLIGHT is the KILL SWITCH and nothing else', () => {
  it('is engaged by ZERO', () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(fleetKillSwitchEngaged()).toBe(true);
  });

  // Unset — and ANY positive number, including the retired default 24 an
  // environment may still carry — imposes no platform ceiling.
  it.each(['', '24', '1', '100000'])('is NOT engaged by %j', (raw) => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    expect(fleetKillSwitchEngaged()).toBe(false);
  });

  it.each(['nonsense', '-1', '0.0.0'])('reads %s as NOT engaged, with a warning', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    // A typo must NOT read as 0 — the safety mechanism must not cause the outage.
    expect(fleetKillSwitchEngaged()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

// §7: the index share is per ORGANISATION, derived as ceil(global / 2).
describe('the index share is per ORGANISATION, derived from the global cap', () => {
  it('is 3 at the default global of 6', () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '');
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    expect(orgIndexInFlightCap(indexInFlightCap())).toBe(3);
  });

  it('rounds up, so a global of 1 still lets one org index', () => {
    expect(orgIndexInFlightCap(1)).toBe(1);
    expect(orgIndexInFlightCap(10)).toBe(5);
    expect(orgIndexInFlightCap(0)).toBe(0);
  });
});

// The slot safety net (MOTIR-1997) — the third tunable, and the one whose wrong
// direction is silent. A ceiling set too low queues work visibly; a TTL set too
// SHORT stops counting a container that is still running and spending, so the
// pool is exceeded and nothing says so.
describe('the fleet-slot TTL is per ENVIRONMENT', () => {
  it('defaults to a value LONGER than any container Motir boots', () => {
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '');
    expect(fleetSlotTtlSeconds()).toBe(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    // §6's boot budget and every workload's hard-kill sit far inside an hour;
    // the default has to clear them with room, or the safety net becomes the
    // thing that breaks the pool.
    expect(DEFAULT_FLEET_SLOT_TTL_SECONDS).toBeGreaterThan(60 * 60);
  });

  it('takes the environment value when set', () => {
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '900');
    expect(fleetSlotTtlSeconds()).toBe(900);
  });

  it('falls back for a malformed value rather than reading it as zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', 'six hours');
    // A typo must not silently disable the safety net.
    expect(fleetSlotTtlSeconds()).toBe(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    expect(warn).toHaveBeenCalled();
  });
});
