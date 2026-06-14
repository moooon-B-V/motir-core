import { z } from 'zod';
import { WorkItemKind, WorkItemPriority } from '@prisma/client';

// Shared zod fields for the ready-set tools (`list_ready`, `next_ready`) — the
// MCP-side mirror of the `ReadyListFilter` facets the `/api/ready` routes parse
// by hand. Kept in one place so the two tools can't drift on what a `kinds` /
// `priority` / `assigneeId` filter means.

export const projectKeyField = z
  .string()
  .min(1)
  .describe('The project key, e.g. "PROD" (case-insensitive).');

export const kindsField = z
  .array(z.nativeEnum(WorkItemKind))
  .optional()
  .describe('Restrict to these work item kinds; omit for any.');

export const priorityField = z
  .array(z.nativeEnum(WorkItemPriority))
  .optional()
  .describe('Restrict to these priorities; omit for any.');

export const assigneeIdField = z
  .string()
  .nullable()
  .optional()
  .describe(
    'A user id to filter by; null or "unassigned" for the unassigned bucket; omit for any.',
  );

/**
 * Map the tool's `assigneeId` to `ReadyListFilter.assigneeId`'s tri-state:
 * `undefined` → any; `null` or the `"unassigned"` sentinel → the unassigned
 * bucket (`null`); any other string → that user's items. (Parity with the
 * route, which accepts the `"unassigned"` literal too.)
 */
export function normalizeAssigneeId(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'unassigned') return null;
  return raw;
}
