import { z } from 'zod';
import { WorkItemObsolescence } from '@/generated/prisma/client';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';

// The OBSOLESCENCE mark on the MCP work-item doors (Story MOTIR-6574 ·
// MOTIR-6582) — the transport half of the columns MOTIR-6579 added: the two
// write fields `create_work_item` and `update_work_item` share, and the
// text-block lines `get_work_item` and `search_work_items` print on a marked card.
//
// ⚠️ The mark is INFORMATIONAL on every read. No MCP read excludes, dims or
// re-sorts a marked card — the lines below are ADDITIVE, printed on a marked card
// and absent on an unmarked one, so an ordinary card's text reads as it did.

/** The stable code a value outside the enum answers with — the service's own
 *  `InvalidObsolescenceError` code, so the wire refusal and the backstop agree. */
export const INVALID_OBSOLESCENCE_CODE = 'INVALID_OBSOLESCENCE' as const;

/**
 * The `obsolescence` write field. The enum is published in the input schema (so
 * `tools/list` teaches the vocabulary), and its refusal message LEADS with the
 * typed code: the SDK surfaces a failed parse as an `isError` result quoting this
 * message beside the field's path, so a caller sending `"stale"` reads
 * `INVALID_OBSOLESCENCE` and the field it named, never an opaque internal error.
 * A caller that bypasses the schema reaches the service's `InvalidObsolescenceError`,
 * which `toToolError` maps to the same code.
 */
export const obsolescenceWriteField = z
  .nativeEnum(WorkItemObsolescence, {
    errorMap: () => ({
      message: `${INVALID_OBSOLESCENCE_CODE}: obsolescence must be "outdated", "deprecated" or null.`,
    }),
  })
  .nullable()
  .optional()
  .describe(
    'Mark the item as no longer TRUE OF THE CODE: "outdated" (the text no longer describes ' +
      'what shipped; the capability lives on in another shape) or "deprecated" (retired or ' +
      'overturned on purpose — do not build on it). Settable on ANY kind, but ONLY on a ' +
      'FINISHED item — one whose status is in the done category (`done`, `cancelled`, or a ' +
      'custom done-category status); on any other status it is refused ' +
      '(OBSOLESCENCE_REQUIRES_FINISHED) — archive an item nobody will finish instead. A ' +
      'marked item stays finished: moving it out of the done category, or adding a child ' +
      'under it, is refused (MARKED_CARD_CANNOT_REOPEN) until the mark is cleared. null ' +
      'clears it, always. Link the replacing item with link_work_items `supersedes`. A value ' +
      'outside the enum is refused (INVALID_OBSOLESCENCE). Informational: no read hides or ' +
      're-orders a marked item.',
  );

/** The `obsolescenceNoteMd` write field — the Markdown WHY, independent of the mark. */
export const obsolescenceNoteWriteField = z
  .string()
  .nullable()
  .optional()
  .describe(
    'Markdown note saying WHY the item is marked (what changed, what to read instead); ' +
      'null clears it. Independent of `obsolescence`: clearing the mark keeps the note.',
  );

/** The note's first non-blank line, trimmed — what a text block prints. */
function firstLine(noteMd: string | null): string | null {
  if (noteMd === null) return null;
  const line = noteMd
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}

/**
 * The text-block lines for a card's mark: `obsolescence: outdated — superseded by
 * MOTIR-n, MOTIR-m` (the tail only when the replacing items are known and there
 * are any), then `note: <first line>` when a note is set. EMPTY on an unmarked
 * card — a note without a mark prints nothing, because the card is still current.
 */
export function obsolescenceLines(input: {
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd: string | null;
  supersededByKeys?: string[];
  indent?: string;
}): string[] {
  if (input.obsolescence === null) return [];
  const indent = input.indent ?? '';
  const by = input.supersededByKeys ?? [];
  const lines = [
    `${indent}obsolescence: ${input.obsolescence}` +
      (by.length > 0 ? ` — superseded by ${by.join(', ')}` : ''),
  ];
  const note = firstLine(input.obsolescenceNoteMd);
  if (note !== null) lines.push(`${indent}note: ${note}`);
  return lines;
}
