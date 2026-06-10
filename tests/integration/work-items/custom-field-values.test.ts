import { Prisma, type CustomFieldDefinition, type CustomFieldOption } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { customFieldValueRepository } from '@/lib/repositories/customFieldValueRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  CustomFieldInvalidDateError,
  CustomFieldInvalidNumberError,
  CustomFieldNotFoundError,
  CustomFieldOptionArchivedError,
  CustomFieldOptionNotInFieldError,
  CustomFieldTextTooLongError,
  CustomFieldUserNotAssignableError,
  CustomFieldValueTypeMismatchError,
} from '@/lib/customFields/valueErrors';
import { MAX_TEXT_VALUE_LENGTH } from '@/lib/customFields/valueLimits';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Integration tests for customFieldValuesService.setValue + the getIssueDetail
// custom-fields read (Story 5.3 · Subtask 5.3.3) against a REAL Postgres
// (Yue's no-mocks rule). The matrix the Story 5.3 verification recipe names:
// five types × (valid set / invalid set / clear / re-set), the per-type edge
// cases (decimal scale, UTC date boundary, archived-option new-write
// rejection, non-assignable user, text cap), the permission matrix (member
// sets / viewer 403 / cross-workspace 404), the revision diff per change, and
// the bounded detail read (definitions with null values still listed).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "custom_field_value", "custom_field_option", "custom_field_definition", ' +
      '"work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Insert a definition the way 5.3.2's create flow will — through the repo. */
async function makeField(
  fx: WorkItemFixture,
  over: Partial<Pick<CustomFieldDefinition, 'key' | 'label' | 'description'>> & {
    fieldType: CustomFieldDefinition['fieldType'];
    position?: string;
  },
): Promise<CustomFieldDefinition> {
  return db.$transaction((tx) =>
    customFieldDefinitionRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: over.key ?? `${over.fieldType}-field`,
        label: over.label ?? `${over.fieldType} field`,
        fieldType: over.fieldType,
        description: over.description ?? null,
        position: over.position ?? keyForAppend(null),
      },
      tx,
    ),
  );
}

async function makeOption(
  field: CustomFieldDefinition,
  label: string,
  opts: { archived?: boolean; position?: string } = {},
): Promise<CustomFieldOption> {
  return db.$transaction((tx) =>
    customFieldOptionRepository.create(
      {
        fieldId: field.id,
        label,
        position: opts.position ?? keyForAppend(null),
        archived: opts.archived ?? false,
      },
      tx,
    ),
  );
}

async function makeIssue(fx: WorkItemFixture): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Holder' },
    fx.ctx,
  );
  return dto.id;
}

/** The revisions AFTER the 'created' one — i.e. the value-set entries. */
async function valueRevisions(workItemId: string) {
  const rows = await workItemRevisionRepository.listByWorkItem(workItemId);
  return rows.filter((r) => r.changeKind === 'updated');
}

// ── text ────────────────────────────────────────────────────────────────────

describe('setValue — text', () => {
  it('sets a trimmed text value, records the customFields.<key> diff, and upserts one row', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text', key: 'customer' });
    const itemId = await makeIssue(fx);

    const dto = await customFieldValuesService.setValue(itemId, field.id, '  Acme Corp  ', fx.ctx);
    expect(dto).toMatchObject({ text: 'Acme Corp', number: null, date: null });

    const row = await customFieldValueRepository.findByWorkItemAndField(itemId, field.id);
    expect(row?.valueText).toBe('Acme Corp');
    expect(row?.workspaceId).toBe(fx.workspaceId);

    const revs = await valueRevisions(itemId);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.diff).toEqual({ 'customFields.customer': { from: null, to: 'Acme Corp' } });
    expect(revs[0]!.changedById).toBe(fx.ctx.userId);
  });

  it('re-setting the SAME value is a no-op: no write, no revision', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, field.id, 'same', fx.ctx);
    const dto = await customFieldValuesService.setValue(itemId, field.id, 'same', fx.ctx);
    expect(dto?.text).toBe('same');
    expect(await valueRevisions(itemId)).toHaveLength(1);
  });

  it('clears via null — the row is DELETED (no tombstone) and the diff records to: null', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text', key: 'customer' });
    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, field.id, 'Acme', fx.ctx);

    const cleared = await customFieldValuesService.setValue(itemId, field.id, null, fx.ctx);
    expect(cleared).toBeNull();
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();

    const revs = await valueRevisions(itemId);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.diff).toEqual({ 'customFields.customer': { from: 'Acme', to: null } });
  });

  it('a trimmed-empty string clears like null; clearing an already-empty field is a no-op', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);

    // Clear on empty — nothing recorded.
    expect(await customFieldValuesService.setValue(itemId, field.id, null, fx.ctx)).toBeNull();
    expect(await customFieldValuesService.setValue(itemId, field.id, '   ', fx.ctx)).toBeNull();
    expect(await valueRevisions(itemId)).toHaveLength(0);

    // Empty string clears a real value.
    await customFieldValuesService.setValue(itemId, field.id, 'x', fx.ctx);
    expect(await customFieldValuesService.setValue(itemId, field.id, '  ', fx.ctx)).toBeNull();
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();
  });

  it('rejects over-cap text (422) and a non-string raw value (type mismatch); nothing persists', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);

    await expect(
      customFieldValuesService.setValue(
        itemId,
        field.id,
        'x'.repeat(MAX_TEXT_VALUE_LENGTH + 1),
        fx.ctx,
      ),
    ).rejects.toThrow(CustomFieldTextTooLongError);
    await expect(customFieldValuesService.setValue(itemId, field.id, 42, fx.ctx)).rejects.toThrow(
      CustomFieldValueTypeMismatchError,
    );
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();
    expect(await valueRevisions(itemId)).toHaveLength(0);
  });

  it('accepts text exactly AT the cap', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);
    const atCap = 'x'.repeat(MAX_TEXT_VALUE_LENGTH);
    const dto = await customFieldValuesService.setValue(itemId, field.id, atCap, fx.ctx);
    expect(dto?.text).toBe(atCap);
  });
});

