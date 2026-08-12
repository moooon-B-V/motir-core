import { createHash } from 'node:crypto';

// WHAT gets embedded, and WHEN it is re-embedded (Story MOTIR-2694 · Subtask
// MOTIR-2696, per `docs/decisions/plan-tree-embeddings.md` §3).
//
// This module is deliberately PURE — no db, no client, no `server-only` — so the
// three consumers that must agree on the answer cannot drift apart: the write
// path that decides an edit is worth an embedding call, the job that composes
// the text it sends to motir-ai, and the backfill that finds the rows still
// missing one. A second, subtly different composition anywhere would produce
// vectors that rank against each other incorrectly, and nothing would fail
// loudly enough to notice.

/**
 * The composed document's character cap (ADR §3).
 *
 * Not a provider limit — `text-embedding-3-small` accepts far more. It bounds
 * cost, and it stops one unusually long card from producing a diffuse vector
 * that ranks near everything. CHARACTERS rather than tokens because motir-core
 * has no tokenizer and should not grow one: a character count is deterministic
 * and testable, and the slack against any real token budget is enormous.
 */
export const EMBEDDING_DOCUMENT_MAX_CHARS = 8_000;

/** The two "what" fields the document is composed from. */
export interface EmbeddingDocumentSource {
  title: string;
  descriptionMd: string | null;
}

/**
 * Compose the embedded document: `title` + "\n\n" + `descriptionMd`, truncated
 * to {@link EMBEDDING_DOCUMENT_MAX_CHARS}.
 *
 * **The description is included, not the title alone**, because this is a
 * CANDIDATE-FINDER and the failure it exists to fix is a false NEGATIVE — a real
 * card the gate could not see, reported as "nothing matches". Recall matters
 * more than precision: a spurious candidate costs one keyed read and is
 * discarded, while a missed one costs a duplicate branch of the plan. A title is
 * a label written for a board column; the description is where a card's meaning
 * lives.
 *
 * **`explanationMd` is excluded.** It is the standing rationale ("why it
 * matters"), and GATE 1 asks "does work like this already exist", which is a
 * question about the description axis. Including it would lengthen the document
 * and blur the centroid with prose answering a different question — and it is
 * null on most cards anyway.
 *
 * The separator is emitted even when there is no description, so the document is
 * a pure function of the pair and the hash below cannot collide between
 * "titled X, no description" and a description that happens to start with the
 * title's tail.
 */
export function composeEmbeddingDocument(source: EmbeddingDocumentSource): string {
  const document = `${source.title}\n\n${source.descriptionMd ?? ''}`;
  return document.slice(0, EMBEDDING_DOCUMENT_MAX_CHARS);
}

/**
 * SHA-256 (hex) of a composed document — THE RE-EMBED TRIGGER (ADR §3).
 *
 * The trigger is the CONTENT, not the row. A status flip, a re-parent, a sprint
 * move, an assignee change, a priority bump, a reorder — the overwhelming
 * majority of work-item writes — leave this unchanged and therefore cost
 * nothing. That is the whole answer to "descriptions go stale on every edit",
 * which is true of the naive row-level trigger and false of this one.
 *
 * It is hashed over the TRUNCATED document on purpose: two cards differing only
 * past the 8 000th character embed identically, so they should also be judged
 * unchanged relative to each other.
 */
export function hashEmbeddingDocument(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

/**
 * Whether an edit changed the embedded document — the predicate the work-item
 * write path applies before it enqueues anything.
 *
 * Compares the composed documents rather than the raw fields so the truncation
 * is inside the comparison: an edit that only rewrites the 9 000th character
 * produces the same document and is correctly judged a no-op.
 */
export function embeddingDocumentChanged(
  before: EmbeddingDocumentSource,
  after: EmbeddingDocumentSource,
): boolean {
  return composeEmbeddingDocument(before) !== composeEmbeddingDocument(after);
}
