import { verifyMonitorProviderConfig, type MonitorConfigVerdict } from '@/lib/monitors';

// THE MONITOR CONFIGURATION PREFLIGHT, given a service seam (MOTIR-5831) so
// `system.daily-health-check` can consume it.
//
// Thin by design, exactly like `fleetPreflightService`: the whole decision lives
// in `verifyMonitorProviderConfig()` inside `lib/monitors/`, which is the only
// place permitted to resolve providers out of the registry
// (`tests/monitors/monitorBoundaries.test.ts`). What is added HERE is the
// 4-layer seam every job handler consumes its domain through — `jobServices`
// hands it to the daily check, and the handler's test stubs a verdict rather
// than the environment.
//
// ⚠️ WHY THIS IS A HEALTH CHECK AND NOT A GATE — the same argument the fleet
// preflight makes, one integration over. The fault is invisible per request:
// every Connect attempt fails identically, after the person has already approved
// an install in their own Sentry organisation, and the error text is about our
// environment rather than about anything they did. Asserting it ONCE, on a
// schedule, is what turns "a customer will eventually tell us" into one sentence
// in the one place a human already looks.

export const monitorConfigPreflightService = {
  /**
   * Does every partly-configured monitor provider carry every name it declared?
   *
   * Never throws — each arm of {@link MonitorConfigVerdict} is an answer,
   * including "this deployment does not use one". The CALLER decides which arms
   * are loud; this only establishes which one is true.
   *
   * Synchronous, and deliberately: it reads `process.env` and opens no socket, so
   * there is no host whose downtime could make this probe flake. It is exposed as
   * a plain method because a job handler awaits it inside a `step.run` either
   * way.
   */
  check(): MonitorConfigVerdict {
    return verifyMonitorProviderConfig();
  },
};
