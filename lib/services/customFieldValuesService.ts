import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import {
  customFieldValueRepository,
  type CustomFieldValueWithRefs,
} from '@/lib/repositories/customFieldValueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { toCustomFieldValueDto } from '@/lib/mappers/customFieldValueMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
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
import type { CustomFieldValueDto, SetCustomFieldValueInput } from '@/lib/dto/customFieldValues';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// customFieldValuesService — the VALUES half of the custom-fields domain
// (Story 5.3 · Subtask 5.3.3): per-type validated set/clear of one issue's
// value for one field, with the `customFields.<key>` revision diff riding the
// same transaction (the 1.4.6 contract — History 5.5 renders these, the
// parity Jira's changelog has). The DEFINITIONS half (field/option CRUD, the
// 50/55 caps, the admin gate) is 5.3.2's customFieldsService — dispatched in
// parallel, so the halves keep disjoint modules.
//
// Permission matrix = exactly an issue edit's: the actor must be able to EDIT
// the project (projectAccessService.assertCanEdit — viewer → 403, hidden
// project → 404 'browse'); a cross-workspace work item or field 404s before
// anything else (no existence leak, finding #44). The work-item row is
// FOR-UPDATE locked for the duration so the read-derived revision diff
// (`from` = the row the write replaces) can't race a concurrent set on the
// same issue (the lock-before-read-derived-update rule); the pair upsert
// additionally converges duplicate-row races at the DB layer.

/** The full column image — exactly ONE member non-null (null clears = delete). */
interface ValueColumns {
  valueText: string | null;
  valueNumber: Prisma.Decimal | null;
  valueDate: Date | null;
  valueUserId: string | null;
  valueOptionId: string | null;
}

const EMPTY_COLUMNS: ValueColumns = {
  valueText: null,
  valueNumber: null,
  valueDate: null,
  valueUserId: null,
  valueOptionId: null,
};

/** Strict decimal shape — what the Decimal column accepts from a string form. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Date-only ISO, optionally carrying the rail's UTC-midnight instant suffix. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;

/**
 * Parse a `number` input into the Decimal column's value. A string form is
 * accepted (and preferred by the editor) because it preserves the user's
 * scale ("1.50") — a JS number can't. Rejects NaN / ±∞ / non-numeric strings.
 */
function parseNumberValue(raw: string | number): Prisma.Decimal {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new CustomFieldInvalidNumberError();
    return new Prisma.Decimal(raw);
  }
  if (!DECIMAL_RE.test(raw.trim())) throw new CustomFieldInvalidNumberError();
  return new Prisma.Decimal(raw.trim());
}

/**
 * Parse a `date` input into the @db.Date column's value — date-only ISO,
 * UTC-safe (the dueDate `T00:00:00.000Z` convention: the stored instant is
 * UTC midnight, so no local-timezone off-by-one anywhere in the pipeline).
 * The calendar is validated by round-trip (rejects 2026-02-30).
 */
