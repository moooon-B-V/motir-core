import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CustomFieldDefinition, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { customFieldValueRepository } from '@/lib/repositories/customFieldValueRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the custom-fields data-access leaves (Story 5.3
// · Subtask 5.3.1): customFieldDefinitionRepository /
// customFieldOptionRepository / customFieldValueRepository, plus the
// schema-level guarantees the migration carries — the delete cascades (field
// → options + values; issue → values), the value→option ON DELETE RESTRICT
// backstopping the only-when-unused rule, the value→user SET NULL, and the
// one-value-per-(issue, field) unique that makes the upsert converge. Real
// Postgres (no mocks), per CLAUDE.md. They run as the dev/CI superuser via
// the `db` singleton (RLS is inert under BYPASSRLS — the policies are
// exercised separately under the prodect_app role, the multi-tenant-rls
// suite's pattern); what's proven here is the repository contract — incl.
// the explicit-workspaceId gates (finding #26) — and the migration-built
// constraints. Writes run inside a real `db.$transaction` to exercise the
// required-`tx` path.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades workspace → project → custom_field_definition →
  // custom_field_option, and workspace → work_item → custom_field_value
  // (all FK chains with onDelete: Cascade), so no dedicated truncate is
  // needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface FieldFixture {
  fx: WorkItemFixture;
  issue: WorkItem;
}

async function makeFieldFixture(): Promise<FieldFixture> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Field-bearing task' });
  return { fx, issue };
}

/** Insert one definition through the repository's required-`tx` write path. */
async function addField(
  f: FieldFixture,
  input: Partial<{
    key: string;
    label: string;
    fieldType: 'text' | 'number' | 'date' | 'select' | 'user';
    position: string;
    description: string;
  }> = {},
): Promise<CustomFieldDefinition> {
  return db.$transaction(async (tx) =>
    customFieldDefinitionRepository.create(
      {
        workspaceId: f.fx.workspaceId,
        projectId: f.fx.projectId,
        key: input.key ?? 'severity',
        label: input.label ?? 'Severity',
        fieldType: input.fieldType ?? 'select',
        position: input.position ?? 'a0',
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      tx,
    ),
  );
}

/** Insert one option through the repository's required-`tx` write path. */
async function addOption(fieldId: string, label: string, position: string, archived = false) {
  return db.$transaction(async (tx) =>
    customFieldOptionRepository.create({ fieldId, label, position, archived }, tx),
  );
}

/** Upsert one value through the repository's required-`tx` write path. */
async function setValue(
  f: FieldFixture,
  fieldId: string,
  columns: Partial<{
    valueText: string | null;
    valueNumber: number | string | null;
    valueDate: Date | null;
    valueUserId: string | null;
    valueOptionId: string | null;
  }>,
  workItemId = f.issue.id,
) {
  return db.$transaction(async (tx) =>
    customFieldValueRepository.upsert(
      workItemId,
      fieldId,
      {
        workspaceId: f.fx.workspaceId,
        valueText: columns.valueText ?? null,
        valueNumber: columns.valueNumber ?? null,
        valueDate: columns.valueDate ?? null,
        valueUserId: columns.valueUserId ?? null,
        valueOptionId: columns.valueOptionId ?? null,
      },
      tx,
    ),
  );
}

describe('customFieldDefinitionRepository', () => {
  it('create persists a definition with its key/type/position', async () => {
    const f = await makeFieldFixture();
    const row = await addField(f, {
      key: 'customer',
      label: 'Customer',
      fieldType: 'text',
      description: 'Who reported it',
    });
    expect(row.workspaceId).toBe(f.fx.workspaceId);
    expect(row.projectId).toBe(f.fx.projectId);
    expect(row.key).toBe('customer');
    expect(row.fieldType).toBe('text');
    expect(row.description).toBe('Who reported it');
  });

  it('findById returns the row only under its own workspace (finding #26)', async () => {
    const f = await makeFieldFixture();
    const row = await addField(f);
    expect((await customFieldDefinitionRepository.findById(row.id, f.fx.workspaceId))?.id).toBe(
      row.id,
    );
    // Cross-workspace probe → null (the service maps it to 404), unknown → null.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await customFieldDefinitionRepository.findById(row.id, other.workspaceId)).toBeNull();
    expect(await customFieldDefinitionRepository.findById('nope', f.fx.workspaceId)).toBeNull();
  });

  it('update patches label/position; the key column stays untouched', async () => {
    const f = await makeFieldFixture();
    const row = await addField(f, { label: 'Sev', position: 'a0' });
    const updated = await db.$transaction(async (tx) =>
      customFieldDefinitionRepository.update(row.id, { label: 'Severity', position: 'a2' }, tx),
    );
    expect(updated.label).toBe('Severity');
    expect(updated.position).toBe('a2');
    expect(updated.key).toBe(row.key);
  });

  it('listByProject returns the project fields in position order, workspace-gated', async () => {
    const f = await makeFieldFixture();
    await addField(f, { key: 'b-field', label: 'B', position: 'a1' });
    await addField(f, { key: 'a-field', label: 'A', position: 'a0' });
    const listed = await customFieldDefinitionRepository.listByProject(
      f.fx.projectId,
      f.fx.workspaceId,
    );
    expect(listed.map((d) => d.key)).toEqual(['a-field', 'b-field']);
    // Right projectId + wrong workspaceId → [] (not another tenant's rows).
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await customFieldDefinitionRepository.listByProject(f.fx.projectId, other.workspaceId),
    ).toEqual([]);
  });

  it('countByProject counts this project only, inside or outside a transaction', async () => {
    const f = await makeFieldFixture();
    await addField(f, { key: 'one', position: 'a0' });
    await addField(f, { key: 'two', position: 'a1' });
    expect(
      await customFieldDefinitionRepository.countByProject(f.fx.projectId, f.fx.workspaceId),
    ).toBe(2);
    // The tx branch — the 5.3.2 cap check runs inside the create transaction.
    const inTx = await db.$transaction(async (tx) =>
      customFieldDefinitionRepository.countByProject(f.fx.projectId, f.fx.workspaceId, tx),
    );
    expect(inTx).toBe(2);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await customFieldDefinitionRepository.countByProject(f.fx.projectId, other.workspaceId),
    ).toBe(0);
  });

  it('delete hard-deletes the field and cascades its options AND stored values', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    const opt = await addOption(field.id, 'High', 'a0');
    await setValue(f, field.id, { valueOptionId: opt.id });

    await db.$transaction(async (tx) => customFieldDefinitionRepository.delete(field.id, tx));

    expect(await customFieldDefinitionRepository.findById(field.id, f.fx.workspaceId)).toBeNull();
    expect(await db.customFieldOption.count({ where: { fieldId: field.id } })).toBe(0);
    expect(await db.customFieldValue.count({ where: { fieldId: field.id } })).toBe(0);
    // The issue itself is untouched — only the field's data dies.
    expect(await db.workItem.count({ where: { id: f.issue.id } })).toBe(1);
  });
});

