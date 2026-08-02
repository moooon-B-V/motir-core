import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLEET_IN_FLIGHT_CEILING,
  PROJECT_IN_FLIGHT_CAPS,
  fleetInFlightCeiling,
  projectCapEnvName,
  projectInFlightCapFor,
} from '@/lib/ciFleet/limits';

// The gate's CONFIGURATION half (Story MOTIR-1916 · MOTIR-1922) — pure, no DB.
//
// The acceptance criterion this file answers is short and easy to under-test:
// *"Both caps' sources are configurable — the per-project one per plan tier, the
// fleet one per environment — defaulting sanely when unset; neither is a
// hardcoded constant."* So the assertions are about the SOURCES, not about the
// specific numbers: that unset falls back, that a set value wins, that a
// nonsense value cannot silently become a cap, and that zero — the kill switch —
// is a real value rather than a falsy one.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the FLEET-WIDE ceiling is per ENVIRONMENT', () => {
  it('defaults sanely when unset', () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
    expect(fleetInFlightCeiling()).toBe(DEFAULT_FLEET_IN_FLIGHT_CEILING);
  });

  it('takes the environment value when set', () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '4');
    expect(fleetInFlightCeiling()).toBe(4);
  });

  // ZERO IS THE KILL SWITCH, and it is the one value a `value || default` read
  // would silently discard — turning "stop the fleet" into "run the default".
  // That is the §9 mechanism failing in the exact direction it exists to prevent.
  it('honours ZERO as a real ceiling, not as unset', () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(fleetInFlightCeiling()).toBe(0);
  });

  it.each(['nonsense', '-1', '3.5'])('falls back to the default for %s', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    // A typo must NOT read as 0. Interpreting a malformed value as the kill
    // switch would make the safety mechanism the cause of the outage.
    expect(fleetInFlightCeiling()).toBe(DEFAULT_FLEET_IN_FLIGHT_CEILING);
    expect(warn).toHaveBeenCalled();
  });
});

describe('the PER-PROJECT cap is per PLAN TIER', () => {
  it('gives free the Hobby shape and scaled the Pro shape', () => {
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '');
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_SCALED', '');
    expect(projectInFlightCapFor('free')).toBe(1);
    expect(projectInFlightCapFor('scaled')).toBe(12);
  });

  // `null` is "this tier has no per-project allowance" — NOT "unbounded
  // compute". The fleet ceiling still binds every one of these, which is the
  // only reason an unlimited tier is safe to express.
  it('exempts enterprise and meta from the per-project allowance', () => {
    expect(projectInFlightCapFor('enterprise')).toBeNull();
    expect(projectInFlightCapFor('meta')).toBeNull();
  });

  it('lets the environment override one tier without a deploy', () => {
    vi.stubEnv(projectCapEnvName('free'), '5');
    expect(projectInFlightCapFor('free')).toBe(5);
    // ...and only that tier.
    expect(projectInFlightCapFor('scaled')).toBe(PROJECT_IN_FLIGHT_CAPS.scaled);
  });

  it('falls back to the tier table for a malformed override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv(projectCapEnvName('scaled'), 'twelve');
    expect(projectInFlightCapFor('scaled')).toBe(PROJECT_IN_FLIGHT_CAPS.scaled);
  });

  it('names the override env var per tier', () => {
    expect(projectCapEnvName('free')).toBe('MOTIR_FLEET_PROJECT_CAP_FREE');
    expect(projectCapEnvName('scaled')).toBe('MOTIR_FLEET_PROJECT_CAP_SCALED');
  });
});
