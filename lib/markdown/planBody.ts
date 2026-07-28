// Split a work item's Markdown body into the THREE parts Motir's plan model
// actually stores in it (MOTIR-1802). A planned card's `descriptionMd` is, by
// the plan-seed convention (`scripts/plan-seed/types.ts`), a narrative
// description followed by a `## Acceptance criteria` section and a
// `## Context refs` section — there is no column for either (finding #62).
//
// `extractContextRefs` (lib/markdown/contextRefs.ts, Subtask 7.0.2) already read
// ONE of those sections for the dispatch DTO. The dispatch-PROMPT assembly
// (`lib/dispatch/promptTemplate.ts`) needs all three, and needs them
// PARTITIONED: the prompt renders acceptance criteria under their own
// `ACCEPTANCE CRITERIA` heading and the refs under `CONTEXT`, so leaving them in
// the narrative body too would print each of them twice. One parser produces all
// three parts from a single pass, so the "what counts as the acceptance section"
// rule can never drift between the two readers — `extractContextRefs` now
// delegates here.
//
// PURE + deterministic: a pure function of the string in, which is what makes
// the assembled prompt byte-identical across calls for an unchanged item.

/** A `##`/`###`-level Markdown heading — the only section boundary this
 *  convention recognizes (a `#` title line is body text). */
const HEADING = /^#{2,}\s+(.*)$/;
const ACCEPTANCE_HEADING = /acceptance\s+criteria/i;
const CONTEXT_REFS_HEADING = /context\s+refs?/i;
/** A top-level or nested Markdown bullet. */
const BULLET = /^\s*[-*+]\s+(.*)$/;

/** The three parts of a plan-authored `descriptionMd`. */
export interface PlanBodySections {
  /**
   * The narrative description — everything OUTSIDE the acceptance-criteria and
   * context-refs sections, with those sections' headings removed and the result
   * trimmed. Empty string when the body is empty or is nothing but sections.
   */
  body: string;
  /**
   * The acceptance-criteria section's non-blank lines, VERBATIM (only trailing
   * whitespace trimmed) so bullet markers and nesting survive into the prompt.
   * Empty when the card names no criteria.
   */
  acceptanceCriteria: string[];
  /**
   * File paths the agent should read, one per bullet of the context-refs
   * section: the bullet's first backtick-quoted span when present (the path),
   * else its text up to the first ` — ` / ` – ` / ` - ` separator.
   */
  contextRefs: string[];
}

/** Which section a line currently belongs to. */
type Section = 'body' | 'acceptance' | 'contextRefs';

/** Classify a heading's title into the section it opens. A heading that is
 *  neither known section returns the body to plain narrative. */
function sectionOf(title: string): Section {
  if (ACCEPTANCE_HEADING.test(title)) return 'acceptance';
  if (CONTEXT_REFS_HEADING.test(title)) return 'contextRefs';
  return 'body';
}

/** The ref a context-refs bullet names: its first backtick-quoted span, else the
 *  bullet text up to the first dash/em-dash separator. */
function refOfBullet(bulletText: string): string {
  const item = bulletText.trim();
  const backtick = item.match(/`([^`]+)`/);
  return backtick ? (backtick[1] ?? '').trim() : (item.split(/\s[—–-]\s/)[0] ?? '').trim();
}

/**
 * Partition a plan-authored Markdown body into its narrative, its acceptance
 * criteria, and its context refs. Case-insensitive on the section headings and
 * tolerant of `##`/`###` levels; a body that follows none of the convention
 * comes back whole as {@link PlanBodySections.body} with two empty arrays.
 */
export function splitPlanBody(md: string | null | undefined): PlanBodySections {
  if (!md) return { body: '', acceptanceCriteria: [], contextRefs: [] };

  const bodyLines: string[] = [];
  const acceptanceLines: string[] = [];
  const contextRefs: string[] = [];
  let section: Section = 'body';

  for (const line of md.split('\n')) {
    const heading = line.match(HEADING);
    if (heading) {
      section = sectionOf(heading[1] ?? '');
      // A section heading is CONSUMED (the prompt supplies its own headings);
      // an ordinary heading stays part of the narrative.
      if (section === 'body') bodyLines.push(line);
      continue;
    }
    if (section === 'body') {
      bodyLines.push(line);
      continue;
    }
    if (section === 'acceptance') {
      if (line.trim().length > 0) acceptanceLines.push(line.trimEnd());
      continue;
    }
    const bullet = line.match(BULLET);
    if (!bullet) continue;
    const ref = refOfBullet(bullet[1] ?? '');
    if (ref) contextRefs.push(ref);
  }

  return { body: bodyLines.join('\n').trim(), acceptanceCriteria: acceptanceLines, contextRefs };
}
