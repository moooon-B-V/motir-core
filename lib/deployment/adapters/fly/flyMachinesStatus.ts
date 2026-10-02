import 'server-only';

import { EXPECTED_STARTED_MACHINES } from '../../expectedMachines';
import {
  DEPLOYMENT_STATUS_TIMEOUT_MS,
  type DeploymentGroupStatus,
  type DeploymentStatus,
  type DeploymentStatusProvider,
} from '../../deploymentStatus';

// THE ONLY MODULE IN `motir-core` THAT ASKS FLY HOW MANY OF ITS OWN MACHINES RUN
// (MOTIR-7332). The deployment-status port's Fly adapter, the twin of
// `lib/publicAddresses/adapters/fly/flyCertificates.ts` for a different question.
//
// ⚠️ ITS TOKEN IS READ-ONLY AND HAS NO FALLBACK. `FLY_DEPLOYMENT_READ_TOKEN` is an
// org-scoped READ-ONLY token, minted on MOTIR-7331 and proven to be refused a
// machine stop (403). The operator console's stance is read and link, never
// remediate, so this adapter sends GET and nothing else, and there is no
// `FLY_API_TOKEN` to fall back to: a deploy-capable token here would hand a page
// view the power to change production.
//
// ── The wire format ────────────────────────────────────────────────────────
//
// `GET /v1/apps/{app}/machines` returns an array of machines. This adapter maps
// `state`, `config.metadata.fly_process_group`, `config.standbys` (non-empty on
// a standby, which names the machines it watches), `image_ref`
// (`registry`, `repository`, `tag`, `digest`) and `updated_at`. CI reads the
// same endpoint in `scripts/machinePool.mjs`, and the standby and gone-state
// rules below are that module's, so the board and the deploy guard count alike.

const FLY_API = 'https://api.machines.dev/v1';

/** States that hold no capacity: a release machine being reaped, a rolling replace. */
const GONE_STATES = new Set(['destroyed', 'destroying', 'replacing']);

/** The machine list's fields this adapter reads. */
interface FlyMachineRow {
  state?: unknown;
  updated_at?: unknown;
  image_ref?: { tag?: unknown; digest?: unknown } | null;
  config?: {
    metadata?: { fly_process_group?: unknown } | null;
    standbys?: unknown;
  } | null;
}

interface FlyStatusConfig {
  readonly token: string;
  readonly app: string;
}

/** The config, read at CALL time so a deployment without it boots and simply cannot read. */
function flyStatusConfig(): FlyStatusConfig | null {
  const token = process.env['FLY_DEPLOYMENT_READ_TOKEN'];
  const app = process.env['FLY_APP_NAME'];
  if (!token || !app) return null;
  return { token, app };
}

/** Read motir-core's own machines and fold them into the port's neutral shape. */
async function readFlyDeploymentStatus(): Promise<DeploymentStatus> {
  const config = flyStatusConfig();
  if (!config)
    throw new Error('deployment status: FLY_DEPLOYMENT_READ_TOKEN or FLY_APP_NAME unset');

  const res = await fetch(`${FLY_API}/apps/${encodeURIComponent(config.app)}/machines`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(DEPLOYMENT_STATUS_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`deployment status: Fly answered ${res.status}`);

  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('deployment status: machine list is not an array');
  return foldMachines(body as FlyMachineRow[]);
}

/**
 * Count each group's machines and collect the releases the running ones carry.
 * Exported for the adapter's own test, which feeds it recorded responses.
 */
export function foldMachines(machines: readonly FlyMachineRow[]): DeploymentStatus {
  const counts = new Map<string, { started: number; total: number }>();
  for (const name of Object.keys(EXPECTED_STARTED_MACHINES)) {
    counts.set(name, { started: 0, total: 0 });
  }
  // release → the latest `updated_at` seen on a running machine carrying it.
  const releases = new Map<string, number>();

  for (const machine of machines) {
    if (typeof machine !== 'object' || machine === null) {
      throw new Error('deployment status: a machine row is not an object');
    }
    const state = typeof machine.state === 'string' ? machine.state : '';
    if (GONE_STATES.has(state) || isStandby(machine)) continue;

    const group = machine.config?.metadata?.fly_process_group;
    const name = typeof group === 'string' && group !== '' ? group : '(ungrouped)';
    const entry = counts.get(name) ?? { started: 0, total: 0 };
    entry.total += 1;
    if (state === 'started') {
      entry.started += 1;
      // Releases are read from RUNNING machines only: a stopped machine left on
      // an old image is not a deploy that stopped part-way.
      const release = releaseOf(machine);
      if (release) {
        const at = Date.parse(typeof machine.updated_at === 'string' ? machine.updated_at : '');
        const seen = releases.get(release);
        const when = Number.isNaN(at) ? 0 : at;
        if (seen === undefined || when > seen) releases.set(release, when);
      }
    }
    counts.set(name, entry);
  }

  const groups: DeploymentGroupStatus[] = [...counts].map(([name, c]) => ({
    name,
    started: c.started,
    total: c.total,
    expected: EXPECTED_STARTED_MACHINES[name] ?? 0,
  }));
  return {
    groups,
    releases: [...releases].sort((a, b) => b[1] - a[1]).map(([release]) => release),
  };
}

/** A standby names the machines it watches; nothing else carries the key. */
function isStandby(machine: FlyMachineRow): boolean {
  const standbys = machine.config?.standbys;
  return Array.isArray(standbys) && standbys.length > 0;
}

/** The release a machine runs: its image tag, or its digest when it has no tag. */
function releaseOf(machine: FlyMachineRow): string | null {
  const tag = machine.image_ref?.tag;
  if (typeof tag === 'string' && tag !== '') return tag;
  const digest = machine.image_ref?.digest;
  if (typeof digest === 'string' && digest !== '') return digest;
  return null;
}

/** The Fly binding of the deployment-status port. */
export const flyDeploymentStatusProvider: DeploymentStatusProvider = {
  configured: () => flyStatusConfig() !== null,
  read: readFlyDeploymentStatus,
};
