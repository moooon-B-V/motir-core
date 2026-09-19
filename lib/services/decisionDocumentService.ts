import { loadDecisionIdentity } from '@/lib/approvalGates/decisionApprovalHandler';
import {
  repoFileDecisionResolver,
  type DecisionDocumentContent,
  type DecisionDocumentResolver,
} from '@/lib/approvalGates/decisionDocumentResolver';
import type { DecisionIdentity } from '@/lib/approvalGates/decisionSubject';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import { toDecisionDocumentViewDTO } from '@/lib/mappers/decisionDocumentMappers';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { repoFileReadService } from './repoFileReadService';

// READ A DECISION DOCUMENT — the one door a surface uses to SHOW what a decision gate
// is asking about (Story MOTIR-4907 · Subtask MOTIR-5676; ADR
// `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT, clauses 7 and 8).
//
// TWO READS, and the order is the design: the IDENTITY is read on a transaction from
// the capture on the card's pull requests; the CONTENT is then read through the
// active resolver AFTER that transaction has closed, because the production resolver
// calls a Git host and a transaction may not wait on one.
//
// ⚠️ THE RESOLVER IS SWAPPABLE, AND THAT IS THE WHOLE POINT OF IT. Motir stores no
// decision document; a pages domain that later hosts them registers its own resolver
// here, and the gate, its version and its refusals are untouched — they never read
// content. `setDecisionDocumentResolver` is that swap, and the second-resolver test
// is what proves it is the ONLY thing that changes.
//
// ⚠️ IT AUTHORISES NOTHING. It reads under the caller's workspace context, which is
// the tenancy boundary; whether this person may see this CARD is the calling
// surface's question, asked before it gets here (the approval read, the overlay
// route), exactly as for every other gate subject.

let activeResolver: DecisionDocumentResolver = repoFileDecisionResolver((ctx, repoRef, path, ref) =>
  repoFileReadService.readFile(ctx, repoRef, path, ref),
);

/**
 * Register the resolver every read goes through, returning the one it replaced so a
 * caller can put it back. The production default reads the repository.
 */
export function setDecisionDocumentResolver(
  resolver: DecisionDocumentResolver,
): DecisionDocumentResolver {
  const previous = activeResolver;
  activeResolver = resolver;
  return previous;
}

/** What a surface gets back: which document the card is asked about, and its text. */
export interface DecisionDocumentRead {
  /** Null when no open pull request delivers the card, or none has been captured. */
  identity: DecisionIdentity | null;
  /** Null exactly when `identity` is. */
  content: DecisionDocumentContent | null;
}

export const decisionDocumentService = {
  async readForWorkItem(workItemId: string, ctx: ServiceContext): Promise<DecisionDocumentRead> {
    const identity = await withWorkspaceContext(ctx, (tx) => loadDecisionIdentity(workItemId, tx));
    if (!identity) return { identity: null, content: null };
    return { identity, content: await activeResolver.resolve(identity, ctx) };
  },

  /**
   * The same read, as the decision PORT draws it (MOTIR-5678) — display-ready, with the
   * file's public host link. `null` when there is nothing to ask about yet.
   */
  async readViewForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DecisionDocumentViewDTO | null> {
    return toDecisionDocumentViewDTO(await this.readForWorkItem(workItemId, ctx));
  },
};
