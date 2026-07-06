// The importer IDEMPOTENCY classifier + source-hash (Story 7.16 · MOTIR-1504) —
// pure. Given the resolved payload and the existing `(project, source,
// externalId)` mapping row (ADR §3), decide CREATE / UPDATE / SKIP:
//   - absent      → CREATE (+ record the mapping, in MOTIR-941)
//   - present, hash unchanged → SKIP (no source-side change since last import)
//   - present, hash changed   → UPDATE (re-sync source-owned fields)
// This is the SHARED classifier both the preview and the real run consume, so a
// re-run creates zero duplicates. No DB, no writes.

import { createHash } from 'node:crypto';
import type { ImportedIssue } from '@prisma/client';
import type { ImportPlan, ResolvedWorkItemPayload } from './types';

/**
 * A STABLE hash of the SOURCE-OWNED mapped fields of a resolved payload — the
 * fields a re-run re-syncs (title, description, status, priority, assignee,
 * labels, comments, parent, closed-at). Motir-local-only additions are NOT in
 * the hash, so a local edit never forces a spurious re-sync. Deterministic:
 * object keys are emitted in a fixed order and arrays normalised, so the same
 * source issue always hashes identically across runs.
 */
export function computeSourceHash(payload: ResolvedWorkItemPayload): string {
  const canonical = {
    kind: payload.kind,
    title: payload.title,
    descriptionMd: payload.descriptionMd ?? null,
    statusKey: payload.statusKey,
    priority: payload.priority,
    assigneeId: payload.assigneeId ?? null,
    reporterEmail: payload.reporterEmail ?? null,
    labels: [...payload.labels].sort(),
    comments: payload.comments.map((c) => ({
      authorEmail: c.authorEmail ?? null,
      body: c.body,
      createdAt: c.createdAt ?? null,
    })),
    parentExternalId: payload.parentExternalId ?? null,
    createdAt: payload.createdAt ?? null,
    closedAt: payload.closedAt ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Classify against the idempotency map (ADR §3). `existing` is the mapping row
 * for this `(project, source, externalId)` (null on a first-time import).
 */
export function classifyByHash(
  existing: Pick<ImportedIssue, 'workItemId' | 'sourceHash'> | null,
  newSourceHash: string,
): { plan: ImportPlan; existingWorkItemId: string | null } {
  if (!existing) return { plan: 'create', existingWorkItemId: null };
  if (existing.sourceHash && existing.sourceHash === newSourceHash) {
    return { plan: 'skip', existingWorkItemId: existing.workItemId };
  }
  return { plan: 'update', existingWorkItemId: existing.workItemId };
}
