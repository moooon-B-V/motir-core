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

/** Every counting record on a decision work item right now, for the port (MOTIR-5960). */
export interface DecisionRecordsNow {
  /** The newest — what Confirm would stamp. */
  record: ConfirmedRecord;
  /** How many counting markdown files there are (the port says which of several it chose). */
  count: number;
  /** Their ids — so a band can tell a STAMPED record that was deleted from one still here. */
  presentIds: string[];
}

export async function readDecisionRecords(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<DecisionRecordsNow> {
  const files = await attachmentRepository.findMarkdownByWorkItem(workItemId, tx);
  return {
    record: toRecord(files[0] ?? null),
    count: files.length,
    presentIds: files.map((file) => file.id),
  };
}

/** The record a decision work item carries right now — the newest counting markdown file, or none. */
export async function resolveDecisionRecord(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<ConfirmedRecord> {
  return (await readDecisionRecords(workItemId, tx)).record;
}

function toRecord(
  attachment: {
    id: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
  } | null,
): ConfirmedRecord {
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
