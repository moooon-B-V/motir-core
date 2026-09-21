import type { Prisma } from '@/generated/prisma/client';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';

// A DECISION'S WRITTEN RECORD — THE RESOLVER SEAM (Story MOTIR-5871 · Subtask
// MOTIR-5954; ADR `docs/decisions/approval-gates.md` §1's MOTIR-5952 amendment,
// point 8).
//
// The record is OPTIONAL and is never the gate's subject — the body is. For now it
// is a markdown ATTACHMENT on the decision work item (a temporary solution by
// requester decision, 2026-09-21); when the pages epic ships, MOTIR-5761 adds a
// `{ kind: 'page' }` arm HERE and a renderer for it. That is why both the answer and
// the stamp are a DISCRIMINATED union: a page stamp is a new arm in a JSON column,
// never a migration on the gate table, and every gate confirmed against an
// attachment keeps reading as one.

/**
 * What Confirm stamps about the record, in the deciding write. The `Attachment`
 * row carries no content hash, so the stamp is its IDENTITY — a later replacement
 * is detectable by id, never by content.
 */
export type ConfirmedRecord =
  | {
      kind: 'attachment';
      attachmentId: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      /** ISO-8601 — when the attachment was uploaded. */
      createdAt: string;
    }
  | { kind: 'none' };

/** The record a decision work item carries right now — the newest counting markdown file, or none. */
export async function resolveDecisionRecord(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<ConfirmedRecord> {
  const attachment = await attachmentRepository.findNewestMarkdownByWorkItem(workItemId, tx);
  if (!attachment) return { kind: 'none' };
  return {
    kind: 'attachment',
    attachmentId: attachment.id,
    originalFilename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt.toISOString(),
  };
}
