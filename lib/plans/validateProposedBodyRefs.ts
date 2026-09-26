// ── A proposal body's INTRA-PLAN item links, at EVERY proposal write door ────
// (bug MOTIR-6494.)
//
// A plan's cards point at one another through item-link tokens, and approve
// turns each `[label](motir-ref:planItem:<id>)` into a real `motir:<workItemId>`
// chip (`rewriteIntraPlanRefs`, MOTIR-1418). That rewrite — and every other
// reader of the token (`parseIntraPlanRefIds`, `proseVsGraph`) — recognises the
// CANONICAL form only, through `INTRA_PLAN_REF_TOKEN_RE`. A near-miss such as
// `[label](motir-ref:<id>)` (no `planItem:` prefix) matched nothing: it was not
// rewritten, not reported unresolved, and not refused, so it shipped as dead
// text on the approved card.
//
// So the append refuses it, the way MOTIR-3539 refuses an unresolvable
// structural ref: every `](motir-ref:` link a body carries must be the canonical
// token. This module is the ONE implementation, called by the append
// (`validateProposal`, both an `add`'s `proposedFields` and a `modify`'s
// `patch`), the deepen (`editAddProposal`) and the correction
// (`correctProposal`), so the doors cannot disagree about what a well-formed
// link is.
//
// A link inside Markdown CODE — a fenced block or an inline span — renders
// literally rather than as a link, so it is not a dead link and is skipped: a
// card that DOCUMENTS the token syntax must stay authorable.
//
// PURE: no DB, no `tx`. Every refusal is an `InvalidProposalError` (a 422 with
// code `INVALID_PROPOSAL` on every door), the family every other
// proposal-content refusal uses.

import { InvalidProposalError } from '@/lib/plans/errors';

/** Any Markdown link whose destination starts `motir-ref:` — canonical or not. */
const ANY_MOTIR_REF_LINK_RE = /\[[^\]\[]*\]\(motir-ref:[^)\n]*\)/g;

/** The canonical token, anchored — `INTRA_PLAN_REF_TOKEN_RE`'s shape. */
const CANONICAL_MOTIR_REF_LINK_RE = /^\[[^\]\[]*\]\(motir-ref:planItem:[A-Za-z0-9_-]+\)$/;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** One line with every inline code span (a backtick run to its equal-length closer) removed. */
function withoutInlineCode(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 1;
    while (line[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let close = line.indexOf(fence, i + run);
    // The closer is a run of EXACTLY `run` backticks, not the start of a longer one.
    while (close !== -1 && (line[close + run] === '`' || line[close - 1] === '`')) {
      close = line.indexOf(fence, close + 1);
    }
    if (close === -1) {
      out += fence; // an unclosed run is literal text
      i += run;
    } else {
      i = close + run;
    }
  }
  return out;
}

/** The body with every fenced block and inline code span removed. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const closer = line.match(FENCE_OPEN_RE);
      if (closer && closer[1]![0] === fence[0] && closer[1]!.length >= fence.length) fence = null;
      continue;
    }
    const opener = line.match(FENCE_OPEN_RE);
    if (opener) {
      fence = opener[1]!;
      continue;
    }
    kept.push(withoutInlineCode(line));
  }
  return kept.join('\n');
}

/**
 * Every `](motir-ref:` link in `text` that is NOT the canonical
 * `[label](motir-ref:planItem:<id>)` token, in first-seen order, deduplicated.
 * Links inside Markdown code are ignored.
 */
export function findMalformedIntraPlanRefs(text: string): string[] {
  const found: string[] = [];
  for (const match of withoutCode(text).matchAll(ANY_MOTIR_REF_LINK_RE)) {
    const token = match[0];
    if (!CANONICAL_MOTIR_REF_LINK_RE.test(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

/** The body fields a proposal can carry, as any door hands them over. */
export interface ProposedBodies {
  descriptionMd?: string | null;
  explanationMd?: string | null;
}

/**
 * Refuse a proposal whose `descriptionMd` or `explanationMd` carries an
 * intra-plan item link approve cannot resolve. `undefined` / `null` bodies pass.
 *
 * @param bodies the proposal's bodies — an `add`'s (merged) `proposedFields`, or
 *               a `modify`'s `patch`
 * @param label  how the proposal is named in a refusal (`proposalLabel(...)`)
 */
export function validateProposedBodyRefs(bodies: ProposedBodies, label: string): void {
  for (const field of ['descriptionMd', 'explanationMd'] as const) {
    const text = bodies[field];
    if (typeof text !== 'string') continue;
    const malformed = findMalformedIntraPlanRefs(text);
    if (malformed.length === 0) continue;
    throw new InvalidProposalError(
      `${label}: \`${field}\` carries ${malformed.map((t) => `\`${t}\``).join(', ')}, ` +
        `which approve cannot turn into an item link — it would ship as dead text. ` +
        `A link to another card in this plan is \`[label](motir-ref:planItem:<planItemId>)\`, ` +
        `with the \`planItem:\` prefix and the id \`add_plan_items\` returned; ` +
        `a link to an existing card is \`[label](motir:<workItemId>)\`.`,
    );
  }
}
