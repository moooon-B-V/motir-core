import {
  Prisma,
  type ApprovalGate,
  type ApprovalGateAuthority,
  type ApprovalGateDecisionSource,
  type ApprovalGateKind,
  type ApprovalGateState,
} from '@/generated/prisma/client';
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

  /**
   * The gate the FRAME renders — whatever state it is in (Subtask MOTIR-5033).
   *
   * ⚠️ THIS IS NOT `findAwaitingByWorkItem` WITH THE FILTER DROPPED. The
   * awaiting read answers *what is somebody being asked?*; this one answers
   * *what does this card's approval frame show?*, and the two differ exactly
   * once a decision has been made. A decided gate leaves the awaiting set by
   * design, so before this read a page reload took states `E` (approved), `F`
   * (changes requested) and `G` (superseded) off the screen entirely — the
   * record of who decided, when, and on WHICH bytes was written, immutable, and
   * unreachable from the card it was written about.
   *
   * ⚠️ THE ORDERING IS THE CONTRACT, AND ITS FIRST KEY IS NOT RECENCY. A LIVE
   * question outranks a decided one however old it is: a card that was approved
   * on Monday and republished on Tuesday holds a `superseded` gate, an
   * `approved` gate and a new `awaiting` gate, and the only one a reader can
   * ACT on is the awaiting one. Sorting on `createdAt` alone happens to agree
   * here — the republish creates its gate after superseding the old one, in the
   * same transaction — and would stop agreeing the first time a gate is created
   * out of order, which is not a property this read should depend on.
   *
   * So: `awaiting` first (oldest, matching `findAwaitingByWorkItem`'s own
   * determinism), then the most recent of the rest. Both keys are applied in
   * SQL, so the answer is one row and one round trip.
   *
   * Scoped by KIND for the same reason the awaiting read is: ADR §6b's
   * uniqueness is `(workItemId, kind, subjectId)`, so *"the gate"* is only a
   * well-formed question once a kind is named.
   *
   * Served by `approval_gate_work_item_id_idx`.
   */
  async findLatestByWorkItem(
    workItemId: string,
    kind: ApprovalGateKind,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate | null> {
    const client = tx ?? dbRead;
    const rows = await client.approvalGate.findMany({
      where: { workItemId, kind },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return null;
    // The live question wins, and the OLDEST of those — the same tie-break
    // `findAwaitingByWorkItem` gives, so a surface reading through either door
    // is asked about the same row.
    const awaiting = rows.find((row) => row.state === 'awaiting');
    if (awaiting) return awaiting;
    // Otherwise the most recent decision or withdrawal: approvals ACCUMULATE
    // (ADR §6d), so a card approved, reopened and approved again has several,
    // and the frame shows the latest without disturbing the earlier rows.
    return rows[rows.length - 1]!;
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
    decidedByLabel: string | null;
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
        decidedByLabel: string | null;
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
             "decided_at"    AS "decidedAt",
             -- READ for the REFUSAL, never for a write. The narrow column list
             -- above exists so a caller cannot write from this snapshot; this
             -- one joins decided_by_id / decided_at, which are here for the same
             -- reason - they are what lets the door's already-decided refusal
             -- NAME the winner instead of reporting a bare conflict
             -- (MOTIR-4792). The id is a join key; the label is the only part
             -- of it a person can be shown.
             "decided_by_label" AS "decidedByLabel"
      FROM "approval_gate"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Write the DECISION onto one gate — `state`, `decidedById`, `decidedAt`, the
   * optional note, and THE FIVE DECISION-TIME AUDIT COLUMNS (MOTIR-4790's decide
   * door; the audit set is MOTIR-4912's columns, written here by MOTIR-5046).
   *
   * ⚠️ EVERY AUDIT FIELD IS A REQUIRED PROPERTY OF `data`, THOUGH EVERY COLUMN IS
   * NULLABLE — and that gap is the whole point. The columns shipped nullable so
   * the migration could be additive on a populated table (they are legitimately
   * null while a gate is `awaiting`), and the consequence was that this signature
   * accepted a call that wrote none of them: for the entire life of MOTIR-4912
   * every row in production carried six nulls, indistinguishable at every layer
   * from a correct one, with nothing red anywhere. A caller that genuinely has no
   * answer passes an explicit `null` and has SAID so; a caller that forgot no
   * longer compiles. Do not relax these to optional to make a call site shorter.
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
   *
   * ⚠️ THAT GUARD HAS NOW SHIPPED, AND THIS IS THE CALL IT CAN FIRE ON — so the
   * `catch` routes through `translateApprovalGateWriteError` (MOTIR-4912). The
   * paragraph above is unchanged and is why the wrap is needed rather than a
   * `WHERE`: the state predicate stays the service's, and if its check is ever
   * absent, bypassed or wrong, the `trg_approval_gate_decided_immutable` trigger
   * refuses the update. Without the wrap that refusal escapes as a raw pg
   * `23514` — the one thing this edge exists to prevent. It is the ONLY write in
   * this repository that can reach the trigger, and the other two cannot for
   * DIFFERENT reasons: `create` because a BEFORE UPDATE trigger does not fire on
   * an INSERT, and {@link supersedeAwaitingByWorkItem} (MOTIR-4913) because its
   * predicate is an equality on the very column the trigger keys on. Its own
   * note carries that argument in full.
   */
  async decide(
    id: string,
    data: {
      state: Extract<ApprovalGateState, 'approved' | 'changes_requested'>;
      decidedById: string;
      decidedAt: Date;
      noteMd: string | null;
      /** The subject's immutable version, from the KIND's own seam. */
      subjectVersion: string | null;
      /** The decider's name + email as at the decision — what survives the
       *  `SetNull` on `decidedById`. */
      decidedByLabel: string | null;
      /** Which of §2's three rungs actually authorised the press. */
      decidedUnderAuthority: ApprovalGateAuthority;
      /** Which surface it arrived through. */
      decisionSource: ApprovalGateDecisionSource;
      /** What the decision CAUSED — null when it deliberately caused no status
       *  write, which is a real answer rather than a missing one. */
      outcomeRef: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate> {
    try {
      return await tx.approvalGate.update({ where: { id }, data });
    } catch (err) {
      translateApprovalGateWriteError(err);
    }
  },

  /**
   * RETIRE every `awaiting` gate of one kind on one work item — the product
   * withdrawing its own question because the subject it asked about is no longer
   * the current one (MOTIR-4913; ADR §6b).
   *
   * ⚠️ IT WRITES `state` AND NOTHING ELSE. No actor, no authority, no note, no
   * `decided_at`. That is the entire reason `superseded` is a separate state
   * rather than a flag beside `changes_requested`: the audit must never be able
   * to read a withdrawn question as a decision somebody made, and the only thing
   * that keeps those two apart on the row is that this write leaves every column
   * a decision fills untouched.
   *
   * ⚠️ KEYED ON `(workItemId, kind)`, NOT on the superseded subject's id — and
   * that is a fact about the DOMAIN, not a shortcut. `design_evidence` carries
   * one CURRENT row per work item (the
   * `design_evidence_one_current_per_item` partial unique index), so an
   * `awaiting` `design_result` gate on this item is by construction asking about
   * the version a publish is replacing. Keying on the prior row's id would need
   * that row read FIRST, which puts this write AFTER the
   * `design_evidence` lock — and the decide door takes those two locks in the
   * opposite order (gate, then evidence). One of the two orders has to give, and
   * the caller's own comment records why this one does.
   *
   * ⚠️ NO `decided`-state rows are touched: the `state: 'awaiting'` predicate is
   * the whole guard. A gate whose decision has landed is somebody's answer and
   * outlives its subject.
   *
   * ⚠️ AND THAT IS WHY THIS WRITE DOES **NOT** ROUTE THROUGH
   * {@link translateApprovalGateWriteError}, unlike the other two — the omission
   * is reasoned, not an oversight, and the reason is not *"a decided row would
   * be a bug"*. `trg_approval_gate_decided_immutable` (MOTIR-4912) keys on
   * `OLD.state`, and this statement's predicate is an EQUALITY on that same
   * column, so the trigger is structurally unreachable from here: under READ
   * COMMITTED an `updateMany` re-evaluates its `WHERE` against the updated row
   * version before writing, so a gate a concurrent decide commits mid-statement
   * stops matching and is skipped rather than refused. A `catch` here would be a
   * branch no test could honestly exercise, which is the thing this repository's
   * `tx ?? dbRead` note already refuses to add.
   *
   * ⚠️ AND THE ZERO-ROW RESULT IS NOT {@link decide}'S SILENT NO-OP. That method
   * carries no state predicate precisely because one would report success on a
   * decision that never landed. Here both causes of a zero count are correct end
   * states — nothing awaiting to retire, or a decide that won the row first —
   * and no caller is told anything happened that did not.
   *
   * Returns the count, which is 0 on every publish that had no prior version —
   * the ordinary first publish.
   */
  async supersedeAwaitingByWorkItem(
    workItemId: string,
    kind: ApprovalGateKind,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId, kind, state: 'awaiting' },
      data: { state: 'superseded' },
    });
    return result.count;
  },

  /**
   * LOCK every `awaiting` gate row on one work item, in id order (Story MOTIR-4887
   * · Subtask MOTIR-5527; ADR `approval-gates.md` §6d AMENDMENT, rule 8).
   *
   * ⚠️ A LOCK-ORDER TOOL, and the order is the whole of its purpose. The decide
   * door locks a GATE ({@link lockById}) and then, through the kind's effect,
   * transitions the item — which locks the WORK ITEM. `applyStatusTransition`
   * calls this BEFORE it locks the item, so every transition takes gate rows
   * first and the item second. A funnel that locked the item first and reached
   * for the gate afterwards (to supersede it) would take the same two locks in
   * the opposite order, and a person approving while another pulls the card back
   * would deadlock.
   *
   * Re-locking a row this transaction already holds is a no-op in Postgres, so the
   * decide door's own call into the funnel does not wait on itself. `ORDER BY id`
   * keeps two transitions on one item taking a multi-gate set in the same order.
   * Under READ COMMITTED a row decided while this waited is re-checked against
   * `state = 'awaiting'` and dropped from the result — so the rows it returns ARE
   * the item's awaiting set as of the lock, which is what the approval-gate guard
   * reads (`id` and `kind` are the two fields it needs).
   */
  async lockAwaitingByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; kind: ApprovalGateKind }>> {
    return tx.$queryRaw<Array<{ id: string; kind: ApprovalGateKind }>>`
      SELECT "id", "kind"
      FROM "approval_gate"
      WHERE "work_item_id" = ${workItemId} AND "state" = 'awaiting'
      ORDER BY "id"
      FOR UPDATE
    `;
  },

  /**
   * RETIRE every `awaiting` gate on one work item, WHATEVER ITS KIND — the
   * withdraw a hand move that pulls the work back performs (Story MOTIR-4887 ·
   * Subtask MOTIR-5527; ADR `approval-gates.md` §6d AMENDMENT, rule 6).
   *
   * The sibling of {@link supersedeAwaitingByWorkItem}, and not that method called
   * once per kind, because the question is different: a republish retires ONE
   * kind's question about a subject that changed, while pulling the work back
   * withdraws EVERY question anyone was asked about this item. A per-kind loop
   * would have to enumerate the kinds, and a kind added later would silently stay
   * `awaiting` on a card nobody is offering for review.
   *
   * Writes `state` and nothing else, exactly as the publish-path supersede does —
   * no actor, no note, no `decided_at` — so the audit cannot read a withdrawn
   * question as a decision. The `state: 'awaiting'` predicate is the whole guard:
   * a decided gate is somebody's answer and is never touched.
   */
  async supersedeAllAwaitingByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId, state: 'awaiting' },
      data: { state: 'superseded' },
    });
    return result.count;
  },

  /**
   * Every `awaiting` gate of `kind` asking about ONE subject, on any card — the merge
   * gate's withdrawal read (Story MOTIR-4882 · MOTIR-5515): a pull request's head
   * moving is a fact about the pull request, not about a card.
   */
  async findAwaitingBySubject(
    kind: ApprovalGateKind,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    return tx.approvalGate.findMany({
      where: { kind, subjectId, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * RETIRE the `awaiting` gates of `kind` asking about ONE subject (Story MOTIR-4882 ·
   * MOTIR-5515) — narrowed to one card by `workItemId`, and sparing a gate whose
   * `subjectVersion` is `exceptVersion` (the head that did not move).
   *
   * ⚠️ BY SUBJECT, NOT BY CARD. {@link supersedeAwaitingByWorkItem} retires EVERY
   * awaiting gate of a kind on a card, which is right for a design result (one current
   * version) and wrong for a merge gate: a card delivered by two pull requests holds
   * two independent questions, and one head moving must not withdraw the other.
   *
   * It writes `state` and nothing else, and it cannot reach the immutability trigger
   * for the reason the by-card variant states: its predicate is `state = 'awaiting'`.
   */
  async supersedeAwaitingBySubject(
    where: {
      kind: ApprovalGateKind;
      subjectId: string;
      workItemId?: string;
      exceptVersion?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: {
        kind: where.kind,
        subjectId: where.subjectId,
        state: 'awaiting',
        ...(where.workItemId !== undefined ? { workItemId: where.workItemId } : {}),
        ...(where.exceptVersion !== undefined
          ? {
              OR: [{ subjectVersion: null }, { NOT: { subjectVersion: where.exceptVersion } }],
            }
          : {}),
      },
      data: { state: 'superseded' },
    });
    return result.count;
  },

  /**
   * Whether a subject already has a LIVE question — a gate on
   * `(workItemId, kind, subjectId)` that is `awaiting` or `approved` (MOTIR-5532).
   *
   * The re-ask's precondition (ADR §6d AMENDMENT, rule 7): an awaiting gate is
   * already asking, and an approved one has been answered for THESE bytes, so
   * neither is asked again. `changes_requested` and `superseded` do not count —
   * the first sent the work back, the second was withdrawn.
   */
  async hasLiveGateForSubject(
    workItemId: string,
    kind: ApprovalGateKind,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const count = await tx.approvalGate.count({
      where: { workItemId, kind, subjectId, state: { in: ['awaiting', 'approved'] } },
    });
    return count > 0;
  },

  /**
   * RAISE an `awaiting` gate, or do nothing when one is already awaiting on the
   * same subject (Story MOTIR-4887 · Subtask MOTIR-5532; ADR §6d AMENDMENT,
   * rule 7). Returns whether a row was inserted.
   *
   * ⚠️ NOT {@link create}, and the difference is transactional, not cosmetic.
   * `create` translates the partial unique index's `P2002` into a typed error —
   * right at publish, where a collision is impossible by construction. The re-ask
   * runs INSIDE a status transition, where a concurrent double raise is a normal
   * outcome and must count as "already raised". A caught `P2002` cannot express
   * that: Postgres has already ABORTED the transaction, so the status write that
   * follows would fail. `ON CONFLICT DO NOTHING` (`skipDuplicates`) resolves the
   * race inside the statement, and the transition carries on.
   */
  async createAwaitingIfAbsent(
    data: {
      workspaceId: string;
      projectId: string;
      workItemId: string;
      kind: ApprovalGateKind;
      subjectId: string;
      routedToId: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.approvalGate.createMany({
      data: [{ ...data, state: 'awaiting' }],
      skipDuplicates: true,
    });
    return result.count > 0;
  },

  /**
   * THE ROUTING READ — one project's `awaiting` gates that are routed to ONE
   * person, oldest-waiting first, as a WINDOW (Story MOTIR-4879 · Subtask
   * MOTIR-4791; ADR docs/decisions/approval-gates.md §2).
   *
   * ⚠️ THIS IS `findAwaitingByWorkspace` NARROWED, NOT A SECOND METHOD BESIDE
   * IT. That read was workspace-scoped, unpaged and routed to nobody — the right
   * LEAF with the wrong scope, as its own comment said (*"the routing read: a
   * workspace's `awaiting` gates (whose Approvals tab)"*). Three things were
   * missing and all three are properties of the surface it was named for: the
   * Workbench is ACTIVE-PROJECT scoped (`homeService`'s own note, MOTIR-2761),
   * the tab asks whose gate it is, and a personal list is paged. Adding a fourth
   * near-identical `findMany` beside it would have left two answers to *whose
   * Approvals tab* differing only in a `where` clause nobody diffs.
   *
   * ⚠️ THE PREDICATE IS APPLIED IN THE QUERY, NEVER TO ITS OUTPUT — and the
   * `projectIds` ARRAY is what carries the ACCESS decision in. An actor who may
   * not browse their own active project is passed an EMPTY array and the query
   * returns nothing, which is the no-existence-leak convention every other
   * project gate follows. A post-read filter would shorten pages instead of
   * failing, and *"the list sometimes ends early"* is a bug nobody traces back to
   * an access rule (`homeService`'s `activeProjectScope`, verbatim reasoning).
   *
   * ⚠️ ROUTING IS RE-DERIVED FROM THE WORK ITEM, NOT READ FROM `routed_to_id` —
   * and the two genuinely differ, so this is a decision rather than an
   * oversight. `routed_to_id` is §2's answer FROZEN AT CREATION, and ADR §6a
   * keeps it for exactly that: it is the audit record of *who was actually
   * asked*, which must not move when a card is reassigned. A live QUEUE asks a
   * different question — *whose job is it to look, now* — and answering it from
   * the frozen column would strand every gate on a reassigned card in the
   * previous assignee's tab, including one belonging to somebody who has left.
   * That is the failure §2's amendment widened AUTHORITY to escape, and it
   * should not be reintroduced through the routing half. The audit column and
   * this predicate are both right, about different questions.
   *
   * `assigneeId = :me OR (assigneeId IS NULL AND reporterId = :me)` — §2's
   * `assigneeId ?? reporterId`, expressed as a predicate. Exactly one recipient,
   * which is why it is NOT `workItemRepository.findByAssigneeOrReporterInWorkspace`'s
   * union: that one is right for a WORK LIST and wrong for a DECISION QUEUE.
   *
   * Ordered `createdAt asc` — oldest-waiting first, matching
   * {@link findAwaitingByWorkItem}'s own determinism. A queue optimises for what
   * has been waiting, because the cost of a gate is the work stalled behind it.
   *
   * Served by `approval_gate_project_id_state_idx` (this card's migration): the
   * gate side narrows to one project's awaiting rows and the join to
   * `work_item` is by primary key. The old `(workspace_id, state)` index stays
   * for the workspace-tier read MOTIR-2920 will add.
   *
   * ⚠️ `tx` IS REQUIRED, UNLIKE ITS NEIGHBOURS' `tx ?? dbRead` — and this is
   * MOTIR-2797's disposition, applied to a new pair rather than inherited by
   * habit. `designEvidenceRepository` records the reasoning in full: a fallback
   * arm with no caller *"was dead code that returned an EMPTY result under
   * `motir_app` and raised nothing — the exact silent failure this cutover
   * exists to remove. A branch that cannot be honestly exercised in both role
   * modes should not exist."* Both callers here are
   * `approvalGatesService.listAwaitingMe` / `.countAwaitingMe`, which read
   * INSIDE `withWorkspaceContext` and thread it. Measured, not assumed: calling
   * this without a `tx` returns `[]` on a populated fixture, because `dbRead` is
   * a second connection with no `app.workspace_id` bound — an empty queue and no
   * error, which is the worst answer this surface could give.
   */
  async findAwaitingRoutedTo(
    scope: AwaitingRoutingScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<AwaitingGateRow[]> {
    return tx.approvalGate.findMany({
      where: awaitingRoutedToWhere(scope),
      select: AWAITING_GATE_SELECT,
      orderBy: { createdAt: 'asc' },
      skip: window.skip,
      take: window.take,
    });
  },

  /**
   * HOW MANY gates {@link findAwaitingRoutedTo} would return over the whole set
   * — the tab strip's badge, and the pager's denominator.
   *
   * ⚠️ IT IS THE SAME PREDICATE, from the same function, and that is the point
   * rather than a tidiness. The strip's number and the list's rows are two reads
   * of one question, so a copy of the `where` clause here is a copy that can
   * drift — and a badge saying `3` above a list of two is the exact bug the
   * story's own criterion (*"one read, not two, so they cannot disagree"*)
   * names. `awaitingRoutedToWhere` is the one place the predicate is written.
   */
  async countAwaitingRoutedTo(
    scope: AwaitingRoutingScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: awaitingRoutedToWhere(scope) });
  },

  /**
   * THE APPROVALS ROOM's PENDING half (Story MOTIR-5299 · MOTIR-5301) — one
   * project's `awaiting` gates as a window, in `design/approvals/design-notes.md`'s
   * order: `createdAt asc, id asc`.
   *
   * The ORDER is ADOPTED from {@link findAwaitingRoutedTo} (the notes' § The ORDER):
   * a pending row in a record room is still work stalled behind a question, and in
   * the own-records view this half IS the tab's rows, so it must list them in the
   * tab's order. The `id` tie-break is the room's addition — two gates raised in one
   * transaction share a `createdAt`, and a window over an unstable order serves a
   * row twice across a page boundary.
   *
   * ⚠️ `tx` IS REQUIRED, for {@link findAwaitingRoutedTo}'s measured reason: without
   * one this returns `[]` on a populated fixture and raises nothing.
   */
  async findRecordsAwaiting(
    scope: ApprovalRecordsScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<RecordGateRow[]> {
    return tx.approvalGate.findMany({
      where: recordsAwaitingWhere(scope),
      select: RECORD_GATE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: window.skip,
      take: window.take,
    });
  },

  /** HOW MANY rows {@link findRecordsAwaiting} would return — the same `where` builder. */
  async countRecordsAwaiting(
    scope: ApprovalRecordsScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: recordsAwaitingWhere(scope) });
  },

  /**
   * THE APPROVALS ROOM's DECIDED half (MOTIR-5301) — one project's `approved` and
   * `changes_requested` gates as a window, most recently decided first:
   * `decidedAt desc, id desc` (the notes' § The ORDER).
   *
   * ⚠️ `superseded` IS NOT A DECISION AND IS NOT HERE, IN EITHER VIEW. ADR §6b writes
   * a null `decidedById` to mean *the question was withdrawn and nobody decided it*,
   * so the own-records arm excludes it for free — and the full view excludes it on
   * purpose, because the design settles that a room of records must not list an
   * abandoned question beside a decision (the notes' § `superseded` is NOT in the
   * room). It is the STATE list that excludes it, not the decider test, so the
   * full view does not depend on a column being null.
   *
   * Served by `approval_gate_project_id_decided_by_id_decided_at_idx` in the
   * own-records view — see the index's own note in `prisma/schema.prisma`.
   *
   * ⚠️ `tx` IS REQUIRED, for the same reason as {@link findRecordsAwaiting}.
   */
  async findRecordsDecided(
    scope: ApprovalRecordsScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<RecordGateRow[]> {
    return tx.approvalGate.findMany({
      where: recordsDecidedWhere(scope),
      select: RECORD_GATE_SELECT,
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      skip: window.skip,
      take: window.take,
    });
  },

  /** HOW MANY rows {@link findRecordsDecided} would return — the same `where` builder. */
  async countRecordsDecided(
    scope: ApprovalRecordsScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: recordsDecidedWhere(scope) });
  },
};

