import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  approvalGateRepository,
  translateApprovalGateWriteError,
} from '@/lib/repositories/approvalGateRepository';
import { ApprovalGateDecidedImmutableError } from '@/lib/approvalGates/errors';
import { toApprovalGateDto } from '@/lib/mappers/approvalGateMappers';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The `approval_gate` AUDIT set and its immutability guard (Story MOTIR-4778 ·
// Subtask MOTIR-4912; ADR docs/decisions/approval-gates.md §6a, and §6b's
// MOTIR-4911 amendment for `decision_source: github`) against a REAL Postgres.
//
// The load-bearing assertions are the two the audit's own argument rests on, and
// each is made by DOING the thing rather than by reading the schema:
//
//   * `decided_by_label` survives its actor's DELETION while `decided_by_id`
//     goes null — asserted by deleting the user, which is the event the column
//     exists for and the only way to observe `SetNull` actually firing.
//   * a DECIDED gate cannot be UPDATED — asserted by attempting the update and
//     catching the database's own refusal, not by asserting a trigger exists.
//
// ⚠️ Rows here are written with `adminDb` ON PURPOSE, and this is the one place
// in the approval-gate suite where that is not the usual setup-vs-behaviour
// split. The behaviour under test is the DATABASE's — a trigger and an FK
// action — and the writer that would exercise it through the app is
// MOTIR-4790's decide door, which does not exist on this branch. Writing as the
// owner is therefore the STRONGER assertion, not a weaker one: the guard holds
// against a client that bypasses RLS entirely, which is exactly the class of
// writer (a backfill, a fixture, a repair script) the service's own refusal
// cannot reach.
//
// `truncateAuthTables()` CASCADEs through `workspace` → `work_item` →
// `approval_gate`; the explicit truncate is defensive.

let fx: WorkItemFixture;
let itemId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Gate host' },
    fx.ctx,
  );
  itemId = item.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The BASE gate MOTIR-4788 could write — no audit field set. */
const baseGate = (subjectId: string) => ({
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  workItemId: itemId,
  kind: 'design_result' as const,
  subjectId,
});

describe('the audit columns are ADDITIVE — an existing row stays valid', () => {
  it('a gate written with only the base fields reads back with every audit field null', async () => {
    const created = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-additive'), tx),
    );

    expect(created).toMatchObject({
      state: 'awaiting',
      subjectVersion: null,
      decidedByLabel: null,
      routedToId: null,
      decidedUnderAuthority: null,
      decisionSource: null,
      outcomeRef: null,
    });
  });

  it('every audit column is NULLABLE with no default — which is what makes the migration safe on a populated table', async () => {
    const columns = await adminDb.$queryRaw<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >`
      SELECT "column_name", "is_nullable", "column_default"
      FROM information_schema.columns
      WHERE "table_name" = 'approval_gate'
        AND "column_name" IN (
          'subject_version', 'decided_by_label', 'routed_to_id',
          'decided_under_authority', 'decision_source', 'outcome_ref'
        )
      ORDER BY "column_name"
    `;

    // All six present — the list is asserted, not spot-checked, so dropping one
    // from the migration fails here rather than at the first surface that reads
    // it.
    expect(columns.map((c) => c.column_name)).toEqual([
      'decided_by_label',
      'decided_under_authority',
      'decision_source',
      'outcome_ref',
      'routed_to_id',
      'subject_version',
    ]);
    // NULLABLE and DEFAULT-LESS is the whole of "additive": a NOT NULL or a
    // default would rewrite every existing row, and there is no backfill that
    // could invent an audit value for a decision already made.
    for (const c of columns) {
      expect({ name: c.column_name, nullable: c.is_nullable, default: c.column_default }).toEqual({
        name: c.column_name,
        nullable: 'YES',
        default: null,
      });
    }
  });
});

