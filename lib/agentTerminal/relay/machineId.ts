import { hostname } from 'node:os';
import { hostInstanceId } from '@/lib/deployment/identity';

// WHICH RELAY PROCESS HOLDS A CONNECTION ROW (MOTIR-6959). On Fly it is the
// machine's own id, which survives a process restart on that machine — so a
// relay that comes back after a crash closes its own leftovers on boot. Off Fly
// (local, tests, a self-host) it is hostname + pid: unique per process, so two
// relays on one host never touch each other's rows. A restarted process then has
// a new id and its predecessor's rows are left to the sweep.
//
// The host's own variable is read by `hostInstanceId` in `lib/deployment/identity.ts`
// — the one file outside the orchestrator adapter allowed to name the provider
// (`tests/ciFleet/orchestratorPortBoundary.test.ts`) — not here.

/** The host's machine id (`hostInstanceId`), or `<hostname>-<pid>` when unset. Read at call time. */
export function relayMachineId(
  env: Readonly<Record<string, string | undefined>> = process.env,
  host: () => string = hostname,
  pid: number = process.pid,
): string {
  return hostInstanceId(env) ?? `${host()}-${pid}`;
}
