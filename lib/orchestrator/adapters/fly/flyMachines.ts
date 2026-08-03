import {
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
} from '../../errors';

// The FLY MACHINES boundary (Story MOTIR-1916 · MOTIR-1921) — the only module in
// the repository that speaks Fly, and the reason the rest of the fleet does not
// have to.
//
// Everything above `lib/orchestrator/adapters/fly/` sees `ContainerHandle` and
// `ContainerUsage` (§4). Everything in here is `fetch` against
// `api.machines.dev`. `tests/ciFleet/orchestratorPortBoundary.test.ts` asserts
// that line as a dependency guard — the ADR's rule 1 — because the ADR's whole
// claim to REVERSIBILITY (§3: "if A's cost basis or capacity ever binds, B1 is
// the documented migration target") is worth exactly as much as that boundary is
// real.
//
// ⚠️ THE FLEET RUNS IN A SEPARATE FLY ORGANIZATION (§7.5), so it has its OWN API
// token — `FLY_FLEET_API_TOKEN`, never the token `motir-ai` or `motir-gateway`
// deploy with. This is not tidiness. Fly's private networking is
// ORGANIZATION-SCOPED and on by default: booting the fleet inside Motir's
// existing org would put every customer's CI container on the same 6PN as
// `motir-ai` and `motir-gateway`, reachable over `.internal` with no
// authentication step in between. A token that could reach the production org is
// the one thing that could quietly undo that, so the config accessor names a
// distinct variable and there is no fallback to a general Fly token.
//
// Config is read at CALL time, never module load (`appAuth.ts`'s contract): a
// self-hosted deploy that never provisions containers must not crash on boot, it
// must simply be unable to reach this path.

const FLY_MACHINES_API = 'https://api.machines.dev/v1';

/** Fly's own name for a machine that has been destroyed or never existed. */
const FLY_STATE_DESTROYED = 'destroyed';

/** The Fly states that mean "this machine will not run any more work". */
const TERMINAL_STATES = new Set(['stopped', 'suspended', FLY_STATE_DESTROYED, 'failed']);

/** Machine states Fly reports while the machine is still coming up. */
const PRE_START_STATES = new Set(['created', 'starting', 'replacing']);

export interface FlyFleetConfig {
  readonly token: string;
  readonly app: string;
  readonly region: string;
  /** The runner image, DIGEST-PINNED (§11 fixes that it is; the digest itself is
   *  deployment configuration). */
  readonly image: string;
}

/**
 * The fleet's Fly configuration, or the typed not-configured error.
 *
 * `FLY_FLEET_REGION` defaults to `iad` because §11 fixes the fleet there —
 * co-located with Neon and `motir-core`, for the same reason `motir-ai`'s region
 * was corrected to `iad` (MOTIR-1007). It is still a variable rather than a
 * constant so a second region is configuration, not a code change; the rate
 * table already carries a row per region.
 */
export function flyFleetConfig(): FlyFleetConfig {
  const token = process.env['FLY_FLEET_API_TOKEN'];
  const app = process.env['FLY_FLEET_APP'];
  const image = process.env['MOTIR_RUNNER_IMAGE'];
  const region = process.env['FLY_FLEET_REGION']?.trim() || 'iad';
  const missing: string[] = [];
  if (!token) missing.push('FLY_FLEET_API_TOKEN');
  if (!app) missing.push('FLY_FLEET_APP');
  if (!image) missing.push('MOTIR_RUNNER_IMAGE');
  if (missing.length > 0) {
    throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  }
  return { token: token as string, app: app as string, region, image: image as string };
}

/**
 * Is the fleet's Fly orchestrator WIRED on this deployment? Never throws — the
 * selector uses it to decide, and a self-hosted build answering "no" is a
 * first-class state, not a misconfiguration.
 *
 * ⚠️ IT ANSWERS "IS THIS DEPLOYMENT WIRED FOR THE FLEET?" — NOT "CAN IT BOOT?".
 * `docs/decisions/fleet-image-pull.md` §7 SETTLES this deliberately, and settles
 * it as a presence check that keeps its name honest through a comment rather
 * than by changing what it does. The distinction is not academic: MOTIR-1980
 * shipped a fleet that was code-complete and could not boot a single container,
 * and this predicate returned `true` throughout, because three non-empty strings
 * were all it ever claimed to check.
 *
 * It stays a presence check because of WHERE it is called. `getOrchestrator()`
 * consults it on EVERY provision and `isOrchestratorConfigured()` on every tick
 * of the minute-granularity sweep; it is synchronous, and `lib/orchestrator/
 * index.ts` documents why it must never throw or block. Making it mean
 * "bootable" would put a registry round-trip on the hot boot path — inside
 * `docs/decisions/ci-runner-fleet.md` §6's ≤30s p50 budget — and would make a
 * registry blip indistinguishable from a deployment that was never configured.
 *
 * **The question it does not answer has its own function**: `verifyFleetBootable()`
 * (`lib/orchestrator/index.ts`), async, consumed by the boot preflight in
 * `system.daily-health-check` and never by the per-job path. If you are about to
 * strengthen THIS function, that one is what you are looking for.
 */
