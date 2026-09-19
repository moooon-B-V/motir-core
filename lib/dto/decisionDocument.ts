// THE DECISION PORT'S READ (Story MOTIR-4907 · Subtask MOTIR-5678;
// `design/github/design-notes.md` §27) — what the Development frame draws as a decision
// card's PRIMARY question: the document, or the reason it cannot be shown.
//
// ⚠️ READ ON THE SERVER, HANDED OVER DISPLAY-READY. The content comes through the
// decision document resolver (`decisionDocumentService`), which calls the Git host with
// the organisation's credential; the browser receives the Markdown and a public link to
// the file, never a host API address or a token.

/** Why the port cannot show a document — the capture's reasons and the read's
 *  (`DecisionDocumentReadReason`), restated here so a client component imports no
 *  service module. */
export type DecisionDocumentViewReason =
  | 'none'
  | 'several'
  | 'unreadable'
  | 'gone_at_head'
  | 'too_large'
  | 'host_unreachable'
  | 'not_connected';

export type DecisionDocumentViewDTO =
  | {
      outcome: 'resolved';
      /** `owner/name` of the pull request carrying the document. */
      repo: string;
      number: number;
      path: string;
      /** The document's git blob — what the gate asks about (clause 4). */
      blobSha: string;
      /** The head the capture was read at; null when the host named none. */
      headSha: string | null;
      markdown: string;
      /** The file on the host, at the head it was read at — a page link, not an API. */
      hostUrl: string;
    }
  | {
      outcome: 'unresolvable';
      reason: DecisionDocumentViewReason;
      repo: string;
      number: number;
      headSha: string | null;
      /** The one document's path when the capture found one and only the READ failed
       *  (`gone_at_head`, `too_large`, `host_unreachable`, `not_connected`); else null. */
      path: string | null;
      /** For `several`: every document, so the port can name them. Empty otherwise. */
      paths: string[];
      /** The document's host link when a path is known (a `too_large` read), else null. */
      hostUrl: string | null;
    };