describe('decided_by_label SURVIVES the actor deletion that nulls decided_by_id', () => {
  it('deleting the decider leaves the row, nulls the FK, and keeps the label', async () => {
    // ⚠️ A SEPARATE user, not `fx.owner`. The fixture owner is the REPORTER of
    // the host work item, and `WorkItem.reporter` is `onDelete: Restrict` — so
    // deleting them is refused by a different FK and the test would measure that
    // refusal instead of this column. A reviewer who has decided a gate and
    // nothing else is also the real shape of the case: the departing member.
    const decider = await createTestUser({ name: 'Departing Reviewer' });

    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-departure'), tx),
    );

    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state: 'approved',
        decidedById: decider.id,
        decidedByLabel: `${decider.name} <${decider.email}>`,
        decidedAt: new Date(),
        subjectVersion: 'a1b2c3d',
        decidedUnderAuthority: 'assignee',
        decisionSource: 'ui',
        outcomeRef: 'done',
      },
    });

    // THE EVENT THE COLUMN EXISTS FOR. Asserting the FK's `onDelete` from the
    // schema would prove Prisma's declaration, not Postgres's behaviour.
    await adminDb.user.delete({ where: { id: decider.id } });

    const after = await adminDb.approvalGate.findUnique({ where: { id: gate.id } });

    expect(after).not.toBeNull();
    // The FK is gone — `SetNull`, exactly as MOTIR-4788 declared it.
    expect(after?.decidedById).toBeNull();
    // …and the audit still answers "who". This pair IS the reason the column
    // exists: either half alone is the failure it was added to prevent.
    expect(after?.decidedByLabel).toBe(`${decider.name} <${decider.email}>`);
    expect(after?.state).toBe('approved');
    expect(after?.subjectVersion).toBe('a1b2c3d');
  });

  it('a gate ROUTED to a departing member keeps the row too — routed_to_id is SetNull as well', async () => {
    const routee = await createTestUser({ name: 'Routed Reviewer' });

    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-routee'), tx),
    );
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { routedToId: routee.id },
    });

    await adminDb.user.delete({ where: { id: routee.id } });

    const after = await adminDb.approvalGate.findUnique({ where: { id: gate.id } });
    // The gate survives, unrouted. `Restrict` here would make a departing member
    // undeletable for as long as any gate had ever been addressed to them, which
    // is a far worse trade than losing a routing record the audit does not rest
    // on.
    expect(after).not.toBeNull();
    expect(after?.routedToId).toBeNull();
  });
});

