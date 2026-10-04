import type { Prisma } from '@/generated/prisma/client';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';

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
//
// THE PAGE ARM (Story MOTIR-5761 · MOTIR-7435). A human decision card's record is
// its LATEST PUBLISHED PAGE VERSION when it has one (`publish_decision_page`, or
// the confirm port's *Choose page*) — it takes precedence over any markdown
// attachment. Confirm stamps it and FREEZES that version
// (`decisionConfirmationHandler.approve`); Overturn freezes nothing. A new
// publication while the gate is awaiting moves the record shown to the new
// version WITHOUT re-asking: the question is the BODY, never the record.
// Attachment records are not migrated and keep rendering as they did.

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
  | {
      kind: 'page';
      pageId: string;
      /** The exact version Confirm froze — `page_version.id`. */
      versionId: string;
      versionNumber: number;
      /** The page's title when stamped (a later rename does not rewrite it). */
      title: string;
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

/** The card's latest published page version as a record, or null when it has none. */
async function publishedPageRecord(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<Extract<ConfirmedRecord, { kind: 'page' }> | null> {
  const publication = await decisionPagePublicationRepository.latestForWorkItem(workItemId, tx);
  if (!publication) return null;
  const [version, page] = await Promise.all([
    pageVersionRepository.findVersionById(publication.pageVersionId, tx),
    pageRepository.findById(publication.pageId, tx),
  ]);
  // The version cannot go while the publication stands (its FK refuses it), so a
  // miss is a page this reader cannot see — read on as if unpublished.
  if (!version || !page) return null;
  return {
    kind: 'page',
    pageId: page.id,
    versionId: version.id,
    versionNumber: version.number,
    title: page.title,
  };
}

export async function readDecisionRecords(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<DecisionRecordsNow> {
  const [page, files] = await Promise.all([
    publishedPageRecord(workItemId, tx),
    attachmentRepository.findMarkdownByWorkItem(workItemId, tx),
  ]);
  return {
    // A published page wins over every attachment (MOTIR-7435).
    record: page ?? toRecord(files[0] ?? null),
    count: files.length,
    presentIds: files.map((file) => file.id),
  };
}

/** The record a decision work item carries right now — its published page, else the newest counting markdown file, else none. */
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
