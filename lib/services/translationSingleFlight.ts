import { createHash } from 'node:crypto';
import { TRANSLATE_DEADLINE_MS } from '@/lib/ai/translateClient';
import type { Locale } from '@/lib/i18n/locales';
import { workItemTranslationRepository } from '@/lib/repositories/workItemTranslationRepository';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';

// THE SINGLE-FLIGHT GUARD of the translation door (Story MOTIR-7735 · Subtask
// MOTIR-8120): one Postgres advisory lock per `(organisation, work item, field,
// text revision, target language)`, held ACROSS the motir-ai job.
//
// ⚠️ WHY A LOCK AND NOT THE STORE'S INSERT-IF-ABSENT. The store makes two racing
// writers leave ONE row; it does not stop both of them from calling motir-ai
// first, and each call is charged. Only a lock held from before the send until
// after the keep stops the second press from paying again — which is why the
// door re-reads the store once the lock is held.
//
// THE MECHANISM is the repository's existing one (`pg_advisory_xact_lock`, as
// `folderRepository.lockStructure` takes it), inside ONE workspace-bound
// interactive transaction that runs nothing but the lock statements while the
// job is awaited. The store's own reads and writes open their own transactions,
// so a press holds at most two pooled connections and the lock's never queries.
//
// THE TRANSACTION TIMEOUT is Prisma's 5 s by default, which a 45 s job would
// outlive — the transaction would expire, the locks would drop mid-job and a
// waiting press would send a second job. So this is the seventh
// `TransactionBudget` caller, and its budget is argued from a WAIT on a third
// party, as the runner-group sync's is: the lock wait plus the job's deadline
// plus the keep writes.

/** How long a press may WAIT for another press's lock — longer than the job's deadline. */
export const FIELD_LOCK_WAIT_MS = TRANSLATE_DEADLINE_MS + 15_000;
/** The room the holder's own keep writes get after its job answers. */
const KEEP_MARGIN_MS = 30_000;
/** The whole lock transaction: the wait, the job, the keeps. */
export const FIELD_LOCK_TRANSACTION_MS =
  FIELD_LOCK_WAIT_MS + TRANSLATE_DEADLINE_MS + KEEP_MARGIN_MS;

/** The parts one field's lock is keyed on. The text revision is what makes an edit a new key. */
export interface FieldLockKeyParts {
  organizationId: string;
  workItemId: string;
  fieldRef: string;
  sourceHash: string;
  targetLanguage: Locale;
}

/** The single-flight key for one field: a digest of every part, so no part can collide. */
export function fieldLockKey(parts: FieldLockKeyParts): string {
  const { organizationId, workItemId, fieldRef, sourceHash, targetLanguage } = parts;
  return createHash('sha256')
    .update(JSON.stringify([organizationId, workItemId, fieldRef, sourceHash, targetLanguage]))
    .digest('hex');
}

/** Postgres' `lock_not_available` (55P03), however the driver adapter wraps it. */
function isLockTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
    cause?: unknown;
  };
  if (e.code === '55P03' || e.meta?.code === '55P03') return true;
  if (typeof e.message === 'string' && /lock timeout|55P03/.test(e.message)) return true;
  return e.cause !== undefined && e.cause !== err && isLockTimeout(e.cause);
}

/**
 * Run `fn` holding one advisory lock per key. Keys are de-duplicated and taken
 * in SORTED order, so two presses with overlapping field sets queue rather than
 * deadlock. A wait longer than {@link FIELD_LOCK_WAIT_MS} in total (or the
 * shorter `opts.waitMs`, which tests use) throws
 * {@link FieldLockTimeoutError}, and `fn` never runs. The locks are released
 * when the transaction ends — on `fn`'s return and on its throw alike.
 */
export async function withFieldLocks<T>(
  keys: readonly string[],
  fn: () => Promise<T>,
  ctx: WorkspaceContext,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return fn();
  const waitMs = Math.min(opts.waitMs ?? FIELD_LOCK_WAIT_MS, FIELD_LOCK_WAIT_MS);
  const waitUntil = Date.now() + waitMs;
  try {
    return await withWorkspaceContext(
      ctx,
      async (tx) => {
        for (const key of sorted) {
          await workItemTranslationRepository.setLockTimeout(waitUntil - Date.now(), tx);
          await workItemTranslationRepository.lockField(key, tx);
        }
        return fn();
      },
      { timeoutMs: FIELD_LOCK_TRANSACTION_MS, maxWaitMs: 10_000 },
    );
  } catch (err) {
    if (isLockTimeout(err)) throw new FieldLockTimeoutError(sorted.length);
    throw err;
  }
}
