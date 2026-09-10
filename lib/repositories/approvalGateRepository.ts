import {
  Prisma,
  type ApprovalGate,
  type ApprovalGateKind,
  type ApprovalGateState,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { ApprovalGateAlreadyAwaitingError } from '@/lib/approvalGates/errors';

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
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApprovalGateAlreadyAwaitingError();
      }
      throw err;
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

  /**
   * LOCK one gate row and return the fields a DECISION is derived from
   * (MOTIR-4790's decide door, step 1).
   *
   * `SELECT … FOR UPDATE`, because deciding a gate is a READ-DERIVED WRITE: the
   * decision depends on the state it just read, so a plain read-then-write lets
   * two reviewers pressing in the same second both observe `awaiting` and both
   * record a decision. The loser must WAIT for the winner's commit and then
   * re-read what actually happened — which is what makes the refusal able to
   * NAME the winner (`ApprovalGateAlreadyDecidedError`) instead of guessing.
   *
   * ⚠️ NO `SKIP LOCKED`, deliberately, and the contrast with `claim_next_ready`
   * is the whole reason: a dispatch claim skips a locked row because there is a
   * next-best card to hand out, and there is no next-best GATE here — this
   * actor is deciding THIS question. Skipping would return "not found" for a row
   * that exists and is about to be decided, which is the one answer that is
   * never true.
   *
   * ⚠️ It locks the GATE, never the subject. ADR §6a: locking the subject would
   * make two gate kinds on one card contend with each other, so a design
   * approval would serialise against a merge decision for no reason.
   *
   * Returns null when the id names no row THIS transaction can see — missing, or
   * hidden by the workspace RLS policy. The two are indistinguishable on
   * purpose (no existence leak), and the service maps both to a 404.
   *
   * `$queryRaw` because Prisma has no `FOR UPDATE`; the column list is narrow
   * because these are exactly the fields the decision reads, and widening it
   * would invite a caller to write from a snapshot rather than from the row.
   */
  async lockById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    id: string;
    workspaceId: string;
    projectId: string;
    workItemId: string;
    kind: ApprovalGateKind;
    subjectId: string;
    state: ApprovalGateState;
    decidedById: string | null;
    decidedAt: Date | null;
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        workspaceId: string;
        projectId: string;
        workItemId: string;
        kind: ApprovalGateKind;
        subjectId: string;
        state: ApprovalGateState;
        decidedById: string | null;
        decidedAt: Date | null;
      }>
    >`
      SELECT "id",
             "workspace_id"  AS "workspaceId",
             "project_id"    AS "projectId",
             "work_item_id"  AS "workItemId",
             "kind",
             "subject_id"    AS "subjectId",
             "state",
             "decided_by_id" AS "decidedById",
             "decided_at"    AS "decidedAt"
      FROM "approval_gate"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Write the DECISION onto one gate — `state`, `decidedById`, `decidedAt` and
   * the optional note (MOTIR-4790's decide door, step 4).
   *
   * ⚠️ It carries NO state predicate, BY DESIGN — the same disposition
   * `acceptanceEvidenceRepository.markSupersededByWorkItem` records for the same
   * reason. The `awaiting` check belongs to the SERVICE, which holds the row
   * lock from {@link lockById} and refuses a decided or superseded gate with a
   * typed error. A `WHERE state = 'awaiting'` here would turn that refusal into
   * a SILENT NO-OP: the update would match zero rows, the service would report
   * success, and the reviewer would be told their decision landed. Do not add
   * one in the belief it makes this safer.
   *
   * A DECIDED gate is immutable (ADR §6a — audit evidence that can be edited is
   * not evidence), and that immutability is the service's refusal above plus a
   * DB-level guard a sibling card ships (MOTIR-4912). Nothing else calls this.
   */
  async decide(
    id: string,
    data: {
      state: Extract<ApprovalGateState, 'approved' | 'changes_requested'>;
      decidedById: string;
      decidedAt: Date;
      noteMd: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate> {
    return tx.approvalGate.update({ where: { id }, data });
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
