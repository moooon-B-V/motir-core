import { z } from 'zod';
import type { ParsedBody } from '@/lib/workItems/sections/parse';

// The OPTIONAL parsed sections view of `get_work_item` and `get_plan` (Story
// MOTIR-9023 · MOTIR-9033). `descriptionMd` is the one stored body and always free
// text; with `includeSections: true` the tool parses the body it already read
// against the section registry and answers the result beside it in a NEW
// `parsedSections` key. Computed at read time, never stored, cached or written
// back — an unasked call is byte-identical to one made before this existed.

/** The `includeSections` input both tools share. */
export const includeSectionsField = z
  .boolean()
  .optional()
  .describe(
    'OPTIONAL, default false. When true the tool also parses the free-text body into the ' +
      'registry’s sections for the card’s kind × type and returns the result as ' +
      '`parsedSections` beside the body: `{ sections, found, missing, invalid, signals }` — the ' +
      'sections found, the required ones missing BY NAME, the ones that could not be read into ' +
      'their shape, and the parser’s signals (`no-headings`, `quoted-gutter`, …). The body is ' +
      'returned unchanged and nothing is stored; a body with no headings is answered, never ' +
      'refused.',
  );

/** The sentence both tool descriptions carry. */
export const PARSED_SECTIONS_DESCRIPTION =
  ' Pass `includeSections: true` to also receive `parsedSections` — the body parsed at read time ' +
  'into the registry’s sections for its kind × type (`{ sections, found, missing, invalid, ' +
  'signals }`); `descriptionMd` is always returned unchanged and nothing is stored.';

/** `Sections: found a, b · missing c · no-headings` — the one text line, printed
 *  only when the view was asked for. */
export function sectionsSummary(parsed: ParsedBody): string {
  const found = parsed.found.length > 0 ? parsed.found.join(', ') : 'none';
  const missing = parsed.missing.length > 0 ? parsed.missing.join(', ') : 'none';
  return [`Sections: found ${found}`, `missing ${missing}`, ...parsed.signals].join(' · ');
}