/**
 * WHICH projects the read may see, and WHO it is routed to.
 *
 * `projectIds` is an ARRAY of at most one rather than a bare id, deliberately —
 * the same shape and the same reason as `homeService`'s `HomeProjectScope[]`: an
 * actor who may not browse their active project resolves to `[]`, and a call
 * shape that took a bare id could not express that without an early return, at
 * which point the access decision has left the query.
 */
export interface AwaitingRoutingScope {
  projectIds: string[];
  /** The reader — §2's single recipient. */
  userId: string;
}

/**
 * §2's routing predicate, written ONCE — the list and the count both call it.
 *
 * The `OR` is the SQL spelling of `assigneeId ?? reporterId`: the second arm is
 * guarded by `assigneeId: null`, which is what makes it a FALLBACK rather than
 * the union the work tabs use. Drop that guard and this becomes
 * `homeService`'s membership predicate, which is the exact "fix" ADR §2 records
 * itself to stop.
 */
function awaitingRoutedToWhere(scope: AwaitingRoutingScope): Prisma.ApprovalGateWhereInput {
  return {
    projectId: { in: scope.projectIds },
    state: 'awaiting',
    workItem: {
      OR: [{ assigneeId: scope.userId }, { assigneeId: null, reporterId: scope.userId }],
    },
  };
}

