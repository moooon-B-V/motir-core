// The proposed tree-delta motir-ai returns and motir-core commits (boundary
// contract §3.3). 7.1.6 is deliberately minimal — it commits `create` and
// `update` ops (what the walking skeleton + early generation need); `link` /
// `move` arrive with the generation stories (7.3/7.4) that actually produce
// them. An EMPTY operations list is a valid no-op (what 7.1.7's `noop` sends).

import type { WorkItemKindDto, WorkItemTypeDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// The mutable fields an op may set. A loose-but-typed projection of
// CreateWorkItemInput — the service re-validates each (kind/type/permission), so
// this is a shape gate, not the authority.
export interface PlanDeltaFields {
  title?: string;
  descriptionMd?: string | null;
  type?: WorkItemTypeDto | null;
  estimateMinutes?: number | null;
  priority?: WorkItemPriorityDto;
}

export interface PlanDeltaCreateOp {
  op: 'create';
  /** AI-assigned handle, unique within the delta — later ops reference it. */
  ref?: string;
  /** Parent by an earlier op's `ref`, or by an existing item key — at most one. */
  parentRef?: string;
  parentKey?: string;
  kind: WorkItemKindDto;
  fields: PlanDeltaFields & { title: string };
}

export interface PlanDeltaUpdateOp {
  op: 'update';
  /** An EXISTING work item, by key (e.g. "MOTIR-481"). */
  targetKey: string;
  fields: PlanDeltaFields;
}

export type PlanDeltaOperation = PlanDeltaCreateOp | PlanDeltaUpdateOp;

export interface PlanDelta {
  operations: PlanDeltaOperation[];
}

export class PlanDeltaValidationError extends Error {
  readonly code = 'PLAN_DELTA_INVALID' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'PlanDeltaValidationError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFields(raw: unknown, where: string): PlanDeltaFields {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new PlanDeltaValidationError(`${where}.fields must be an object`);
  // Pass through the known field keys; the service re-validates values/enums.
  const f: PlanDeltaFields = {};
  if (raw['title'] !== undefined) {
    if (typeof raw['title'] !== 'string') {
      throw new PlanDeltaValidationError(`${where}.fields.title must be a string`);
    }
    f.title = raw['title'];
  }
  if (raw['descriptionMd'] !== undefined) f.descriptionMd = raw['descriptionMd'] as string | null;
  if (raw['type'] !== undefined) f.type = raw['type'] as WorkItemTypeDto | null;
  if (raw['estimateMinutes'] !== undefined) {
    f.estimateMinutes = raw['estimateMinutes'] as number | null;
  }
  if (raw['priority'] !== undefined) f.priority = raw['priority'] as WorkItemPriorityDto;
  return f;
}

// Parse + validate a request body into a typed PlanDelta. Throws
// PlanDeltaValidationError (→ 400) on any deviation. Empty operations is valid.
export function parsePlanDelta(body: unknown): PlanDelta {
  if (!isRecord(body)) throw new PlanDeltaValidationError('body must be a JSON object');
  const ops = body['operations'];
  if (!Array.isArray(ops)) throw new PlanDeltaValidationError('operations must be an array');

  const operations: PlanDeltaOperation[] = ops.map((raw, i) => {
    const where = `operations[${i}]`;
    if (!isRecord(raw)) throw new PlanDeltaValidationError(`${where} must be an object`);

    if (raw['op'] === 'create') {
      if (typeof raw['kind'] !== 'string') {
        throw new PlanDeltaValidationError(`${where}.kind is required`);
      }
      if (raw['parentRef'] !== undefined && raw['parentKey'] !== undefined) {
        throw new PlanDeltaValidationError(`${where}: set at most one of parentRef / parentKey`);
      }
      const fields = asFields(raw['fields'], where);
      if (typeof fields.title !== 'string' || fields.title.length === 0) {
        throw new PlanDeltaValidationError(`${where}.fields.title is required for a create`);
      }
      return {
        op: 'create',
        kind: raw['kind'] as WorkItemKindDto,
        fields: fields as PlanDeltaFields & { title: string },
        ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}),
        ...(typeof raw['parentRef'] === 'string' ? { parentRef: raw['parentRef'] } : {}),
        ...(typeof raw['parentKey'] === 'string' ? { parentKey: raw['parentKey'] } : {}),
      };
    }

    if (raw['op'] === 'update') {
      if (typeof raw['targetKey'] !== 'string') {
        throw new PlanDeltaValidationError(`${where}.targetKey is required for an update`);
      }
      return { op: 'update', targetKey: raw['targetKey'], fields: asFields(raw['fields'], where) };
    }

    throw new PlanDeltaValidationError(
      `${where}.op must be "create" or "update" (got ${JSON.stringify(raw['op'])}); ` +
        `link/move arrive with the generation stories`,
    );
  });

  return { operations };
}