// ── number ──────────────────────────────────────────────────────────────────

describe('setValue — number', () => {
  it('stores a decimal from a string form (scale-safe) and from a JS number', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'number', key: 'effort' });
    const itemId = await makeIssue(fx);

    const fromString = await customFieldValuesService.setValue(itemId, field.id, '1.50', fx.ctx);
    expect(fromString?.number).toBe(1.5);
    const row = await customFieldValueRepository.findByWorkItemAndField(itemId, field.id);
    expect(row!.valueNumber!.equals(new Prisma.Decimal('1.5'))).toBe(true);

    const fromNumber = await customFieldValuesService.setValue(itemId, field.id, 3, fx.ctx);
    expect(fromNumber?.number).toBe(3);

    const revs = await valueRevisions(itemId);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.diff).toEqual({ 'customFields.effort': { from: '1.5', to: '3' } });
  });

  it('re-setting an equal decimal ("3" then 3.0) is a no-op', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'number' });
    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, field.id, '3', fx.ctx);
    await customFieldValuesService.setValue(itemId, field.id, 3.0, fx.ctx);
    expect(await valueRevisions(itemId)).toHaveLength(1);
  });

  it('rejects NaN / ±∞ / non-numeric and exponent strings (422); clear works', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'number' });
    const itemId = await makeIssue(fx);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        customFieldValuesService.setValue(itemId, field.id, bad, fx.ctx),
      ).rejects.toThrow(CustomFieldInvalidNumberError);
    }
    for (const bad of ['abc', '1e5', '1.', '.5', '']) {
      await expect(
        customFieldValuesService.setValue(itemId, field.id, bad, fx.ctx),
      ).rejects.toThrow(CustomFieldInvalidNumberError);
    }

    await customFieldValuesService.setValue(itemId, field.id, '-2.25', fx.ctx);
    expect(await customFieldValuesService.setValue(itemId, field.id, null, fx.ctx)).toBeNull();
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();
  });
});

// ── date ────────────────────────────────────────────────────────────────────

describe('setValue — date', () => {
  it('accepts date-only ISO and the dueDate UTC-midnight instant form; stores UTC-safe', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'date', key: 'golive' });
    const itemId = await makeIssue(fx);

    const dto = await customFieldValuesService.setValue(itemId, field.id, '2026-07-01', fx.ctx);
    expect(dto?.date).toBe('2026-07-01T00:00:00.000Z');

    // The rail's full-ISO form lands on the same instant → re-set is a no-op.
    await customFieldValuesService.setValue(itemId, field.id, '2026-07-01T00:00:00.000Z', fx.ctx);
    expect(await valueRevisions(itemId)).toHaveLength(1);
    expect((await valueRevisions(itemId))[0]!.diff).toEqual({
      'customFields.golive': { from: null, to: '2026-07-01T00:00:00.000Z' },
    });
  });

  it('rejects non-calendar dates and non-date strings (422)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'date' });
    const itemId = await makeIssue(fx);
    for (const bad of [
      '2026-02-30',
      '02/03/2026',
      'tomorrow',
      '2026-7-1',
      '2026-07-01T12:00:00Z',
    ]) {
      await expect(
        customFieldValuesService.setValue(itemId, field.id, bad, fx.ctx),
      ).rejects.toThrow(CustomFieldInvalidDateError);
    }
    await expect(
      customFieldValuesService.setValue(itemId, field.id, 20260701, fx.ctx),
    ).rejects.toThrow(CustomFieldValueTypeMismatchError);
  });
});

