/**
 * WHERE IS THIS PROCESS RUNNING? — the one place motir-core asks that question
 * (MOTIR-1167), and the one place in `lib/` outside the orchestrator adapter
 * that is allowed to know the answer is Fly's.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS ONE FILE
 * ---------------------------------------------------------------------------
 * `tests/ciFleet/orchestratorPortBoundary.test.ts` enforces
 * `docs/decisions/ci-runner-fleet.md` §4 rule 1 — *no `fly` types, imports or
 * ids above the adapter directory* — by scanning the SOURCE of all of `lib/`,
 * `app/` and `components/`, because half the ways a provider leaks (a hardcoded
 * API host, an env var, a status string) are not imports and a module-graph
 * check would miss them.
 *
 * The operator console's health glance needs the app's own hosting identity: the
 * card's acceptance criterion is that its link-out points at the Fly app
 * `motir-core`, and a link nobody can construct is not a link. So the knowledge
 * has to live SOMEWHERE, and the choice is between one named file and three raw
 * `process.env['FLY_*']` reads scattered through a service. This is that file:
 * it is registered as the guard's second `ALLOWED` entry, scoped to one path and
 * to the three variable names below, so a fourth `FLY_*` read here still fails
 * the guard rather than riding in on the exception.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ IT IS A DIFFERENT KIND OF EXCEPTION FROM THE FIRST, AND SAYING SO MATTERS
 * ---------------------------------------------------------------------------
 * The rule's SUBJECT is the CI-runner orchestrator PORT — that a second
 * container provider is "a new file under `adapters/` plus one branch in the
 * selector". This file is not part of that port: it boots no container, tears
 * none down, meters nothing, and imports nothing from `lib/orchestrator/`. It
 * asks where the WEB PROCESS is, which the fleet has no opinion about.
 *
 * The rule's REACH is nevertheless all of `lib/`, deliberately and correctly — a
 * boundary guard narrowed to the directory it protects is a guard you evade by
 * moving a file. So this exception is registered rather than argued around, and
 * the shape it takes is the one the guard's own note prescribes for the first
 * exception: when a second deployment target lands, the fix is one more branch
 * HERE, which is a small change precisely because this is the only place.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHAT IT DELIBERATELY DOES NOT ANSWER: HOW MANY MACHINES
 * ---------------------------------------------------------------------------
 * `machine_count` is a reading of Fly's Machines API, and no runtime credential
 * in this deployment can take it — `FLY_FLEET_API_TOKEN` is scoped to the CI
 * fleet's OWN organization, which `production-service-stack.md` §7.5 requires to
 * be separate from motir-core's. The one place the count IS asserted is
 * `ci.yml`'s deploy step, with a token that exists only there.
 *
 * Reading `fly.toml` and reporting what it PROMISES is the alternative, and it
 * is a mistake this codebase has already paid for: motir-ai's `fly.toml`
 * promised load spilling onto fresh machines while production ran ONE machine
 * for weeks, because *"Fly Proxy autostop/autostart never creates or destroys
 * Machines for you"*. A config file is a claim about a deployment, not a reading
 * of it. Everything below is read from what the PLATFORM injects into the
 * running process — which is a reading, taken from inside.
 */

/** Which host is serving this process, in provider-neutral terms. */
export interface DeploymentIdentity {
  /**
   * The platform, or `null` when this build is not running on a managed host —
   * a local `next start`, a self-hosted container, a CI runner. `null` is an
   * ordinary answer and not a failure: motir-core is GPL-3.0 and anyone may run
   * it somewhere this file has never heard of.
   */
  provider: 'fly' | null;
  /** The application's name on that platform. */
  app: string | null;
  /** The region this particular instance is in. */
  region: string | null;
  /** This instance's own id — the machine ANSWERING, not the fleet's size. */
  instanceId: string | null;
  /**
   * Where an operator goes to see the deployment itself, or `null` when there is
   * no such place. Constructed from the app name rather than configured, so it
   * cannot drift from the app actually running.
   */
  dashboardUrl: string | null;
}

/** Not deployed anywhere this build can name. */
const UNMANAGED: DeploymentIdentity = {
  provider: null,
  app: null,
  region: null,
  instanceId: null,
  dashboardUrl: null,
};

/**
 * Resolve the running deployment's identity.
 *
 * Keyed on the APP NAME, because that is the value Fly injects into every
 * machine and the one the dashboard URL needs; region and instance id are
 * reported when present and left null when not, rather than defaulted to a
 * placeholder that would read as a measurement.
 */
export function deploymentIdentity(): DeploymentIdentity {
  const app = nonEmpty(process.env['FLY_APP_NAME']);
  if (!app) return UNMANAGED;

  return {
    provider: 'fly',
    app,
    region: nonEmpty(process.env['FLY_REGION']) ?? null,
    instanceId: nonEmpty(process.env['FLY_MACHINE_ID']) ?? null,
    dashboardUrl: `https://fly.io/apps/${app}`,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