describe('customFieldOptionRepository', () => {
  it('create + listByField return options in position order, archived rows included', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    await addOption(field.id, 'Low', 'a1');
    await addOption(field.id, 'High', 'a0');
    await addOption(field.id, 'Retired', 'a2', true);

    const listed = await customFieldOptionRepository.listByField(field.id, f.fx.workspaceId);
    // Archived options STAY in the read — existing values referencing them
    // must keep rendering; excluding them from new selection is a UI concern.
    expect(listed.map((o) => o.label)).toEqual(['High', 'Low', 'Retired']);
    expect(listed[2]?.archived).toBe(true);
  });

  it('reads are workspace-gated through the parent definition (finding #26)', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    const opt = await addOption(field.id, 'High', 'a0');
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });

    expect((await customFieldOptionRepository.findById(opt.id, f.fx.workspaceId))?.id).toBe(opt.id);
    expect(await customFieldOptionRepository.findById(opt.id, other.workspaceId)).toBeNull();
    expect(await customFieldOptionRepository.listByField(field.id, other.workspaceId)).toEqual([]);
    expect(await customFieldOptionRepository.countByField(field.id, other.workspaceId)).toBe(0);
  });

  it('update renames, reorders, and flips the archived bit', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    const opt = await addOption(field.id, 'Hgh', 'a0');
    const updated = await db.$transaction(async (tx) =>
      customFieldOptionRepository.update(
        opt.id,
        { label: 'High', position: 'a3', archived: true },
        tx,
      ),
    );
    expect(updated.label).toBe('High');
    expect(updated.position).toBe('a3');
    expect(updated.archived).toBe(true);
    // Unarchive is the free inverse.
    const back = await db.$transaction(async (tx) =>
      customFieldOptionRepository.update(opt.id, { archived: false }, tx),
    );
    expect(back.archived).toBe(false);
  });

  it('countByField counts the field’s options, inside or outside a transaction', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    await addOption(field.id, 'A', 'a0');
    await addOption(field.id, 'B', 'a1');
    expect(await customFieldOptionRepository.countByField(field.id, f.fx.workspaceId)).toBe(2);
    const inTx = await db.$transaction(async (tx) =>
      customFieldOptionRepository.countByField(field.id, f.fx.workspaceId, tx),
    );
    expect(inTx).toBe(2);
  });

  it('delete removes an UNUSED option; an in-use option is DB-rejected (Restrict)', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    const unused = await addOption(field.id, 'Unused', 'a0');
    const inUse = await addOption(field.id, 'InUse', 'a1');
    await setValue(f, field.id, { valueOptionId: inUse.id });

    await db.$transaction(async (tx) => customFieldOptionRepository.delete(unused.id, tx));
    expect(await customFieldOptionRepository.findById(unused.id, f.fx.workspaceId)).toBeNull();

    // The only-when-unused rule's DB backstop: the value FK's ON DELETE
    // RESTRICT rejects the hard delete while a value row holds the option.
    await expect(
      db.$transaction(async (tx) => customFieldOptionRepository.delete(inUse.id, tx)),
    ).rejects.toMatchObject({ code: 'P2003' });
    // The value row (and the option) survive the rejected delete.
    expect((await customFieldOptionRepository.findById(inUse.id, f.fx.workspaceId))?.id).toBe(
      inUse.id,
    );
    expect(await customFieldValueRepository.countByOption(inUse.id, f.fx.workspaceId)).toBe(1);
  });
});

