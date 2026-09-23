// THE BODY-EDIT-ABOVE-FIELD-MOVE CHECK (MOTIR-5399) — the pure half of the one
// SHAPE advisory whose input is a card's REVISION TRAIL rather than its row.
//
// A work item's fields and its two bodies are one artifact, and no other
// advisory compares them: `readiness` is edge-only, the other shape checks read
// the body OR the columns, and the reference family scans for OTHER work items —
// which a self-contradicting card does not name. MOTIR-4513 is the specimen: one
// write at 21:25 moved its `type` `decision → content` together with its title,
// executor, repo pin and estimate, and twenty-eight minutes later a body-only edit
// put the decision framing back. Every channel reported the card healthy, and the
// first party to notice was the run it was dispatched to (planning bug
// MOTIR-4577). Replayed at 21:53 its trail carries this signature; after the
// corrective body pass at 22:27 it does not, which is the profile wanted.
//
// The signature needs no natural-language comparison, because the trail records
// WHICH fields each write moved:
//
//   newest ─┐  [updated] descriptionMd, explanationMd      ← the BODY EDIT
//           │  (rows moving neither a body nor a watched field are skipped)
//           └  [updated] type, title, executor, …           ← the FIELD MOVE
//
// ⚠️ IT CANNOT TELL A CONSISTENT CORRECTION FROM A REVERT, AND SAYS SO. Re-typing
// a card and then rewriting its body to MATCH the new type is the ordinary way a
// card is corrected, and it leaves exactly this trail. Telling the two apart needs
// the prose, which is the comparison this check exists to avoid. So the finding is
// a prompt to RE-READ the body against the fields the move changed — named as a
// fact (`body-edit-above-field-move`), never as a `likely-…` defect claim — and it
// carries no criterion index, which is what makes a dispatched run proceed on it
// rather than stop.
//
// Pure — no Prisma, no IO. The batched read of the trail lives in
// `workItemRevisionRepository.listRecentKeysByWorkItemIds`, and the service half in
// `lib/services/proseGraphAdvisoryService.ts`.

/** The two body columns. A write touching one of these (and no watched field) is a BODY EDIT. */
export const BODY_FIELDS: readonly string[] = ['descriptionMd', 'explanationMd'];

/**
 * The fields a body DESCRIBES — the ones a body written before the move can
 * contradict. The list is MOTIR-5399's acceptance criterion 1, verbatim: what a
 * card is (`kind`, `type`), who acts on it (`executor`), where it ships
 * (`targetRepo` / `targetRepos`), what it is called (`title`), and how big it is
 * (`storyPoints`, `estimateMinutes`).
 *
 * ⚠️ Deliberately NOT here: `status`, `assigneeId`, `sprintId`, `priority`,
 * `parentId`, `folderId`, `links`, labels and the rest. They are bookkeeping a
 * body does not restate, and a keyed claim writes `status` + `assigneeId` in one
 * row — so a check that stopped at such a row would be silenced by the very run
 * that should have been told.
 */
export const WATCHED_FIELDS: readonly string[] = [
  'title',
  'type',
  'executor',
  'targetRepo',
  'targetRepos',
  'kind',
  'storyPoints',
  'estimateMinutes',
];

/**
 * How many of a card's most recent revisions the check reads. The two rows it
 * needs are nearly always the top two non-skipped rows; the bound keeps a card
 * with a long tail of status and link churn from turning one advisory into a
 * load-all. A signature buried deeper than this is not reported — the finding is
 * about the card's LATEST word, and a body edit followed by this many bookkeeping
 * writes has been read by whoever made them.
 */
export const BODY_ABOVE_FIELD_MOVE_SCAN = 20;

/** One revision, reduced to what this check reads — the key SET, never the values. */
export interface RevisionKeys {
  changeKind: string;
  changedAt: Date;
  /** The top-level keys of the row's `diff`. */
  keys: readonly string[];
}

/** One end of the finding: when it was written, and which of the relevant fields it moved. */
export interface RevisionEnd {
  at: Date;
  fields: string[];
}

