import { Prisma, type MonitorConnection } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { MonitorConnectionAlreadyExistsError } from '@/lib/monitors/errors';

// Monitor-connection repository — single Prisma operations on the
// `monitor_connection` table (Story MOTIR-4926 · MOTIR-5258): the BINDING
// between one Motir project and one monitored external project. The service
// (`monitorConnectionService`, MOTIR-5260) owns orchestration, transactions and
// DTO mapping; this leaf holds none of that.
//
// ⚠️ NO ROW HERE CARRIES A SECRET. The credential lives on the GRANT
// (`monitor_installation`), because a provider authorises at the organisation
// tier and one grant covers every project in it — so a copy per binding would be
// N copies of one secret to rotate. A caller that needs the token asks
// `monitorInstallationRepository.findCredentialById`, which is the one door.

export interface CreateMonitorConnectionInput {
  installationId: string;
  projectId: string;
  /** Carried on the BINDING rather than joined through the grant — the shape
   *  `github_repo` was migrated to, and what lets the RLS policy be a column
   *  comparison instead of a per-row subquery over the parent. */
  workspaceId: string;
  externalProjectId: string;
  externalProjectSlug: string;
}

/** A binding joined to the fields of its grant that a render needs — and to none
 *  of the fields it must never see. The health triple is the grant's, and it is
 *  what the settings row draws a `degraded` state from. */
export type MonitorConnectionWithGrant = MonitorConnection & {
  installation: {
    id: string;
    provider: string;
    installationId: string;
    health: string;
    healthReason: string | null;
    healthCheckedAt: Date | null;
    metadata: Prisma.JsonValue | null;
  };
};

const GRANT_SELECT = {
  id: true,
  provider: true,
  installationId: true,
  health: true,
  healthReason: true,
  healthCheckedAt: true,
  metadata: true,
} as const;

/** Prisma's unique-constraint violation code. Named rather than inlined so the
 *  one place that recognises it is greppable (the `publicAddresses` precedent). */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * The unique index behind the already-bound refusal, BY NAME.
 *
 * ⚠️ IT IS TRUNCATED, and the truncation is the whole reason this is a named
 * constant rather than a substring guessed at the call site. Postgres caps an
 * identifier at 63 bytes, so the index Prisma generates for
 * `@@unique([projectId, installationId, externalProjectId])` is
 * `…_external_proj_key` — not `…_external_project_id_key`. A guard written
 * against the plausible spelling matches nothing, falls through, and re-throws
 * the raw ORM error: the second failure this repository's own concurrency test
 * caught, after the first (`meta.target`) was fixed. Both were invisible to the
 * type checker and to every serial test.
 */
const BINDING_UNIQUE_INDEX = 'monitor_connection_project_id_installation_id_external_proj_key';

/**
 * Is this thrown error the unique-constraint violation on
 * `(project_id, installation_id, external_project_id)`?
 *
 * ⚠️ IT CHECKS THE CONSTRAINT, NOT JUST THE CODE. A `P2002` from this table can
 * only be that index today — it is the table's only unique constraint — but
 * "today" is the assumption that rots: a second unique index added later would
 * start reporting its violations as an already-bound refusal, and a customer
 * would be told to disconnect a binding that had nothing to do with the
 * collision.
 *
 * ⚠️ AND THE CONSTRAINT NAME IS NOT IN `meta.target` UNDER THIS CLIENT.
 * MEASURED on the live error (Prisma 7.8 + the driver adapter): `meta` carries
 * `{ modelName, driverAdapterError: { cause: { originalCode: '23505',
 * originalMessage: 'duplicate key value violates unique constraint "<name>"',
 * kind: 'UniqueConstraintViolation' } } }` and `meta.target` is UNDEFINED. A
 * guard written against `meta.target` alone therefore matches nothing and lets
 * the raw Prisma error cross the boundary — which is exactly what this
 * repository's first draft did, and what its own concurrency test caught. Both
 * places are read here, newest first, because the shape Prisma reports is not
 * part of its public typings and a client upgrade may move it back.
 *
 * The last arm falls back to TRUE for a `P2002` from this table with no readable
 * constraint, on the `publicAddresses` precedent's reasoning: the alternative
 * trades a correct-in-every-observed-case answer for a raw ORM error reaching a
 * caller that cannot render one.
 */
function isBindingUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== PRISMA_UNIQUE_VIOLATION) return false;

  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { originalMessage?: unknown } };
      }
    | undefined;

  // Prisma's older shape: `target` is the column list, or the index name.
  const target = meta?.target;
  const namesTheIndex = (value: string): boolean =>
    value.includes(BINDING_UNIQUE_INDEX) || value.includes('external_project');
  if (Array.isArray(target)) return target.some((t) => namesTheIndex(String(t)));
  if (typeof target === 'string') return namesTheIndex(target);

  // The driver-adapter shape (MEASURED on Prisma 7.8): the constraint name
  // arrives inside Postgres's own message, under its TRUNCATED identifier.
  const driverMessage = meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof driverMessage === 'string') return namesTheIndex(driverMessage);

  return true;
}

export const monitorConnectionRepository = {
  /**
   * Bind one monitored project to one Motir project.
   *
   * ⚠️ THE COLLISION IS CAUGHT FROM THE DATABASE, NOT PREVENTED BY A READ. Two
   * authorisation returns can land at once, so the
   * `(project_id, installation_id, external_project_id)` unique index is what
   * makes exactly one win — and this method translates the loser's `P2002` into
   * the typed `MONITOR_CONNECTION_ALREADY_EXISTS` refusal so the caller gets a
   * renderable answer rather than a raw Prisma error or a generic 500.
   *
   * A check-then-write guard in the service would pass every serial test and
   * fail only under a warm pool, which is the exact shape the locking rule
   * exists to forbid. The guarding read is a courtesy; the constraint is the
   * mechanism.
   */
  async create(
    input: CreateMonitorConnectionInput,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorConnection> {
    try {
      return await tx.monitorConnection.create({ data: input });
    } catch (error) {
      if (isBindingUniqueViolation(error)) {
        throw new MonitorConnectionAlreadyExistsError(input.projectId, input.externalProjectId);
      }
      throw error;
    }
  },

  /** The project's bound monitored projects, each with the grant fields a render
   *  needs and none it must not see. Ordered deterministically by slug so the
   *  settings room's list does not reshuffle between reads. */
  async listForProject(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MonitorConnectionWithGrant[]> {
    const client = tx ?? dbRead;
    return client.monitorConnection.findMany({
      where: { projectId },
      include: { installation: { select: GRANT_SELECT } },
      orderBy: [{ externalProjectSlug: 'asc' }, { id: 'asc' }],
    });
  },

  /** One binding by id — the disconnect path's read, which runs inside the
   *  disconnect transaction and guards the delete. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<MonitorConnection | null> {
    return tx.monitorConnection.findUnique({ where: { id } });
  },

  /** How many bindings a grant still has. The disconnect path reads it to decide
   *  whether the grant itself is now unused — which is what "disconnecting leaves
   *  no orphaned row" means in practice: the last binding's removal takes the
   *  credential with it. */
  async countForInstallation(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.monitorConnection.count({ where: { installationId } });
  },

  /** Every binding on a grant — the credential-lifecycle path's read (MOTIR-5261),
   *  which reports a degraded grant against the rows a person actually sees. */
  async listForInstallation(
    installationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MonitorConnection[]> {
    const client = tx ?? dbRead;
    return client.monitorConnection.findMany({
      where: { installationId },
      orderBy: [{ externalProjectSlug: 'asc' }, { id: 'asc' }],
    });
  },

  /** Remove one binding. `deleteMany` (not `delete`) so a retried disconnect
   *  after the row is gone is an idempotent no-op (count 0) rather than a `P2025`
   *  throw. Returns the delete count. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.monitorConnection.deleteMany({ where: { id } });
    return result.count;
  },
};
