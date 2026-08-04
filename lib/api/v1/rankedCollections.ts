import type { RankedIssuePageDto } from '@/lib/dto/backlog';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import {
  encodeCollectionCursor,
  type RankedListEnvelope,
  type V1Collection,
} from '@/lib/api/v1/pagination';
import { presentWorkItemRef, type WorkItemRef } from '@/lib/api/v1/workItems/schema';
import { FILTER_PARAM, decodeFilterParam } from '@/lib/filters/ast';
import type { FilterAst } from '@/lib/filters/ast';

// The two RANKED work-item collections (Story 11.3 · Subtask 11.3.8 —
// MOTIR-2065): a project's backlog, and a sprint's members.
//
// They share this module because they are ONE shape: `backlogService.getBacklog`
// and `getSprintIssues` both return `RankedIssuePageDto`, both window in the
// DATABASE, both order by `backlogRank`, both take the same optional FilterAST,
// and both compute the same bounded `totalCount`. Two copies of this translation
// is two places for it to drift.
//
// ── ⚠️ ONE asymmetry, and it is deliberate ──────────────────────────────────
// The BACKLOG excludes done-category issues (`backlogExcludedStatusKeys`) — it
// is the to-be-planned pile, and a finished unsprinted issue does not belong
// there. A SPRINT's members are NOT filtered that way: a done issue stays part
// of its sprint's scope, which is what makes the sprint a historical record
// after it completes.
//
// Same-shaped endpoints, different predicates, both correct. A reader who
// assumes symmetry will "fix" one of them, so it is stated here rather than left
// to be inferred from two service calls.
//
// ── The ENVELOPE is the ranked variant ──────────────────────────────────────
// Both underlying reads already compute `totalCount` as a bounded aggregate they
// have paid for, so both endpoints return `RankedListEnvelope` (ADR Amendment 3,
// Q2). Every other v1 collection returns the plain `ListEnvelope` and omits the
// field entirely — absent, never null — because the ready set and the project
// list have no equivalent cheap count.

/**
 * Translate a `RankedIssuePageDto` into the v1 ranked envelope.
 *
 * The service's own cursor is the last row's id in `backlogRank` order; v1 wraps
 * that in its signed, COLLECTION-SCOPED envelope so a backlog cursor cannot be
 * replayed against a sprint's members — both are bare row ids and would
 * otherwise decode into each other (11.3.2).
 */
export function presentRankedPage(
  page: RankedIssuePageDto,
  collection: V1Collection,
): RankedListEnvelope<WorkItemRef> {
  // ⚠️ The REF shape, not the fatter summary — and that follows from what the
  // read actually returns. Both collections yield `WorkItemSummaryDto`, which
  // carries no `type`, no `reporterId` and no timestamps; 11.2.2 declared TWO
  // work-item shapes for exactly this reason and recorded why ("declaring one
  // fat shape and emitting nulls into it would be a schema that lies"). This is
  // the shape honest about its source.
  //
  // `parentKey` resolves against the ids THIS page already read, so a parent
  // outside the page comes back `null` rather than leaking a cuid (§7) — the
  // documented behaviour of `presentWorkItemRef`'s resolver.
  const keyById = new Map(page.items.map((item) => [item.id, item.identifier]));

  return {
    items: page.items.map((item) => presentWorkItemRef(item, (id) => keyById.get(id))),
    nextCursor:
      page.nextCursor === null ? null : encodeCollectionCursor(collection, page.nextCursor),
    totalCount: page.totalCount,
  };
}

/**
 * Decode `?filter=` into the AST the ranked reads take, or `{}` when absent.
 *
 * The SAME codec `/items` carries and `search_work_items` rides — ONE query
 * grammar, never an ad-hoc `?status=&assignee=` axis. A second grammar is a
 * second thing to keep in sync with the registry, and the first place the API
 * and the product start disagreeing about what a filter MEANS.
 *
 * Identical to the shipped work-item collection route's parser, including its
 * two distinguishable failure codes: a param that is not a filter at all
 * (`INVALID_FILTER`) versus one written against a version this API does not
 * speak (`UNSUPPORTED_FILTER_VERSION` — the signal to upgrade, not to re-encode).
 */
export function parseRankedFilterParam(req: Request): { filterAst?: FilterAst } {
  const raw = new URL(req.url).searchParams.get(FILTER_PARAM);
  if (raw === null || raw === '') return {};

  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) {
    if (decoded.reason === 'unsupported-version') {
      throw new InvalidRequestError(
        'UNSUPPORTED_FILTER_VERSION',
        `The \`filter\` parameter uses an unsupported version: ${decoded.detail}.`,
      );
    }
    if (decoded.reason === 'too-large') {
      throw new InvalidRequestError(
        'FILTER_TOO_LARGE',
        `The \`filter\` parameter is ${decoded.detail}.`,
      );
    }
    throw new InvalidRequestError(
      'INVALID_FILTER',
      'The `filter` parameter is not a valid encoded filter.',
    );
  }
  return { filterAst: decoded.ast };
}