describe('a DECIDED gate is IMMUTABLE', () => {
  /** Write a decided gate directly, bypassing the door that does not exist yet. */
  async function decidedGate(subjectId: string, state: 'approved' | 'changes_requested') {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate(subjectId), tx),
    );
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state,
        decidedById: fx.ownerId,
        decidedByLabel: 'Zhu Yue <zhuyue11@gmail.com>',
        decidedAt: new Date(),
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
      },
    });
    return gate.id;
  }

  it('⚠️ THE PRODUCTION PATH — a SECOND `approvalGateRepository.decide` on the same gate is refused', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-decide-twice'), tx),
    );
    const decision = {
      state: 'approved' as const,
      decidedById: fx.ownerId,
      decidedAt: new Date(),
      noteMd: 'Ships as drawn.',
    };

    // The real door's write, through the real repository method. `decide` carries
    // no `WHERE state = 'awaiting'` by design — a predicate there would turn the
    // refusal into a silent no-op reporting success — so the trigger is the only
    // thing standing between a bypassed service check and an edited audit row.
    const first = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.decide(gate.id, decision, tx),
    );
    expect(first.state).toBe('approved');

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.decide(
          gate.id,
          { ...decision, state: 'changes_requested', noteMd: 'Changed my mind.' },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);

    // The first decision stands, unedited — which is the whole claim.
    const after = await adminDb.approvalGate.findUnique({ where: { id: gate.id } });
    expect(after?.state).toBe('approved');
    expect(after?.noteMd).toBe('Ships as drawn.');
  });

  it('an update of an APPROVED gate is refused with the typed domain error', async () => {
    const id = await decidedGate('subj-approved', 'approved');

    await expect(
      withWorkspaceContext(fx.ctx, async (tx) => {
        try {
          // The exact shape MOTIR-4790's `decide` has: a bare Prisma update,
          // with its catch routed through the repository's translator.
          return await tx.approvalGate.update({ where: { id }, data: { noteMd: 'edited later' } });
        } catch (err) {
          translateApprovalGateWriteError(err);
        }
      }),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);

    const after = await adminDb.approvalGate.findUnique({ where: { id } });
    expect(after?.noteMd).toBeNull();
  });

  it('a CHANGES_REQUESTED gate is equally immutable — a rejection is a decision too', async () => {
    const id = await decidedGate('subj-rejected', 'changes_requested');

    await expect(
      withWorkspaceContext(fx.ctx, async (tx) => {
        try {
          return await tx.approvalGate.update({
            where: { id },
            data: { state: 'approved', decidedByLabel: 'Someone Else <x@example.com>' },
          });
        } catch (err) {
          translateApprovalGateWriteError(err);
        }
      }),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);

    const after = await adminDb.approvalGate.findUnique({ where: { id } });
    expect(after?.state).toBe('changes_requested');
    expect(after?.decidedByLabel).toBe('Zhu Yue <zhuyue11@gmail.com>');
  });

  it('the refusal comes from the DATABASE, and it names itself — marker + SQLSTATE 23514', async () => {
    const id = await decidedGate('subj-raw', 'approved');

    // Asserted on the RAW error, before translation, because the translator
    // keys on exactly these two signals. A test that only ever saw the typed
    // error would keep passing if the trigger were dropped and something else
    // started raising 23514 on this table.
    const raw = await adminDb.approvalGate
      .update({ where: { id }, data: { outcomeRef: 'backfilled-later' } })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(raw).toBeInstanceOf(Error);
    expect((raw as Error).message).toContain('AG_DECIDED_IMMUTABLE');
    // The trigger names the decision it is protecting, not merely that one
    // exists — the same courtesy the decide door's own refusal owes.
    expect((raw as Error).message).toContain('approved');
    expect((raw as Error).message).toContain(id);
  });

  it('an AWAITING gate is still updatable — the guard keys on the DECIDED states only', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-awaiting'), tx),
    );

    // This is the write the decide door itself makes; a guard that blocked it
    // would make the whole table write-once at creation.
    const decided = await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { state: 'approved', decidedByLabel: 'Zhu Yue <zhuyue11@gmail.com>' },
    });
    expect(decided.state).toBe('approved');
  });

  it('a SUPERSEDED gate is still updatable — §6b says a withdrawn question is not a decision', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-superseded'), tx),
    );
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: 'superseded' } });

    // It carries no actor, no permission and no note, so there is no evidence on
    // it to protect — and locking it would pre-empt MOTIR-4913, which owns that
    // state's writer.
    const again = await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { subjectVersion: 'withdrawn-version' },
    });
    expect(again.subjectVersion).toBe('withdrawn-version');
  });

  it('the `SetNull` exemption is EXACTLY the referential action — nulling the FK while editing anything else is still refused', async () => {
    const id = await decidedGate('subj-setnull-abuse', 'approved');

    // The guard has to let `DELETE FROM "user"` null these two FKs, because
    // Postgres performs that action as an UPDATE of this row. This asserts the
    // exemption is no wider than that: the same null, plus one other edit, is
    // refused. Without this, "allow the SetNull" would be a door onto the whole
    // row — and erasing `decided_by_label` is the edit it would be used for.
    await expect(
      withWorkspaceContext(fx.ctx, async (tx) => {
        try {
          return await tx.approvalGate.update({
            where: { id },
            data: { decidedById: null, decidedByLabel: null },
          });
        } catch (err) {
          translateApprovalGateWriteError(err);
        }
      }),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);

    const after = await adminDb.approvalGate.findUnique({ where: { id } });
    expect(after?.decidedById).toBe(fx.ownerId);
    expect(after?.decidedByLabel).toBe('Zhu Yue <zhuyue11@gmail.com>');
  });

  it('re-POINTING the decider FK is refused — the exemption is to NULL, not to another user', async () => {
    const id = await decidedGate('subj-setnull-repoint', 'approved');
    const other = await createTestUser({ name: 'Someone Else' });

    await expect(
      withWorkspaceContext(fx.ctx, async (tx) => {
        try {
          return await tx.approvalGate.update({ where: { id }, data: { decidedById: other.id } });
        } catch (err) {
          translateApprovalGateWriteError(err);
        }
      }),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);

    const after = await adminDb.approvalGate.findUnique({ where: { id } });
    expect(after?.decidedById).toBe(fx.ownerId);
  });

  it('DELETE is untouched — a gate still cascades with its work item', async () => {
    const id = await decidedGate('subj-cascade', 'approved');

    // Blocking deletes would make deleting an approved card fail. Retention of
    // the SUBJECT's bytes is §6c's pin, a different mechanism; the ROW follows
    // its card.
    await adminDb.workItem.delete({ where: { id: itemId } });

    expect(await adminDb.approvalGate.findUnique({ where: { id } })).toBeNull();
  });
});

