import { OrchestratorApiError, OrchestratorNotConfiguredError } from '../../errors';
import type { FleetInventory, InventoryMachine } from '../../types';
import { flyErrorDetail, flyRequest, readFlyJson, toFlyMachine } from './flyMachines';
import { toPersistentState } from './persistent';

// THE FLY FLEET INVENTORY (Story MOTIR-6906 · MOTIR-6925,
// `docs/decisions/fleet-per-org-pool.md` §5) — every app in Motir's fleet Fly
// organisation, and every machine in each, straight from the Machines API.
//
// ⚠️ ONE TOKEN, SCOPED TO THE ORGANISATION. Listing an organisation's apps needs
// a token that can see the organisation, which the fleet app's own deploy token
// may not be; `FLY_INVENTORY_API_TOKEN` is that org-scoped token, and it falls
// back to `FLY_FLEET_API_TOKEN` for a deployment whose fleet token already is one.
// It reads, destroys and stops across EVERY app in the organisation — the fleet
// app and each organisation's instance app (`agent-instances.md` §7) — because a
// reconciler that needed one token per app would be blind to exactly the app no
// record names, which is the one it exists to see.
//
// ⚠️ A FAILED LISTING THROWS. It is never an empty array: "Fly did not answer"
// read as "nothing is running" is the one mistake that would let a leak hide
// behind an outage (§5).

export interface FlyInventoryConfig {
  readonly token: string;
  /** The fleet Fly organisation's slug (`ci-runner-fleet.md` §7.5). */
  readonly org: string;
}

/**
 * The inventory's configuration, or the typed not-configured error.
 *
 * `FLY_FLEET_ORG` defaults to `FLY_INSTANCES_ORG`, then `motir-fleet` — the one
 * fleet organisation the instance apps are created in, so by default the
 * inventory walks the organisation instances already live in.
 */
export function flyInventoryConfig(): FlyInventoryConfig {
  const token =
    process.env['FLY_INVENTORY_API_TOKEN']?.trim() || process.env['FLY_FLEET_API_TOKEN']?.trim();
  if (!token) {
    throw new OrchestratorNotConfiguredError('set FLY_INVENTORY_API_TOKEN or FLY_FLEET_API_TOKEN');
  }
  return {
    token,
    org:
      process.env['FLY_FLEET_ORG']?.trim() ||
      process.env['FLY_INSTANCES_ORG']?.trim() ||
      'motir-fleet',
  };
}

/** Is the inventory wired on this deployment? Never throws. */
export function isFlyInventoryConfigured(): boolean {
  return Boolean(
    process.env['FLY_INVENTORY_API_TOKEN']?.trim() || process.env['FLY_FLEET_API_TOKEN']?.trim(),
  );
}

function appPath(app: string, rest = ''): string {
  return `/apps/${encodeURIComponent(app)}${rest}`;
}

async function refuse(res: Response): Promise<never> {
  throw new OrchestratorApiError('fly', res.status, flyErrorDetail(await readFlyJson(res)));
}

export const flyFleetInventory: FleetInventory = {
  provider: 'fly',

  async listApps(): Promise<string[]> {
    const { token, org } = flyInventoryConfig();
    const res = await flyRequest(`/apps?org_slug=${encodeURIComponent(org)}`, {
      method: 'GET',
      token,
    });
    if (!res.ok) await refuse(res);
    const body = (await readFlyJson(res)) as { apps?: unknown } | null;
    // A body without an `apps` array is a shape Motir does not understand, which
    // is not the same as an empty organisation — refuse rather than walk nothing.
    if (!body || !Array.isArray(body.apps)) {
      throw new OrchestratorApiError('fly', res.status, 'the app list had no `apps` array');
    }
    return body.apps.flatMap((entry: unknown) => {
      const name = (entry as { name?: unknown } | null)?.name;
      return typeof name === 'string' && name.length > 0 ? [name] : [];
    });
  },

  async listMachines(app: string): Promise<InventoryMachine[]> {
    const { token } = flyInventoryConfig();
    const res = await flyRequest(appPath(app, '/machines'), { method: 'GET', token });
    // The app was deleted between the app list and this read: nothing runs in it.
    if (res.status === 404) return [];
    if (!res.ok) await refuse(res);
    const body = await readFlyJson(res);
    return (Array.isArray(body) ? body : []).flatMap((entry) => {
      const machine = toFlyMachine(entry);
      if (!machine) return [];
      return [
        {
          app,
          machineId: machine.id,
          name: machine.name,
          region: machine.region,
          state: toPersistentState(machine.state),
          createdAt: machine.createdAt,
          metadata: machine.metadata,
        },
      ];
    });
  },

  async destroyMachine(app: string, machineId: string): Promise<void> {
    const { token } = flyInventoryConfig();
    const res = await flyRequest(
      appPath(app, `/machines/${encodeURIComponent(machineId)}?force=true`),
      { method: 'DELETE', token },
    );
    if (res.ok || res.status === 404) return;
    await refuse(res);
  },

  async stopMachine(app: string, machineId: string): Promise<void> {
    const { token } = flyInventoryConfig();
    const res = await flyRequest(appPath(app, `/machines/${encodeURIComponent(machineId)}/stop`), {
      method: 'POST',
      token,
    });
    if (res.ok || res.status === 404) return;
    // Fly refuses to stop a machine that is already stopped; that is the end
    // state asked for, so read the machine rather than the refusal's wording.
    const detail = flyErrorDetail(await readFlyJson(res));
    const current = await flyRequest(appPath(app, `/machines/${encodeURIComponent(machineId)}`), {
      method: 'GET',
      token,
    });
    if (current.status === 404) return;
    if (current.ok) {
      const machine = toFlyMachine(await readFlyJson(current));
      const state = machine ? toPersistentState(machine.state) : 'gone';
      if (state === 'stopped' || state === 'stopping' || state === 'gone') return;
    }
    throw new OrchestratorApiError('fly', res.status, detail);
  },
};
