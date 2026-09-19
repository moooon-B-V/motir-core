import type { DecisionDocOutcome, WorkItem } from '@/generated/prisma/client';
import type { PullRequestFiles } from '@/lib/github/pullRequestFiles';

// WHICH DECISION DOCUMENT A HEAD CARRIES (Story MOTIR-4907 · Subtask MOTIR-5674;
// ADR `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT, clauses 3, 7, 10).
//
// A `decision` + `coding_agent` card ships its decision as ONE
// `docs/decisions/<slug>.md` file in its pull request, and Motir keeps no copy of
// it. What the gate needs is the file's IDENTITY at the head — its path and git
// blob sha — so this module reads that off the host's file list and says, in one
// of four words, what the head carries.
//
// ⚠️ PURE. The file list is read by the capture service, outside any transaction,
// and handed in; this answers the question and touches nothing, so its tests need
// no fixtures and no host.

/** The ADR convention a decision document follows. */
export const DECISION_DOC_DIRECTORY = 'docs/decisions/';

/**
 * Is this path a decision document — a markdown file DIRECTLY under
 * `docs/decisions/`?
 *
 * ⚠️ DIRECTLY, not anywhere beneath it. The convention is one flat folder of
 * records, and an asset a record happens to keep in a sub-folder (a diagram's
 * source, an appendix) is not a second decision: counting it would turn an
 * ordinary record into `several` and refuse an approval over it.
 */
export function isDecisionDocumentPath(path: string): boolean {
  if (!path.startsWith(DECISION_DOC_DIRECTORY) || !path.endsWith('.md')) return false;
  const name = path.slice(DECISION_DOC_DIRECTORY.length);
  return name.length > '.md'.length && !name.includes('/');
}

/**
 * The host statuses that mean the pull request WRITES the file at its head. A
 * `removed` file is not a decision anybody is being asked to accept, and
 * `unchanged` is not a change at all; everything else leaves bytes at the head.
 */
const WRITES_THE_FILE = new Set(['added', 'modified', 'renamed', 'copied', 'changed']);

/** What a head carries, ready to be written onto the pull-request mirror. */
export interface DecisionDocCapture {
  outcome: DecisionDocOutcome;
  /** The document's path — only for `one`. */
  path: string | null;
  /** The document's git blob sha — only for `one`. */
  blobSha: string | null;
  /** The head the list was read at; null when the host named none. */
  headSha: string | null;
  /** Every decision document the head writes — one for `one`, each of them for
   *  `several`, none otherwise (MOTIR-5678: the port names them). */
  paths: string[];
}

/**
 * Classify a head's file list.
 *
 * `null` is a list that could not be read at all — a failed call, or a provider
 * this build cannot list files on — and is `unreadable`, never `none`: *"we could
 * not look"* must not become *"there is nothing to accept"* (clause 3).
 *
 * Two more ways a list is `unreadable` rather than trusted:
 *
 * - **A TRUNCATED list.** The walk stopped at a cap, so a second document may be
 *   past the end of it. `none` or `one` read off a prefix would be a confident
 *   wrong answer — the failure `listPullRequestFiles`' own truncation flag exists
 *   to prevent.
 * - **Exactly one document with no blob sha.** The gate's version IS the blob
 *   sha (clause 4); a document it cannot version is a document it cannot ask
 *   about.
 */
export function classifyDecisionDocuments(files: PullRequestFiles | null): DecisionDocCapture {
  if (files === null)
    return { outcome: 'unreadable', path: null, blobSha: null, headSha: null, paths: [] };
  const headSha = files.headSha;
  if (files.truncated)
    return { outcome: 'unreadable', path: null, blobSha: null, headSha, paths: [] };

  const documents = files.files.filter(
    (file) => isDecisionDocumentPath(file.path) && WRITES_THE_FILE.has(file.status ?? ''),
  );
  if (documents.length === 0)
    return { outcome: 'none', path: null, blobSha: null, headSha, paths: [] };
  const paths = documents.map((file) => file.path).sort();
  if (documents.length > 1)
    return { outcome: 'several', path: null, blobSha: null, headSha, paths };

  const [document] = documents as [(typeof documents)[number]];
  if (!document.sha)
    return { outcome: 'unreadable', path: null, blobSha: null, headSha, paths: [] };
  return { outcome: 'one', path: document.path, blobSha: document.sha, headSha, paths };
}

/**
 * Does this card ask the DECISION question — `type: decision` decided by an
 * agent (clause 10)?
 *
 * ⚠️ BOTH HALVES. A `human` decision card is a person picking one of N options,
 * which is `decision_choice` (Story MOTIR-4914) and never this gate. And a card
 * whose TYPE is not `decision` never asks it, whatever files its pull request
 * touches: a code card that also edits an ADR is a code card.
 */
export function asksTheDecisionQuestion(item: Pick<WorkItem, 'type' | 'executor'>): boolean {
  return item.type === 'decision' && item.executor === 'coding_agent';
}
