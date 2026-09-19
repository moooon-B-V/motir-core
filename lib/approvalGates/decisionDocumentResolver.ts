import type {
  DecisionIdentity,
  DecisionUnresolvableReason,
} from '@/lib/approvalGates/decisionSubject';
import type { RepoFileServiceResult } from '@/lib/services/repoFileReadService';

// THE DECISION DOCUMENT RESOLVER — the seam a pages domain later replaces (Story
// MOTIR-4907 · Subtask MOTIR-5676; ADR `docs/decisions/approval-gates.md` §8's
// FIFTH AMENDMENT, clause 8, and §1's MOTIR-4911 amendment: *the subject is a
// document with a resolver*).
//
// ⚠️ MOTIR STORES NO DECISION DOCUMENT, and this interface is why that costs
// nothing later. Today the one implementation reads the file at the pull
// request's head through the core-owned repository read. When decision documents
// move into pages (Epic MOTIR-5746), that is a NEW RESOLVER and a new renderer —
// never a migration on the gate table, which is the one table an audit trusts.
//
// ⚠️ IT IS CALLED OUTSIDE EVERY TRANSACTION, by a surface about to SHOW the
// document. The gate itself never needs content: its version and its refusals
// read the captured identity (`decisionSubject.ts`), so a host that is down makes
// a document unreadable on screen without ever holding a gate's lock.

/** Why a document could not be shown — the capture's reasons plus the read's. */
export type DecisionDocumentReadReason =
  | DecisionUnresolvableReason
  /** The file is not at the captured head any more (a force-push, a deleted ref). */
  | 'gone_at_head'
  /** The file is larger than the read will return. */
  | 'too_large'
  /** The host did not answer, refused the credential, or cannot be used. */
  | 'host_unreachable'
  /** The repository is not connected to this organisation. */
  | 'not_connected';

export type DecisionDocumentContent =
  | { outcome: 'resolved'; repo: string; path: string; blobSha: string; markdown: string }
  | { outcome: 'unresolvable'; reason: DecisionDocumentReadReason };

/** Who is reading — the tenancy the core-owned read enforces. */
export interface DecisionDocumentReadContext {
  userId: string;
  workspaceId: string;
}

/** The seam. One method, and everything it can answer is named. */
export interface DecisionDocumentResolver {
  resolve(
    identity: DecisionIdentity,
    ctx: DecisionDocumentReadContext,
  ): Promise<DecisionDocumentContent>;
}

/** The read the production resolver makes — injected so the mapping is testable
 *  without a host, and so this module stays free of the service layer's imports. */
export type RepoFileRead = (
  ctx: DecisionDocumentReadContext,
  repoRef: string,
  path: string,
  ref: string,
) => Promise<RepoFileServiceResult>;

/**
 * Map the core-owned read's NAMED outcomes onto a document's. TOTAL over
 * `RepoFileServiceResult` — the `never` below fails the build when that union
 * grows a member nobody has mapped.
 */
export function contentFromRead(
  identity: Extract<DecisionIdentity, { resolvable: true }>,
  result: RepoFileServiceResult,
): DecisionDocumentContent {
  switch (result.outcome) {
    case 'found':
      return {
        outcome: 'resolved',
        repo: identity.repo,
        path: identity.path,
        blobSha: identity.blobSha,
        markdown: result.text,
      };
    case 'not_found':
    case 'ref_not_found':
      return { outcome: 'unresolvable', reason: 'gone_at_head' };
    case 'too_large':
      return { outcome: 'unresolvable', reason: 'too_large' };
    case 'unauthorized':
    case 'unreachable':
    case 'provider_unavailable':
      return { outcome: 'unresolvable', reason: 'host_unreachable' };
    case 'repo_not_connected':
      return { outcome: 'unresolvable', reason: 'not_connected' };
    case 'invalid_path':
      return { outcome: 'unresolvable', reason: 'unreadable' };
    default: {
      const unmapped: never = result;
      throw new Error(`unmapped repository read outcome: ${JSON.stringify(unmapped)}`);
    }
  }
}

/**
 * The PRODUCTION resolver — the file at the pull request's captured HEAD.
 *
 * ⚠️ THE HEAD, NOT THE DEFAULT BRANCH. The document is in an unmerged pull request;
 * read at the default branch it would be `not_found` for every decision a person is
 * being asked about. A capture that named no head is `unreadable` rather than a
 * guess.
 */
export function repoFileDecisionResolver(read: RepoFileRead): DecisionDocumentResolver {
  return {
    async resolve(identity, ctx) {
      if (!identity.resolvable) return { outcome: 'unresolvable', reason: identity.reason };
      if (!identity.headSha) return { outcome: 'unresolvable', reason: 'unreadable' };
      return contentFromRead(
        identity,
        await read(ctx, identity.repo, identity.path, identity.headSha),
      );
    },
  };
}