// ── select ──────────────────────────────────────────────────────────────────

describe('setValue — select', () => {
  it('sets an active option; the diff records LABELS (from/to), not ids', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'select', key: 'severity' });
    const high = await makeOption(field, 'High');
    const low = await makeOption(field, 'Low', { position: keyForAppend(keyForAppend(null)) });
    const itemId = await makeIssue(fx);

    const dto = await customFieldValuesService.setValue(itemId, field.id, high.id, fx.ctx);
    expect(dto?.option).toEqual({ id: high.id, label: 'High', archived: false });

    await customFieldValuesService.setValue(itemId, field.id, low.id, fx.ctx);
    const revs = await valueRevisions(itemId);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.diff).toEqual({ 'customFields.severity': { from: 'High', to: 'Low' } });
  });

  it('rejects an archived option on a NEW write, a cross-field option, and an unknown id (422)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'select', key: 'severity' });
    const archived = await makeOption(field, 'Legacy', { archived: true });
    const other = await makeField(fx, { fieldType: 'select', key: 'other' });
    const otherOpt = await makeOption(other, 'Elsewhere');
    const itemId = await makeIssue(fx);

    await expect(
      customFieldValuesService.setValue(itemId, field.id, archived.id, fx.ctx),
    ).rejects.toThrow(CustomFieldOptionArchivedError);
    await expect(
      customFieldValuesService.setValue(itemId, field.id, otherOpt.id, fx.ctx),
    ).rejects.toThrow(CustomFieldOptionNotInFieldError);
    await expect(
      customFieldValuesService.setValue(itemId, field.id, 'nope', fx.ctx),
    ).rejects.toThrow(CustomFieldOptionNotInFieldError);
  });

  it('an EXISTING value holding a since-archived option stays valid: re-set is a no-op, the DTO carries the archived mark', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'select' });
    const opt = await makeOption(field, 'Soon-gone');
    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, field.id, opt.id, fx.ctx);

    await db.$transaction((tx) =>
      customFieldOptionRepository.update(opt.id, { archived: true }, tx),
    );

    // Re-setting the same archived option changes nothing — no error, no revision.
    const dto = await customFieldValuesService.setValue(itemId, field.id, opt.id, fx.ctx);
    expect(dto?.option).toEqual({ id: opt.id, label: 'Soon-gone', archived: true });
    expect(await valueRevisions(itemId)).toHaveLength(1);
  });
});

// ── user ────────────────────────────────────────────────────────────────────

describe('setValue — user', () => {
  it('sets a workspace member who can view the project; the diff records the user id', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'user', key: 'stakeholder' });
    const member = await createTestUser({ email: 'member@ex.com', name: 'Member' });
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const itemId = await makeIssue(fx);

    const dto = await customFieldValuesService.setValue(itemId, field.id, member.id, fx.ctx);
    expect(dto?.user).toEqual({ id: member.id, name: 'Member', image: null });

    const revs = await valueRevisions(itemId);
    expect(revs[0]!.diff).toEqual({ 'customFields.stakeholder': { from: null, to: member.id } });
  });

  it('rejects a non-workspace-member (422 USER_NOT_ASSIGNABLE)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'user' });
    const outsider = await createTestUser({ email: 'outsider@ex.com', name: 'Out' });
    const itemId = await makeIssue(fx);
    await expect(
      customFieldValuesService.setValue(itemId, field.id, outsider.id, fx.ctx),
    ).rejects.toThrow(CustomFieldUserNotAssignableError);
  });
});

// ── permissions + tenancy ──────────────────────────────────────────────────