export interface BodyAboveFieldMove {
  /** The newest relevant write — it moved a body and no watched field. */
  bodyEdit: RevisionEnd;
  /** The relevant write directly beneath it — an `updated` row that moved a watched field. */
  fieldMove: RevisionEnd;
}

const RELEVANT = new Set([...BODY_FIELDS, ...WATCHED_FIELDS]);
const WATCHED = new Set(WATCHED_FIELDS);

/**
 * Whether a pending write with these keys would land a NEW relevant row on top of
 * the trail — a body or a watched field. The projected (`planId`) path asks it of
 * a `modify`'s patch: a plan that rewrites the body or moves a watched field
 * supersedes whatever the stored trail says, so the stored finding is not
 * reported against the card the plan would leave behind.
 */
export function touchesBodyOrWatchedField(keys: Iterable<string>): boolean {
  for (const k of keys) if (RELEVANT.has(k)) return true;
  return false;
}

/**
 * The signature, read off a card's trail NEWEST FIRST.
 *
 * 1. Skip every row that moves neither a body nor a watched field.
 * 2. The first row left must move a body and NO watched field — else the card's
 *    latest word is a field move (or a creation), and there is nothing to report.
 * 3. The next row left must be an `updated` row moving a watched field. A
 *    `created` row does NOT count: `create_work_item` takes no `explanationMd`, so
 *    nearly every planned card carries a body-only write straight after creation,
 *    and that is the card being finished, not contradicted. Another body edit does
 *    not count either — the finding is about the edit sitting DIRECTLY above a move
 *    (MOTIR-5399 criterion 1), which keeps a card written body-first across two
 *    calls out of it.
 *
 * `fields` on each end names only the fields this check reads — the body columns
 * on the edit, the watched fields on the move — so the message a reader acts on is
 * not padded with bookkeeping that happened to share the row.
 */
export function bodyEditAboveFieldMove(
  newestFirst: readonly RevisionKeys[],
): BodyAboveFieldMove | null {
  const relevant = newestFirst.filter((r) => r.keys.some((k) => RELEVANT.has(k)));
  const [upper, lower] = relevant;
  if (!upper || !lower) return null;
  if (upper.keys.some((k) => WATCHED.has(k))) return null;
  if (lower.changeKind !== 'updated') return null;
  // Listed in the canonical order above rather than the row's: `jsonb` stores an
  // object's keys shortest-first, which is an accident of storage, not an order a
  // reader should see move between two cards.
  const moved = WATCHED_FIELDS.filter((f) => lower.keys.includes(f));
  if (moved.length === 0) return null;
  return {
    bodyEdit: { at: upper.changedAt, fields: BODY_FIELDS.filter((f) => upper.keys.includes(f)) },
    fieldMove: { at: lower.changedAt, fields: moved },
  };
}

/**
 * The finding as ONE sentence naming both writes with their instants and fields
 * (MOTIR-5399 criterion 3), so a reader can act without opening the history.
 * Shared by every text renderer — the MCP tools and the dispatch prompt — so the
 * four cannot word the same two writes four ways.
 *
 * Takes the WIRE shape (ISO instants) because that is what every renderer holds.
 */
export function describeBodyAboveFieldMove(a: {
  item: string;
  bodyEdit: { at: string; fields: readonly string[] };
  fieldMove: { at: string; fields: readonly string[] };
}): string {
  return (
    `${a.item}'s ${a.bodyEdit.fields.join(' + ')} was edited at ${a.bodyEdit.at} by a write that ` +
    `moved none of its fields, directly above the write at ${a.fieldMove.at} that moved ` +
    `${a.fieldMove.fields.join(', ')}`
  );
}

/**
 * What the reader does about it — one sentence, shared for the same reason. A
 * prompt to re-read, never an instruction to change anything: the trail cannot
 * tell a revert from a body rewritten to match, and only the prose can.
 */
export const BODY_ABOVE_FIELD_MOVE_REMEDY =
  'Re-read the body against the fields that write moved: a body rewritten to MATCH the move is ' +
  'the ordinary correction and needs nothing, but a body edit that restored the framing the move ' +
  'replaced leaves the card saying one thing in its fields and another in its prose. The history ' +
  'cannot tell the two apart; the text can.';
