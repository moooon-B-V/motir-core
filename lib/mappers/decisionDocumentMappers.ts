import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { DecisionDocumentRead } from '@/lib/services/decisionDocumentService';

// The decision port's read → its DTO (Story MOTIR-4907 · Subtask MOTIR-5678). Called by
// `decisionDocumentService.readViewForWorkItem` just before returning.

/** The file on the host at a ref — the same public page `githubMappers` links a pull
 *  request to, never an API address. */
export function decisionDocumentHostUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/blob/${ref}/${path}`;
}

/** `null` exactly when the card has nothing to ask about yet — no captured open pull
 *  request — which the port draws as no decision slot at all. */
export function toDecisionDocumentViewDTO(
  read: DecisionDocumentRead,
): DecisionDocumentViewDTO | null {
  const { identity, content } = read;
  if (!identity || !content) return null;
  if (identity.resolvable && content.outcome === 'resolved') {
    return {
      outcome: 'resolved',
      repo: identity.repo,
      number: identity.number,
      path: identity.path,
      blobSha: identity.blobSha,
      headSha: identity.headSha,
      markdown: content.markdown,
      hostUrl: decisionDocumentHostUrl(
        identity.repo,
        identity.headSha ?? identity.blobSha,
        identity.path,
      ),
    };
  }
  const reason = content.outcome === 'unresolvable' ? content.reason : 'unreadable';
  return {
    outcome: 'unresolvable',
    reason,
    repo: identity.repo,
    number: identity.number,
    headSha: identity.headSha,
    path: identity.resolvable ? identity.path : null,
    paths: identity.resolvable ? [] : identity.paths,
    // A document that EXISTS but cannot be shown here (`too_large`) is still one the
    // reviewer can open on the host — the copy says so.
    hostUrl: identity.resolvable
      ? decisionDocumentHostUrl(identity.repo, identity.headSha ?? identity.blobSha, identity.path)
      : null,
  };
}