describe('setValue — permission matrix', () => {
  it('a project VIEWER is rejected with the edit-denied 403 error', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);

    const viewer = await createTestUser({ email: 'viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await db.$transaction((tx) =>
      projectMembershipRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          userId: viewer.id,
          role: 'viewer',
        },
        tx,
      ),
    );

    await expect(
      customFieldValuesService.setValue(itemId, field.id, 'nope', {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toThrow(ProjectAccessDeniedError);
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();
  });

  it('cross-workspace probes 404: a foreign work item, a foreign field, and a same-workspace field of ANOTHER project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const myField = await makeField(fx, { fieldType: 'text' });
    const theirField = await makeField(other, { fieldType: 'text', key: 'theirs' });
    const myItem = await makeIssue(fx);
    const theirItem = await makeIssue(other);

    // Foreign work item → WorkItemNotFoundError (no existence leak).
    await expect(
      customFieldValuesService.setValue(theirItem, myField.id, 'x', fx.ctx),
    ).rejects.toThrow(WorkItemNotFoundError);
    // Foreign field on my item → CustomFieldNotFoundError.
    await expect(
      customFieldValuesService.setValue(myItem, theirField.id, 'x', fx.ctx),
    ).rejects.toThrow(CustomFieldNotFoundError);

    // Same workspace, different project: the field is absent from this issue's vantage.
    const secondProject = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Second',
    });
    const crossProjectField = await db.$transaction((tx) =>
      customFieldDefinitionRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: secondProject.id,
          key: 'cross',
          label: 'Cross',
          fieldType: 'text',
          position: keyForAppend(null),
        },
        tx,
      ),
    );
    await expect(
      customFieldValuesService.setValue(myItem, crossProjectField.id, 'x', fx.ctx),
    ).rejects.toThrow(CustomFieldNotFoundError);
  });

  it('concurrent sets on the same pair converge to ONE row (the upsert target)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);

    await Promise.all([
      customFieldValuesService.setValue(itemId, field.id, 'first', fx.ctx),
      customFieldValuesService.setValue(itemId, field.id, 'second', fx.ctx),
    ]);
    const count = await db.customFieldValue.count({ where: { workItemId: itemId } });
    expect(count).toBe(1);
  });
});

// ── the detail read ─────────────────────────────────────────────────────────

describe('getIssueDetail — customFields', () => {
  it('returns definitions in position order with resolved values; unset fields ship value: null', async () => {
    const fx = await makeWorkItemFixture();
    const p1 = keyForAppend(null);
    const p2 = keyForAppend(p1);
    const p3 = keyForAppend(p2);
    const severity = await makeField(fx, {
      fieldType: 'select',
      key: 'severity',
      label: 'Severity',
      position: p1,
    });
    const high = await makeOption(severity, 'High');
    await makeField(fx, { fieldType: 'number', key: 'effort', label: 'Effort', position: p2 });
    const stakeholder = await makeField(fx, {
      fieldType: 'user',
      key: 'stakeholder',
      label: 'Stakeholder',
      position: p3,
    });

    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, severity.id, high.id, fx.ctx);
    await customFieldValuesService.setValue(itemId, stakeholder.id, fx.ownerId, fx.ctx);

    const item = await workItemsService.getWorkItem(itemId, fx.ctx);
    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);

    expect(detail.customFields.map((f) => f.key)).toEqual(['severity', 'effort', 'stakeholder']);
    const [sev, eff, stk] = detail.customFields;
    expect(sev!.fieldType).toBe('select');
    expect(sev!.options).toEqual([{ id: high.id, label: 'High', archived: false }]);
    expect(sev!.value?.option).toEqual({ id: high.id, label: 'High', archived: false });
    expect(eff!.value).toBeNull(); // definition still listed — "Show more fields" needs it
    expect(stk!.value?.user).toMatchObject({ id: fx.ownerId });
  });

  it('an issue in a project with NO definitions gets customFields: []', async () => {
    const fx = await makeWorkItemFixture();
    const itemId = await makeIssue(fx);
    const item = await workItemsService.getWorkItem(itemId, fx.ctx);
    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    expect(detail.customFields).toEqual([]);
  });

  it("another issue in the same project does NOT see the first issue's values", async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text', key: 'customer' });
    const a = await makeIssue(fx);
    const b = await makeIssue(fx);
    await customFieldValuesService.setValue(a, field.id, 'Acme', fx.ctx);

    const itemB = await workItemsService.getWorkItem(b, fx.ctx);
    const detail = await workItemsService.getIssueDetail(fx.projectId, itemB.identifier, fx.ctx);
    expect(detail.customFields[0]!.value).toBeNull();
  });
});

// ── cascades (the 5.3.1 substrate, exercised through the service) ───────────

describe('lifecycle — field delete destroys values', () => {
  it("deleting the definition cascades this issue's value row", async () => {
    const fx = await makeWorkItemFixture();
    const field = await makeField(fx, { fieldType: 'text' });
    const itemId = await makeIssue(fx);
    await customFieldValuesService.setValue(itemId, field.id, 'gone soon', fx.ctx);

    await db.$transaction((tx) => customFieldDefinitionRepository.delete(field.id, tx));
    expect(await customFieldValueRepository.findByWorkItemAndField(itemId, field.id)).toBeNull();
  });
});