function parseDateValue(raw: string): Date {
  const m = DATE_ONLY_RE.exec(raw.trim());
  if (!m) throw new CustomFieldInvalidDateError();
  const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`
  ) {
    throw new CustomFieldInvalidDateError();
  }
  return parsed;
}

/** The display-friendly diff cell value: option LABEL, user id, raw scalar. */
type DiffScalar = string | null;

function diffValueOf(row: CustomFieldValueWithRefs | null): DiffScalar {
  if (!row) return null;
  if (row.valueText !== null) return row.valueText;
  if (row.valueNumber !== null) return row.valueNumber.toString();
  if (row.valueDate !== null) return row.valueDate.toISOString();
  if (row.valueOptionId !== null) return row.valueOption?.label ?? row.valueOptionId;
  if (row.valueUserId !== null) return row.valueUserId;
  return null;
}

/** Column-level equality — the no-op check (no write, no revision, no error). */
function sameColumns(row: CustomFieldValueWithRefs | null, next: ValueColumns): boolean {
  if (!row) {
    return (
      next.valueText === null &&
      next.valueNumber === null &&
      next.valueDate === null &&
      next.valueUserId === null &&
      next.valueOptionId === null
    );
  }
  return (
    row.valueText === next.valueText &&
    (row.valueNumber === null
      ? next.valueNumber === null
      : next.valueNumber !== null && row.valueNumber.equals(next.valueNumber)) &&
    (row.valueDate?.getTime() ?? null) === (next.valueDate?.getTime() ?? null) &&
    row.valueUserId === next.valueUserId &&
    row.valueOptionId === next.valueOptionId
  );
}

export const customFieldValuesService = {
  /**
   * Set (or clear, with `null`) ONE issue's value for ONE custom field.
   * Validation is per the field's type — the service is the authority:
   *   text   → string, trimmed, ≤ MAX_TEXT_VALUE_LENGTH (a trimmed-empty
   *            string clears, the no-tombstone rule's input-normal form);
   *   number → finite decimal (string form preserves scale) into Decimal;
   *   date   → date-only ISO, UTC-safe (the dueDate convention);
   *   select → an option OF THIS FIELD, not archived for NEW writes (an issue
   *            already holding an archived option keeps it — re-setting the
   *            same option is a no-op, switching back to it is rejected);
   *   user   → a workspace member who can VIEW the project (the 6.4
   *            assignableMembersService scoping — assignee/mention rule).
   * Non-null → upsert the [workItemId, fieldId] row (full column image, one
   * non-null); null → DELETE the row (no tombstones). The same transaction
   * writes the 1.4.6 revision entry — diff `{ "customFields.<key>": { from,
   * to } }` with display-friendly scalars (option label / user id / raw
   * value), changeKind 'updated'. A no-op set writes nothing and records
   * nothing. Returns the resolved value DTO (null after a clear).
   */
  async setValue(
    workItemId: string,
    fieldId: string,
    rawValue: SetCustomFieldValueInput,
    ctx: ServiceContext,
  ): Promise<CustomFieldValueDto | null> {
    // Tenant gates first — 404, no existence leak (finding #44).
    const item = await workItemRepository.findById(workItemId);
    if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
    const field = await customFieldDefinitionRepository.findById(fieldId, ctx.workspaceId);
    // A field of a DIFFERENT project is, from this issue's vantage, absent.
    if (!field || field.projectId !== item.projectId) throw new CustomFieldNotFoundError(fieldId);

    // Normalize a text clear: a trimmed-empty string IS a clear (no empty rows).
    let raw = rawValue;
    if (field.fieldType === 'text' && typeof raw === 'string' && raw.trim() === '') raw = null;

    // The user-type membership read is reference data resolved BEFORE the
    // transaction (the resolveDescriptionMentionable precedent — the
    // assignable list opens its own workspace-context tx and cannot nest).
    let assignableIds: Set<string> | null = null;
    if (field.fieldType === 'user' && raw !== null) {
      if (typeof raw !== 'string') throw new CustomFieldValueTypeMismatchError(field.fieldType);
      const project = await projectRepository.findById(item.projectId);
      if (!project) throw new WorkItemNotFoundError(workItemId);
      const members = await assignableMembersService.list({
        projectId: project.id,
        accessLevel: project.accessLevel,
        ctx,
      });
      assignableIds = new Set(members.map((m) => m.userId));
    }

    const result = await db.$transaction(async (tx) => {
      // Serialize value edits per issue: the revision diff below is derived
      // from the current row, so the compare-then-write must be race-free.
      const locked = await workItemRepository.lockById(workItemId, tx);
      if (!locked) throw new WorkItemNotFoundError(workItemId);

      // Who edits the issue edits values: viewer → 403 'edit', a project the
      // actor can't even browse → 404 'browse' (inside the tx, the 6.4.3 shape).
      await projectAccessService.assertCanEdit(item.projectId, ctx, tx);

      const current = await customFieldValueRepository.findByWorkItemAndField(
        workItemId,
        fieldId,
        tx,
      );

      // Build the full column image + the display-friendly `to` scalar.
      let next: ValueColumns = { ...EMPTY_COLUMNS };
      let toDisplay: DiffScalar = null;
      if (raw !== null) {
        switch (field.fieldType) {
          case 'text': {
            if (typeof raw !== 'string') throw new CustomFieldValueTypeMismatchError('text');
            const text = raw.trim();
            if (text.length > MAX_TEXT_VALUE_LENGTH) {
              throw new CustomFieldTextTooLongError(MAX_TEXT_VALUE_LENGTH);
            }
            next = { ...EMPTY_COLUMNS, valueText: text };
            toDisplay = text;
            break;
          }
          case 'number': {
            if (typeof raw !== 'number' && typeof raw !== 'string') {
              throw new CustomFieldValueTypeMismatchError('number');
            }
            const decimal = parseNumberValue(raw);
            next = { ...EMPTY_COLUMNS, valueNumber: decimal };
            toDisplay = decimal.toString();
            break;
          }
          case 'date': {
            if (typeof raw !== 'string') throw new CustomFieldValueTypeMismatchError('date');
            const date = parseDateValue(raw);
            next = { ...EMPTY_COLUMNS, valueDate: date };
            toDisplay = date.toISOString();
            break;
          }
          case 'select': {
            if (typeof raw !== 'string') throw new CustomFieldValueTypeMismatchError('select');
            // Option must belong to THIS field (cross-field / unknown → 422).
            const option = await customFieldOptionRepository.findById(raw, ctx.workspaceId, tx);
            if (!option || option.fieldId !== field.id) {
              throw new CustomFieldOptionNotInFieldError(raw);
            }
            // Archived options reject NEW writes only: re-setting the SAME
            // archived option the issue already holds changes nothing → the
            // no-op path below; anything else is a new selection.
            if (option.archived && current?.valueOptionId !== option.id) {
              throw new CustomFieldOptionArchivedError(raw);
            }
            next = { ...EMPTY_COLUMNS, valueOptionId: option.id };
            toDisplay = option.label;
            break;
          }
          case 'user': {
            // Type + membership both validated pre-tx (assignableIds is the
            // resolved reference set; raw is a string by the guard above).
            const userId = raw as string;
            if (!assignableIds || !assignableIds.has(userId)) {
              throw new CustomFieldUserNotAssignableError(userId);
            }
            next = { ...EMPTY_COLUMNS, valueUserId: userId };
            toDisplay = userId;
            break;
          }
        }
      }

      // No-op: same value (or clearing an already-empty field) — no write,
      // no revision (the updateWorkItem idempotency rule).
      if (sameColumns(current, next)) {
        return current === null ? null : toCustomFieldValueDto(current);
      }

      const fromDisplay = diffValueOf(current);
      let written: CustomFieldValueWithRefs | null = null;
      if (raw === null) {
        await customFieldValueRepository.deleteByWorkItemAndField(workItemId, fieldId, tx);
      } else {
        await customFieldValueRepository.upsert(
          workItemId,
          fieldId,
          { workspaceId: item.workspaceId, ...next },
          tx,
        );
        // Re-read with display relations resolved — the upsert returns the
        // bare row; the DTO (and the rail) need the option/user resolved.
        written = await customFieldValueRepository.findByWorkItemAndField(workItemId, fieldId, tx);
      }

      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { [`customFields.${field.key}`]: { from: fromDisplay, to: toDisplay } },
        },
        tx,
      );

      return written === null ? null : toCustomFieldValueDto(written);
    });

    return result;
  },
};
