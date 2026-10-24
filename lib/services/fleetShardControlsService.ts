import type { FleetShard, Prisma } from '@/generated/prisma/client';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { shardAdmissionCeiling } from '@/lib/ciFleet/shardTargets';
import type { PlatformAuditAction } from '@/lib/platform/auditActions';
import { platformPrincipalForStaffEmail, type PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE PLATFORM ADMIN'S ACCOUNT CONTROLS (Story MOTIR-8953 · MOTIR-8972) — beside
// add-shard, in the same `fleet-admin` command: change an account's admission
// ceiling (and clear it), disable an account and re-enable it. Each is one
// locked write and one audit row with the value before and after.
//
// ⚠️ THEY ONLY CHANGE WHAT ADMISSION READS. Admission reads the ceiling and the
// state uncached on every job (`fleetShardRepository.listActiveForKindInTx`), so a
// change takes effect on the next job with no deploy and no cache to clear; it
// still decides where the job goes.
//
// ⚠️ DISABLE LEAVES RUNNING MACHINES ALONE. A disabled account takes no new job;
// a container already on it is polled, settled and reaped through the account as
// before (`fleetShardOrchestratorService.forShard` reaches any state).
//
// ⚠️ RE-ENABLE IS ONLY FROM `disabled`. A `provisioning` account becomes active
// through add-shard alone, on a run with nothing pending.

export interface FleetShardControlResult {
  name: string;
  fleetKind: string;
  /** What changed, as `{ from, to }` — the audit row's metadata. */
  from: number | string | null;
  to: number | string | null;
}

async function resolveOperator(email: string): Promise<PlatformPrincipal> {
  try {
    return await platformPrincipalForStaffEmail(email, 'superadmin');
  } catch (err) {
    if (err instanceof NotPlatformStaffError) {
      throw new FleetShardProvisioningRefusedError([
        `--operator ${email || '(none)'} is not a superadmin on the platform staff`,
      ]);
    }
    throw err;
  }
}

/** Lock the account, check and write it, in one system-context transaction. */
async function change(
  name: string,
  write: (
    shard: FleetShard,
    tx: Prisma.TransactionClient,
  ) => Promise<{ from: number | string | null; to: number | string | null }>,
): Promise<{ shard: FleetShard; from: number | string | null; to: number | string | null }> {
  return withSystemContext(async (tx) => {
    const shard = await fleetShardRepository.lockByNameForUpdateInTx(name, tx);
    if (!shard) throw new FleetShardProvisioningRefusedError([`no fleet account is named ${name}`]);
    const { from, to } = await write(shard, tx);
    return { shard, from, to };
  });
}

async function audit(
  operator: PlatformPrincipal,
  action: PlatformAuditAction,
  shard: FleetShard,
  reason: string,
  from: number | string | null,
  to: number | string | null,
): Promise<FleetShardControlResult> {
  await platformAuditService.record(operator, {
    action,
    targetKind: 'platform',
    targetId: shard.id,
    targetLabel: shard.name,
    reason,
    metadata: { fleetKind: shard.fleetKind, from, to },
  });
  return { name: shard.name, fleetKind: shard.fleetKind, from, to };
}

export const fleetShardControlsService = {
  /**
   * Set the account's admission ceiling, or clear it (`null`) to return it to the
   * one derived from its limits. Refuses a value below 1 or above the account's
   * recorded provider limit (`shardAdmissionCeiling` of its vCPU quota and
   * machine limit); never writes the limit itself.
   */
  async setCeiling(
    name: string,
    ceiling: number | null,
    operatorEmail: string,
  ): Promise<FleetShardControlResult> {
    const operator = await resolveOperator(operatorEmail);
    if (ceiling !== null && !(Number.isInteger(ceiling) && ceiling >= 1)) {
      throw new FleetShardProvisioningRefusedError([
        '--ceiling must be a whole number of at least 1',
      ]);
    }
    const { shard, from, to } = await change(name, async (row, tx) => {
      if (ceiling !== null) {
        const limit = shardAdmissionCeiling({
          vcpuQuota: row.vcpuQuota,
          machineLimit: row.machineLimit,
        });
        if (limit === null) {
          throw new FleetShardProvisioningRefusedError([
            `${row.name} records no provider limit, so no ceiling can be checked against it`,
          ]);
        }
        if (ceiling > limit) {
          throw new FleetShardProvisioningRefusedError([
            `--ceiling ${ceiling} is above ${row.name}'s provider limit of ${limit}`,
          ]);
        }
      }
      await fleetShardRepository.setAdmissionCeilingOverrideInTx(row.id, ceiling, tx);
      return { from: row.admissionCeilingOverride, to: ceiling };
    });
    return audit(
      operator,
      'fleet.shard.ceiling',
      shard,
      ceiling === null
        ? `fleet-admin set-ceiling ${shard.name} --clear`
        : `fleet-admin set-ceiling ${shard.name} --ceiling ${ceiling}`,
      from,
      to,
    );
  },

  /** Take an `active` account out of admission. Running containers are untouched. */
  async disable(
    name: string,
    reason: string,
    operatorEmail: string,
  ): Promise<FleetShardControlResult> {
    const operator = await resolveOperator(operatorEmail);
    if (!reason.trim()) throw new FleetShardProvisioningRefusedError(['--reason is required']);
    const { shard, from, to } = await change(name, async (row, tx) => {
      if (row.state !== 'active') {
        throw new FleetShardProvisioningRefusedError([
          `${row.name} is ${row.state}; only an active account can be disabled`,
        ]);
      }
      await fleetShardRepository.updateState(row.id, 'disabled', tx);
      return { from: row.state, to: 'disabled' };
    });
    return audit(operator, 'fleet.shard.disable', shard, reason.trim(), from, to);
  },

  /** Put a `disabled` account back in admission, from the next job. */
  async enable(name: string, operatorEmail: string): Promise<FleetShardControlResult> {
    const operator = await resolveOperator(operatorEmail);
    const { shard, from, to } = await change(name, async (row, tx) => {
      if (row.state !== 'disabled') {
        throw new FleetShardProvisioningRefusedError([
          `${row.name} is ${row.state}; only a disabled account can be re-enabled`,
        ]);
      }
      await fleetShardRepository.updateState(row.id, 'active', tx);
      return { from: row.state, to: 'active' };
    });
    return audit(
      operator,
      'fleet.shard.enable',
      shard,
      `fleet-admin enable ${shard.name}`,
      from,
      to,
    );
  },
};