describe('decision_source accepts `github` with an UNRESOLVABLE actor', () => {
  it('a synced GitHub approval reads back with a label and a NULL decider id', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-github'), tx),
    );

    // The case §6b's amendment is written for: a reviewer with no linked Motir
    // account. `decidedById` stays null because there is no user row to point
    // at — and the label is what stops that null reading as "nobody decided it",
    // which is what `superseded` uses the same shape to mean.
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state: 'approved',
        decidedById: null,
        decidedByLabel: 'github:octocat (unmapped GitHub identity)',
        decidedAt: new Date(),
        decisionSource: 'github',
        decidedUnderAuthority: 'admin',
        subjectVersion: 'deadbee',
      },
    });

    const row = await adminDb.approvalGate.findUnique({ where: { id: gate.id } });
    expect(row).toMatchObject({
      state: 'approved',
      decisionSource: 'github',
      decidedById: null,
      decidedByLabel: 'github:octocat (unmapped GitHub identity)',
    });
  });

  it('the enum holds exactly the four surfaces the ADR names', async () => {
    const values = await adminDb.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e."enumlabel"
      FROM pg_enum e
      JOIN pg_type t ON t."oid" = e."enumtypid"
      WHERE t."typname" = 'approval_gate_decision_source'
      ORDER BY e."enumsortorder"
    `;
    expect(values.map((v) => v.enumlabel)).toEqual(['ui', 'api', 'mcp', 'github']);
  });

  it('the authority enum holds exactly §2’s three rungs', async () => {
    const values = await adminDb.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e."enumlabel"
      FROM pg_enum e
      JOIN pg_type t ON t."oid" = e."enumtypid"
      WHERE t."typname" = 'approval_gate_authority'
      ORDER BY e."enumsortorder"
    `;
    expect(values.map((v) => v.enumlabel)).toEqual(['assignee', 'reporter', 'admin']);
  });
});

describe('the DTO carries the audit set, and no Prisma model crosses the boundary', () => {
  it('maps every audit field, with dates as ISO strings', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-dto'), tx),
    );
    const decidedAt = new Date('2026-09-10T09:15:00.000Z');
    const row = await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state: 'approved',
        decidedById: fx.ownerId,
        decidedByLabel: 'Zhu Yue <zhuyue11@gmail.com>',
        decidedAt,
        noteMd: 'Ships the confirm step as drawn.',
        subjectVersion: 'a1b2c3d',
        routedToId: fx.ownerId,
        decidedUnderAuthority: 'reporter',
        decisionSource: 'mcp',
        outcomeRef: 'sha:9f8e7d6',
      },
    });

    const dto = toApprovalGateDto(row);

    expect(dto).toMatchObject({
      subjectVersion: 'a1b2c3d',
      decidedByLabel: 'Zhu Yue <zhuyue11@gmail.com>',
      routedToId: fx.ownerId,
      decidedUnderAuthority: 'reporter',
      decisionSource: 'mcp',
      outcomeRef: 'sha:9f8e7d6',
    });
    // A Date on the row is an ISO string on the wire, matching the work-items /
    // acceptance-evidence convention.
    expect(dto.decidedAt).toBe('2026-09-10T09:15:00.000Z');
    expect(typeof dto.createdAt).toBe('string');
  });

  it('exposes EXACTLY the wire shape — the tenancy columns stay behind the boundary', async () => {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(baseGate('subj-shape'), tx),
    );

    const dto = toApprovalGateDto(gate);

    // Asserted TIGHT, in both directions. Loose, this test would pass under a
    // `...row` spread — which is the one implementation that would silently ship
    // `workspaceId` / `projectId` to a client the day somebody adds a column.
    const expected: Array<keyof ApprovalGateDTO> = [
      'id',
      'workItemId',
      'kind',
      'subjectId',
      'state',
      'decidedById',
      'decidedAt',
      'noteMd',
      'subjectVersion',
      'decidedByLabel',
      'routedToId',
      'decidedUnderAuthority',
      'decisionSource',
      'outcomeRef',
      'createdAt',
      'updatedAt',
    ];
    expect(Object.keys(dto).sort()).toEqual([...expected].sort());
    expect(dto).not.toHaveProperty('workspaceId');
    expect(dto).not.toHaveProperty('projectId');
  });
});