/**
 * WHAT the Approvals room's read may see (MOTIR-5301).
 *
 * `projectIds` carries the ACCESS floor in, exactly as {@link AwaitingRoutingScope}
 * does: `[]` for a reader who may not browse their active project, and the query
 * returns nothing. `fullView` carries the SERVICE's answer to *does this reader
 * hold `approval:view_any`* — decided there from `projectAccessService.getPermissions`
 * and never by a caller, which is why this type is built only by the service.
 */
export interface ApprovalRecordsScope extends AwaitingRoutingScope {
  fullView: boolean;
}

/**
 * The room's PENDING predicate, written once. Without the key it IS §2's routing
 * predicate — CALLED, never restated, so the room's first section and the
 * Workbench tab cannot disagree about whose gate it is. With the key it is every
 * `awaiting` gate of the project.
 */
function recordsAwaitingWhere(scope: ApprovalRecordsScope): Prisma.ApprovalGateWhereInput {
  if (!scope.fullView) return awaitingRoutedToWhere(scope);
  return { projectId: { in: scope.projectIds }, state: 'awaiting' };
}

/**
 * The room's DECIDED predicate, written once. The two decision states only; without
 * the key, only the ones this reader decided — `decidedById` records who actually
 * pressed, whatever authority they held, so this arm needs no routing rule.
 */