describe('customFieldValueRepository', () => {
  it('upsert creates the pair’s row with exactly the columns passed', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f, { key: 'effort', fieldType: 'number' });
    const row = await setValue(f, field.id, { valueNumber: '3.5' });
    expect(row.workItemId).toBe(f.issue.id);
    expect(row.fieldId).toBe(field.id);
    expect(row.valueNumber?.toString()).toBe('3.5');
    expect(row.valueText).toBeNull();
    expect(row.valueDate).toBeNull();
    expect(row.valueUserId).toBeNull();
    expect(row.valueOptionId).toBeNull();
  });

  it('upsert converges on the one-row-per-pair unique and overwrites the FULL column image', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f, { key: 'customer', fieldType: 'text' });
    await setValue(f, field.id, { valueText: 'ACME' });
    // Re-set through the same upsert: every per-type column is rewritten, so
    // the previous type's value never survives (the 5.3.3 full-image rule).
    const after = await setValue(f, field.id, { valueNumber: 7 });
    expect(after.valueText).toBeNull();
    expect(after.valueNumber?.toString()).toBe('7');
    // Still ONE row for the pair — the unique is the conflict target.
    expect(
      await db.customFieldValue.count({ where: { workItemId: f.issue.id, fieldId: field.id } }),
    ).toBe(1);
    // And the constraint itself rejects a second row for the pair (P2002).
    await expect(
      db.$transaction(async (tx) =>
        tx.customFieldValue.create({
          data: {
            workspaceId: f.fx.workspaceId,
            workItemId: f.issue.id,
            fieldId: field.id,
            valueText: 'dup',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('stores date values date-only and user values by FK', async () => {
    const f = await makeFieldFixture();
    const dateField = await addField(f, { key: 'go-live', fieldType: 'date', position: 'a0' });
    const userField = await addField(f, { key: 'stakeholder', fieldType: 'user', position: 'a1' });
    const stakeholder = await createTestUser({ name: 'Bo' });

    const dated = await setValue(f, dateField.id, {
      valueDate: new Date('2026-07-01T00:00:00.000Z'),
    });
    // @db.Date truncates to the day — the UTC date-only convention.
    expect(dated.valueDate?.toISOString()).toBe('2026-07-01T00:00:00.000Z');

    const held = await setValue(f, userField.id, { valueUserId: stakeholder.id });
    expect(held.valueUserId).toBe(stakeholder.id);
  });

  it('deleting the value’s user SETS NULL — clears the value, never blocks', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f, { key: 'stakeholder', fieldType: 'user' });
    const stakeholder = await createTestUser({ name: 'Leaving' });
    const row = await setValue(f, field.id, { valueUserId: stakeholder.id });

    await db.user.delete({ where: { id: stakeholder.id } });

    const after = await db.customFieldValue.findUnique({ where: { id: row.id } });
    expect(after?.valueUserId).toBeNull();
  });

  it('deleteByWorkItemAndField clears the row and is idempotent (no tombstones)', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f, { key: 'customer', fieldType: 'text' });
    await setValue(f, field.id, { valueText: 'ACME' });

    const first = await db.$transaction(async (tx) =>
      customFieldValueRepository.deleteByWorkItemAndField(f.issue.id, field.id, tx),
    );
    expect(first).toBe(1);
    expect(
      await db.customFieldValue.count({ where: { workItemId: f.issue.id, fieldId: field.id } }),
    ).toBe(0);
    // Clearing an already-empty field is a no-op, not a throw.
    const second = await db.$transaction(async (tx) =>
      customFieldValueRepository.deleteByWorkItemAndField(f.issue.id, field.id, tx),
    );
    expect(second).toBe(0);
  });

  it('listByWorkItem returns one issue’s rows, workspace-gated (finding #26)', async () => {
    const f = await makeFieldFixture();
    const fieldA = await addField(f, { key: 'a', fieldType: 'text', position: 'a0' });
    const fieldB = await addField(f, { key: 'b', fieldType: 'text', position: 'a1' });
    const sibling = await createTestWorkItem(f.fx, { kind: 'task', title: 'Sibling' });
    await setValue(f, fieldA.id, { valueText: 'on issue' });
    await setValue(f, fieldB.id, { valueText: 'also on issue' });
    await setValue(f, fieldA.id, { valueText: 'on sibling' }, sibling.id);

    const listed = await customFieldValueRepository.listByWorkItem(f.issue.id, f.fx.workspaceId);
    expect(listed).toHaveLength(2);
    expect(listed.every((v) => v.workItemId === f.issue.id)).toBe(true);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await customFieldValueRepository.listByWorkItem(f.issue.id, other.workspaceId)).toEqual(
      [],
    );
    // The tx branch — 5.3.3 may read inside its set transaction.
    const inTx = await db.$transaction(async (tx) =>
      customFieldValueRepository.listByWorkItem(f.issue.id, f.fx.workspaceId, tx),
    );
    expect(inTx).toHaveLength(2);
  });

  it('countByField names the delete-confirm number; countByOption guards only-when-unused', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f);
    const opt = await addOption(field.id, 'High', 'a0');
    const sibling = await createTestWorkItem(f.fx, { kind: 'task', title: 'Sibling' });
    await setValue(f, field.id, { valueOptionId: opt.id });
    await setValue(f, field.id, { valueOptionId: opt.id }, sibling.id);

    expect(await customFieldValueRepository.countByField(field.id, f.fx.workspaceId)).toBe(2);
    expect(await customFieldValueRepository.countByOption(opt.id, f.fx.workspaceId)).toBe(2);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await customFieldValueRepository.countByField(field.id, other.workspaceId)).toBe(0);
    expect(await customFieldValueRepository.countByOption(opt.id, other.workspaceId)).toBe(0);
    // The tx branches — both counts run inside their write transactions.
    const [fieldCount, optionCount] = await db.$transaction(async (tx) => [
      await customFieldValueRepository.countByField(field.id, f.fx.workspaceId, tx),
      await customFieldValueRepository.countByOption(opt.id, f.fx.workspaceId, tx),
    ]);
    expect(fieldCount).toBe(2);
    expect(optionCount).toBe(2);
  });

  it('deleting the ISSUE cascades its value rows (values die with the issue)', async () => {
    const f = await makeFieldFixture();
    const field = await addField(f, { key: 'customer', fieldType: 'text' });
    await setValue(f, field.id, { valueText: 'ACME' });

    await db.workItem.delete({ where: { id: f.issue.id } });

    expect(await db.customFieldValue.count({ where: { workItemId: f.issue.id } })).toBe(0);
    // The definition survives — only the issue's values die.
    expect((await customFieldDefinitionRepository.findById(field.id, f.fx.workspaceId))?.id).toBe(
      field.id,
    );
  });
});