export function isFlyFleetConfigured(): boolean {
  return (
    Boolean(process.env['FLY_FLEET_API_TOKEN']) &&
    Boolean(process.env['FLY_FLEET_APP']) &&
    Boolean(process.env['MOTIR_RUNNER_IMAGE'])
  );
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One Fly Machine, narrowed to what the adapter reads. */
export interface FlyMachine {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly region: string;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  /** Motir's own tags on the machine, used by the reaper to recognise its own
   *  containers without consulting in-process state. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Fly's `events` array — "provide[s] log of what's happened with this
   *  Machine", each entry timestamped. The source of PROVIDER-ATTESTED start and
   *  stop instants (§5), which is what makes the monthly reconciliation an audit
   *  rather than a comparison of two estimates — and, since MOTIR-2025, of the
   *  container's EXIT CODE, which is the whole diagnostic channel for a workload
   *  that reports to nobody. */
  readonly events: ReadonlyArray<{
    type: string;
    status: string;
    timestamp: Date | null;
    /** From this event's `request.exit_event`; null on every event that is not an
     *  exit, and on an exit Fly described without one. */
    exitCode: number | null;
  }>;
}

export interface CreateMachineInput {
  readonly name: string;
  readonly region: string;
  readonly image: string;
  readonly cpuKind: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly env: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorDetail(body: unknown): string {
  const record = asRecord(body);
  const message = record?.['error'] ?? record?.['message'];
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

/**
 * Is this Fly refusal about the IMAGE rather than about Fly?
 *
 * ⚠️ FLY'S OWN DIALECT, MEASURED — not guessed. `docs/decisions/
 * fleet-image-pull.md` §2.2 recorded, and MOTIR-2006 re-measured live on
 * 2026-08-02 against a real app, that a machine-create with an unpullable
 * reference returns **HTTP 400** with the body:
 *
 *   {"error":"failed to get manifest ghcr.io/moooon-b-v/motir-sandbox:claude: unauthorized"}
 *
 * and creates NO machine — Fly resolves the manifest before it allocates
 * anything. The other three phrasings are the neighbouring shapes of the same
 * fault (an unknown digest, a pull that fails after resolution).
 *
 * ⚠️ MATCHED ON THE IMAGE-SPECIFIC PHRASING, NEVER ON `unauthorized` ALONE.
 * `unauthorized` on its own is what Fly says when MOTIR's OWN `FLY_FLEET_API_TOKEN`
 * is wrong — the opposite diagnosis, and mis-reporting it as an image problem
 * would send an operator to the registry while the token rots.
 */
function isImagePullRefusal(detail: string): boolean {
  return (
    /failed to (get|pull|resolve) (the )?manifest/i.test(detail) ||
    /manifest unknown/i.test(detail) ||
    /failed to pull image/i.test(detail) ||
    /image not found/i.test(detail)
  );
}

function parseDate(value: unknown): Date | null {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  // Fly's machine EVENTS timestamp in epoch MILLISECONDS, while the machine's own
  // `created_at` / `updated_at` are RFC 3339 strings. Both shapes land here.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The container's own exit status out of one Fly machine event.
 *
 * ⚠️ THE GUEST'S CODE WINS, AND THE DISTINCTION IS THE WHOLE POINT. Fly's
 * `request.exit_event` carries two numbers: `guest_exit_code` is what the
 * process INSIDE the machine returned — the indexer's own
 * `src/indexer/exitCodes.ts` value, the thing the dispatcher has to classify —
 * while `exit_code` is the machine-level code its init reports. They agree on
 * the ordinary paths and diverge exactly where it matters (a signalled or
 * OOM-killed guest), so reading the machine-level one would quietly turn "the
 * indexer refused the credential" into a number about Fly's supervisor.
 *
 * Both are read because Fly has populated the pair differently over time and a
 * missing `guest_exit_code` must degrade to the other number rather than to
 * `null` — a code we could have had is worse lost than approximated.
 */
function exitCodeOfEvent(event: Record<string, unknown>): number | null {
  const exitEvent = asRecord(asRecord(event['request'])?.['exit_event']);
  if (!exitEvent) return null;
  for (const key of ['guest_exit_code', 'exit_code']) {
    const value = exitEvent[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

/** Fly's machine JSON → the shape above, or null when it is not a machine. */
export function toFlyMachine(body: unknown): FlyMachine | null {
  const record = asRecord(body);
  const id = record?.['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const rawEvents = record?.['events'];
  const events = (Array.isArray(rawEvents) ? rawEvents : []).flatMap((entry) => {
    const event = asRecord(entry);
    if (!event) return [];
    return [
      {
        type: typeof event['type'] === 'string' ? event['type'] : '',
        status: typeof event['status'] === 'string' ? event['status'] : '',
        timestamp: parseDate(event['timestamp']),
        exitCode: exitCodeOfEvent(event),
      },
    ];
  });
  return {
    id,
    name: typeof record?.['name'] === 'string' ? record['name'] : '',
    state: typeof record?.['state'] === 'string' ? record['state'] : '',
    region: typeof record?.['region'] === 'string' ? record['region'] : '',
    createdAt: parseDate(record?.['created_at']),
    updatedAt: parseDate(record?.['updated_at']),
    metadata: stringMap(asRecord(record?.['config'])?.['metadata']),
    events,
  };
}

/** Has this machine finished, one way or another? */
export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** Is the machine still on its way up (so a boot wait should keep waiting)? */
export function isPreStartState(state: string): boolean {
  return PRE_START_STATES.has(state);
}

/**
 * The instant the machine actually STARTED, from Fly's own event log, falling
 * back to `created_at`.
 *
 * The event log is preferred because §5 wants provider-attested timestamps: the
 * gap between `created` and `start` is the boot latency §6 budgets, and reading
 * it from our own clock would measure our polling interval instead of Fly's
 * boot. The fallback exists because the events array is not guaranteed to be
 * populated on every read, and a usage row with a slightly pessimistic start is
 * better than one with none — it over-states Motir's own cost, never the
 * customer's.
 */
export function startedAtOf(machine: FlyMachine): Date | null {
  for (const event of machine.events) {
    if (event.type === 'start' && event.timestamp) return event.timestamp;
  }
  return null;
}

/**
 * The container's exit code, from the LATEST exit event that reported one.
 *
 * `null` when the machine never exited, when Fly kept no exit event, or when the
 * machine is already gone — all three are the port's "stopped, code unknown",
 * which `ContainerStatus.exitCode` documents as a real answer rather than a gap.
 *
 * LATEST rather than first, matching {@link stoppedAtOf}: `restart: { policy:
 * 'no' }` means a fleet machine exits once, but an event log that somehow holds
 * two must report the one that ended the container, not the one it survived.
 * Events with no timestamp cannot be ordered, so they lose to any that can be —
 * and are used only when nothing else reported a code at all.
 */
export function exitCodeOf(machine: FlyMachine): number | null {
  let latest: { at: number; code: number } | null = null;
  let undated: number | null = null;
  for (const event of machine.events) {
    if (event.type !== 'exit' || event.exitCode === null) continue;
    if (!event.timestamp) {
      if (undated === null) undated = event.exitCode;
      continue;
    }
    const at = event.timestamp.getTime();
    if (latest === null || at > latest.at) latest = { at, code: event.exitCode };
  }
  return latest?.code ?? undated;
}

/** The instant the machine stopped or was destroyed, from Fly's event log. */
export function stoppedAtOf(machine: FlyMachine): Date | null {
  let latest: Date | null = null;
  for (const event of machine.events) {
    if (event.type !== 'exit' && event.type !== 'destroy' && event.type !== 'stop') continue;
    if (!event.timestamp) continue;
    if (latest === null || event.timestamp.getTime() > latest.getTime()) latest = event.timestamp;
  }
  return latest;
}

/**
 * One Machines-API call — the adapter's ONLY `fetch`, so
 * {@link ORCHESTRATOR_REQUEST_TIMEOUT_MS} is applied once and a new call site
 * cannot forget it (`docs/jobs.md` rule 3, MOTIR-2011).
 *
 * Unbounded, a Fly that accepts the connection and never answers is waited on
 * until the platform kills the whole invocation — and on the boot path that
 * happens AFTER the JIT config is minted and possibly after the machine is
 * created, so the kill leaves both a registered runner and a live container with
 * nobody supervising either. Bounded, the same hang is an error the boot path
 * settles and the reaper can still catch the container.
 */
async function request(
  path: string,
  init: { method: string; token: string; body?: string },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORCHESTRATOR_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${FLY_MACHINES_API}${path}`, {
      method: init.method,
      headers: {
        accept: 'application/json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new OrchestratorTimeoutError('fly', ORCHESTRATOR_REQUEST_TIMEOUT_MS);
    }
    throw new OrchestratorApiError('fly', null, err instanceof Error ? err.message : 'unknown');
  } finally {
    clearTimeout(timer);
  }
}

// ── The client ──────────────────────────────────────────────────────────────

export const flyMachinesClient = {
  /**
   * Create ONE Machine.
   *
   * ⚠️ THE THREE SINGLE-USE GUARANTEES (§7.1) — two of them are in this request
   * body, and they are independent on purpose so that no single failure leaks a
   * container:
   *
   *   * `auto_destroy: true` — "the Machine destroys itself once it's complete".
   *   * `restart: { policy: 'no' }` — so an exiting process is a DESTROYED
   *     machine, not a restarted one. Without it `auto_destroy` would race a
   *     restart policy that keeps bringing the runner back, and a runner that
   *     comes back after its ephemeral job has de-registered is a machine that
   *     idles and bills until something notices.
   *
   * (The third is the JIT config itself, minted one job at a time; the fourth
   * backstop is the reaper, for the case this process dies mid-flight.)
   *
   * ⚠️ HOW THE IMAGE IS AUTHENTICATED: IT ISN'T, AND THAT IS THE DECISION.
   * `docs/decisions/fleet-image-pull.md` §1 fixes that the runner image is
   * PUBLIC on GHCR and pulled ANONYMOUSLY; §2.3 records why there was never an
   * alternative — the Machines API `config` object has no `registry_auth`, no
   * `docker_auth`, no `image_pull_secret` and no credential field of any name,
   * so `image: input.image` below is the whole of the pull mechanism and no
   * plumbing was added here. That absence is load-bearing rather than an
   * omission, which is why it is written down at the payload instead of left to
   * be re-derived by whoever next reads this and wonders where the credential
   * went. A CLOSED-source image does not join this path: §5 mirrors it into
   * `registry.fly.io`, which Fly authenticates itself, still with nothing here.
   */
  async createMachine(input: CreateMachineInput): Promise<FlyMachine> {
    const { token, app } = flyFleetConfig();
    const res = await request(`/apps/${encodeURIComponent(app)}/machines`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: input.name,
        region: input.region,
        config: {
          image: input.image,
          guest: {
            cpu_kind: input.cpuKind,
            cpus: input.cpus,
            memory_mb: input.memoryMb,
          },
          env: { ...input.env },
          metadata: { ...input.metadata },
          auto_destroy: true,
          restart: { policy: 'no' },
        },
      }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      // §6.2 — the DISTINGUISHABLE reason. An unpullable image and an
      // unreachable Fly both arrive here as a non-2xx; only the body tells them
      // apart, and only here is the body still in scope.
      const detail = errorDetail(body);
      if (isImagePullRefusal(detail)) {
        throw new OrchestratorImageUnpullableError('fly', res.status, input.image, detail);
      }
      throw new OrchestratorApiError('fly', res.status, detail);
    }
    const machine = toFlyMachine(body);
    if (!machine) {
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'machine create returned an unexpected shape',
      );
    }
    return machine;
  },

  /** Read one Machine. Returns null on 404 — a destroyed machine is GONE, and on
   *  the happy path that is the expected observation, not a failure. */
  async getMachine(id: string): Promise<FlyMachine | null> {
    const { token, app } = flyFleetConfig();
    const res = await request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`,
      { method: 'GET', token },
    );
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, errorDetail(body));
    return toFlyMachine(body);
  },

  /**
   * Destroy a Machine, forcibly. IDEMPOTENT against one already gone (404 is the
   * desired end state), because the `finally` path and the reaper can both reach
   * the same machine and a throw from the second would turn a tidy-up into an
   * incident.
   *
   * `force=true` because the whole point is a guarantee: a machine mid-job is
   * exactly the machine that most needs destroying when its timeout expires, and
   * a graceful stop that the customer's own workflow can refuse is not a
   * guarantee at all.
   */
  async destroyMachine(id: string): Promise<void> {
    const { token, app } = flyFleetConfig();
    const res = await request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}?force=true`,
      { method: 'DELETE', token },
    );
    if (res.ok || res.status === 404) return;
    throw new OrchestratorApiError('fly', res.status, errorDetail(await readJson(res)));
  },

  /**
   * Every Machine in the fleet app — the REAPER's read.
   *
   * It asks the PROVIDER what exists rather than asking Motir's own tables what
   * it thinks it booted, and that inversion is the entire value of the reaper:
   * the case it exists for is the orchestrator process having died between
   * provision and teardown, which is precisely the case in which Motir's own
   * record is the thing that is wrong.
   */
  async listMachines(): Promise<FlyMachine[]> {
    const { token, app } = flyFleetConfig();
    const res = await request(`/apps/${encodeURIComponent(app)}/machines`, {
      method: 'GET',
      token,
    });
    const body = await readJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, errorDetail(body));
    const entries = Array.isArray(body) ? body : [];
    return entries.flatMap((entry) => {
      const machine = toFlyMachine(entry);
      return machine ? [machine] : [];
    });
  },
};