function recordsDecidedWhere(scope: ApprovalRecordsScope): Prisma.ApprovalGateWhereInput {
  return {
    projectId: { in: scope.projectIds },
    state: { in: ['approved', 'changes_requested'] },
    ...(scope.fullView ? {} : { decidedById: scope.userId }),
  };
}

/**
 * What ONE queue row reads off the gate and its card — the projection the
 * Approvals tab is built on.
 *
 * Narrow on purpose: a queue row is not the gate DTO. The audit set (§6a) is
 * null on every row this read returns, because every row is `awaiting`, so
 * selecting it would be six columns of guaranteed nulls travelling to a surface
 * that cannot render them.
 */
const AWAITING_GATE_SELECT = {
  id: true,
  kind: true,
  state: true,
  subjectId: true,
  createdAt: true,
  workItem: {
    // ⚠️ `assigneeId` / `reporterId` are here for the ROW's *waiting on* line
    // (MOTIR-5191), not for the predicate — `awaitingRoutedToWhere` selects on
    // them in SQL and never returns them. Reading them back lets the service
    // name the recipient from the ROW rather than from the fact that the
    // predicate pinned it to the reader; the two agree today, and a surface
    // that depended on them agreeing would start lying silently the day §2's
    // routing widened.
    select: {
      id: true,
      key: true,
      identifier: true,
      title: true,
      kind: true,
      type: true,
      assigneeId: true,
      reporterId: true,
    },
  },
} as const satisfies Prisma.ApprovalGateSelect;

