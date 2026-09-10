import { Prisma, type ApprovalGate } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  ApprovalGateAlreadyAwaitingError,
  ApprovalGateDecidedImmutableError,
} from '@/lib/approvalGates/errors';

// Single-op data access for the `approval_gate` table (Story MOTIR-4778 ·
// Subtask MOTIR-4788; ADR docs/decisions/approval-gates.md). Writes require `tx`
// (the 4-layer rule). Every tenant path runs under withWorkspaceContext so the
// RLS policy's `app.workspace_id` GUC is bound (a pure active-workspace gate —
// no `app.system_admin` hatch, mirroring `design_evidence` /
// `acceptance_evidence`).
//
// The partial unique index `approval_gate_one_awaiting_per_subject` enforces
// AT MOST ONE `awaiting` gate per `(work_item_id, kind, subject_id)`; a losing
// concurrent insert surfaces a typed `ApprovalGateAlreadyAwaitingError` rather
// than a raw `P2002` (the concurrency rule in CLAUDE.md — a raw DB error never
// escapes). This card ships the repository leaf and NO service, so the
// translation lives at this edge — the same disposition
// `workItemLinkRepository` gives the `(fromId, toId, kind)` unique (→
// `DuplicateLinkError`): the decide-door card (MOTIR-4790) catches the typed
// error and branches on it, never inspecting a raw Prisma code.
//
// Reads take an OPTIONAL `tx` and resolve `tx ?? dbRead` (the bindable form
// `tests/rls/singletonReadScan.ts` treats as BINDABLE): a caller inside a
// transaction threads that `tx`; a pure-read service path calls them without
// one under an already-bound workspace context. `dbRead` (not `db`) is the
// fallback — `db` would union two whole Prisma clients and tank the
// type-check (MOTIR-4295).
//
// MOTIR-4912 (the AUDIT columns) adds a SECOND database refusal to this edge —
// the `trg_approval_gate_decided_immutable` trigger, which refuses any UPDATE of
// an `approved` / `changes_requested` row (ADR §6a: a decided gate is immutable).
// Both refusals are now produced in ONE place, `translateApprovalGateWriteError`
// at the foot of this file, so a write method's only obligation is to route its
// `catch` through it. That matters because the two arrive in different SHAPES: a
// unique violation is a Prisma `P2002`, while a trigger rejection comes through
// the pg driver adapter as an error whose `cause.code` is SQLSTATE `23514` and
// whose message carries the `AG_DECIDED_IMMUTABLE` marker. Keying each on the
// wrong one is how a raw Postgres error escapes.

