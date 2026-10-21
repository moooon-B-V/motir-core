import { z } from 'zod';

// The `sections` input of the WORK-ITEM write tools (Story MOTIR-9023 ·
// MOTIR-9031): `create_work_item` and `update_work_item`. The plan doors carry the
// same idea under their own wording (`authorPlan.ts`); this one names
// INVALID_SECTIONS, the refusal these two doors raise.
//
// The schema is deliberately LOOSE — an object of named values. The registry
// decides membership, required-ness and each value's shape in the service, so a
// mistake is refused BY SECTION NAME with one code on every door, instead of as a
// generic schema failure that names a path inside a union.

/** What an agent reads on `create_work_item` / `update_work_item` for `sections`. */
export const WORK_ITEM_SECTIONS_INPUT_DESCRIPTION =
  'OPTIONAL. The item’s sections as named values (framing, acceptanceCriteria, ' +
  'scopeBoundary, …), instead of composing headings inside `descriptionMd`: the door ' +
  'checks them against the section set for the item’s kind × type, refuses a missing, ' +
  'unknown or invalid section BY NAME with INVALID_SECTIONS, writes the headings itself and ' +
  'stores ONLY the rendered `descriptionMd` — `sections` is never stored. Never send it ' +
  'together with `descriptionMd` (SECTIONS_AND_DESCRIPTION_CONFLICT). The section sets, their ' +
  'shapes and which are required are served by `get_section_sets`. On an UPDATE it is sparse ' +
  'at the section key: the stored body is read back into its sections first, a section you ' +
  'omit is kept, an explicit `null` clears one, and a list REPLACES the list; it is judged on ' +
  'the item’s type AFTER this write. Omit it to keep sending a plain `descriptionMd` ' +
  'exactly as before.';

export const workItemSectionsInputSchema = z.record(z.string(), z.unknown());