/**
 * What ONE Approvals-room row reads — the queue row's projection plus the AUDIT
 * fields a record renders (MOTIR-5301): WHEN it was decided, by WHOM as recorded at
 * the decision (`decidedByLabel`, which survives the user's deletion where the FK
 * does not), and ON WHICH BYTES (`subjectVersion`). A decided row that does not say
 * which version was approved is a list entry, not a record.
 */
const RECORD_GATE_SELECT = {
  ...AWAITING_GATE_SELECT,
  decidedAt: true,
  decidedByLabel: true,
  subjectVersion: true,
} as const satisfies Prisma.ApprovalGateSelect;

/** One row of the Approvals room's read, as Prisma returns it. */
export type RecordGateRow = Prisma.ApprovalGateGetPayload<{
  select: typeof RECORD_GATE_SELECT;
}>;

/** One row of the routing read, as Prisma returns it. */
export type AwaitingGateRow = Prisma.ApprovalGateGetPayload<{
  select: typeof AWAITING_GATE_SELECT;
}>;

/**
 * Translate an `approval_gate` WRITE-path error into one of this domain's typed
 * errors, so no raw Prisma / Postgres failure escapes the repository edge (the
 * concurrency rule in CLAUDE.md). Anything it does not recognise is rethrown
 * UNCHANGED. **Always throws — the return type is `never`**, which is what lets a
 * `catch` block end in a bare call to it and still satisfy the method's return
 * type.
 *
 * BOTH writes on this table route their `catch` through here — `create` and
 * `decide` — and that is the invariant to preserve when a third is added. Two
 * failures, and they arrive in DIFFERENT shapes, which is the whole reason this
 * is one function rather than a check copied into each caller:
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
 * EXPORTED so a test can assert the pair the guard actually consists of — the
 * database refusing, and the refusal arriving typed — without either half
 * standing in for the other. Asserting only the typed error would keep passing if
 * the trigger were dropped and something else started raising `23514`; asserting
 * only the raw refusal would not prove it ever reaches a caller as a domain
 * error.
 */
