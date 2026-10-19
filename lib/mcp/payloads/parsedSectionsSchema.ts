import { z } from 'zod/v4';

/**
 * The wire shape of a parsed sections view (Story MOTIR-9023 · MOTIR-9033) — a
 * `ParsedBody`, declared so the zod payloads of `get_work_item` and `get_plan`
 * keep it. `sections` is a loose record: the registry owns each section's shape.
 */
export const parsedSectionsSchema = z.object({
  sections: z.record(z.string(), z.unknown()),
  found: z.array(z.string()),
  missing: z.array(z.string()),
  invalid: z.array(z.object({ section: z.string(), message: z.string() })),
  signals: z.array(z.string()),
});