export const approvalGateRepository = {
  /**
   * Insert a gate row. A second `awaiting` gate for the same
   * `(workItemId, kind, subjectId)` hits the partial unique index and is
   * translated to `ApprovalGateAlreadyAwaitingError` — a typed domain error,
   * not a raw `P2002`. Decided/superseded rows are unconstrained (approvals
   * ACCUMULATE, ADR §6d), so re-approving across a card's reopen lifecycle
   * never collides.
   */
  async create(
    data: Prisma.ApprovalGateUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate> {
    try {
      return await tx.approvalGate.create({ data });
    } catch (err) {
      // The partial unique index is the ONLY unique constraint a create can
      // violate (the PK on `id` is a cuid collision, effectively unreachable),
      // so a P2002 here IS the awaiting-race. Under `motir_app` (FORCE RLS,
      // non-superuser) PostgreSQL declines to describe the conflicting key, so
      // the P2002 carries no `meta.target` — the code is the only reliable
      // signal, exactly as for `workItemLinkRepository`'s `DuplicateLinkError`.
      //
      // The translation itself moved to `translateApprovalGateWriteError`
      // (MOTIR-4912) once a second database refusal existed to translate; it
      // always throws, which is why this `catch` needs no `throw` of its own.
      translateApprovalGateWriteError(err);
    }
  },

  /** One gate by id (the decide door's subject resolve / a re-read after a
   *  decision). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<ApprovalGate | null> {
    const client = tx ?? dbRead;
    return client.approvalGate.findUnique({ where: { id } });
  },

  /** The per-card read: every `awaiting` gate on one work item (the decide
   *  door's resolve + the card's own gate surface). Served by the
   *  `approval_gate_work_item_id_idx` index. */
  async findAwaitingByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    const client = tx ?? dbRead;
    return client.approvalGate.findMany({
      where: { workItemId, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** The routing read: a workspace's `awaiting` gates (whose Approvals tab).
   *  Served by the `approval_gate_workspace_id_state_idx` index. */
  async findAwaitingByWorkspace(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    const client = tx ?? dbRead;
    return client.approvalGate.findMany({
      where: { workspaceId, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
  },
};

/**
 * Translate an `approval_gate` WRITE-path error into one of this domain's typed
 * errors, so no raw Prisma / Postgres failure escapes the repository edge (the
 * concurrency rule in CLAUDE.md). Anything it does not recognise is rethrown
 * UNCHANGED. **Always throws — the return type is `never`**, which is what lets a
 * `catch` block end in a bare call to it and still satisfy the method's return
 * type.
 *
 * Every write on this table routes its `catch` through here — `create` today, and
 * the decide door's update (MOTIR-4790) when it lands. Two failures, and they
 * arrive in DIFFERENT shapes, which is the whole reason this is one function
 * rather than a check copied into each caller:
 *
 * | failure | how it arrives | typed as |
 * | --- | --- | --- |
 * | a second `awaiting` gate for one `(workItem, kind, subject)` | Prisma `P2002` on the partial unique index | `ApprovalGateAlreadyAwaitingError` |
 * | an UPDATE of an already-DECIDED row | the `trg_approval_gate_decided_immutable` trigger, via the pg adapter: SQLSTATE `23514` + the `AG_DECIDED_IMMUTABLE` marker in the message | `ApprovalGateDecidedImmutableError` |
 *
 * The marker is checked FIRST and the SQLSTATE only CONFIRMS it, mirroring
 * `workItemLinkRepository.translateWriteError`: the marker is a unique string we
 * control, while `23514` is the generic `check_violation` class that any future
 * CHECK constraint on this table would also raise. Either signal alone is
 * accepted, because a driver upgrade can drop `cause` without changing the
 * message.
 *
 * EXPORTED because the write it most needs to protect does not live in this file
 * yet: MOTIR-4790's `decide` is the one call that can hit the immutability
 * trigger in production, and wrapping its `catch` in this is a one-line join
 * rather than a second copy of the marker string. It is also what lets a test
 * assert the pair the guard actually consists of — the database refusing, and
 * the refusal arriving typed — without either half standing in for the other.
 */
export function translateApprovalGateWriteError(err: unknown): never {
  const message = extractMessage(err);

  if (message.includes('AG_DECIDED_IMMUTABLE') || extractSqlState(err) === '23514') {
    throw new ApprovalGateDecidedImmutableError();
  }

  /* istanbul ignore else -- defensive: an approval_gate write fails either on the partial unique (P2002) or on the immutability trigger, both handled */
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ApprovalGateAlreadyAwaitingError();
  }

  /* istanbul ignore next -- defensive rethrow: an unrecognised write failure is not this domain's to name */
  throw err;
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */
function extractSqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; originalCode?: unknown };
      if (typeof c.code === 'string') return c.code;
      /* istanbul ignore next -- defensive: the @prisma/adapter-pg error exposes `code`; `originalCode` is a fallback for a future driver shape */
      if (typeof c.originalCode === 'string') return c.originalCode;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* istanbul ignore next -- defensive: approval_gate write errors are always Error instances; this guards a non-Error throw */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* istanbul ignore next -- defensive: as above */
  return '';
}