export function translateApprovalGateWriteError(err: unknown): never {
  const message = extractMessage(err);

  if (message.includes('AG_DECIDED_IMMUTABLE') || extractSqlState(err) === '23514') {
    throw new ApprovalGateDecidedImmutableError();
  }

  // Defensive: an `approval_gate` write fails either on the partial unique
  // (P2002) or on the immutability trigger, and both are handled above — so the
  // else arm below is unreachable through every shipped caller. The invariant is
  // pinned by `tests/approval-gate-coverage-floor.test.ts` § 'the repository
  // translates the write failures it OWNS'.
  //
  // ⚠️ This was `/* istanbul ignore else */`, which the **v8** provider this repo
  // configures does not read — so it suppressed nothing and the arm was counted
  // as uncovered. A directive that does not suppress is worse than none: it
  // tells a reader the arm has been dispositioned while the number disagrees.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ApprovalGateAlreadyAwaitingError();
  }

  // Defensive rethrow: an unrecognised write failure is not this domain's to
  // name. Same disposition, and same re-spelling, as the arm above.
  /* v8 ignore next */
  throw err;
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */
function extractSqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; originalCode?: unknown };
      if (typeof c.code === 'string') return c.code;
      // Defensive: `@prisma/adapter-pg` exposes `code`; `originalCode` is a
      // fallback for a future driver shape, so no shipped adapter reaches it.
      // Same re-spelling as above.
      /* v8 ignore next */
      if (typeof c.originalCode === 'string') return c.originalCode;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Defensive: `approval_gate` write errors are always `Error` instances, so
  // both arms below guard a non-Error throw no shipped path produces. Same
  // re-spelling as the arms above — `istanbul ignore` is inert under v8.
  /* v8 ignore next 3 */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* v8 ignore next */
  return '';
}
