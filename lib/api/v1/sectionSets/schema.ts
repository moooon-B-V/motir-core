import { z } from 'zod/v4';
import type { SectionSetsDescriptor } from '@/lib/workItems/sections/registry';

// The v1 SECTION-SETS resource (Story MOTIR-9023 · MOTIR-9029) — which sections a
// work item of a given kind × type has, which are required and what heading each
// renders under in the free-text `descriptionMd`. The same descriptor the MCP
// `get_section_sets` tool and motir-ai's internal route serve, built by one
// service call, so the three cannot drift. It describes an INTERFACE over the
// body: nothing here is a stored shape.

/** One section's value shape, as plain data (`{ type: 'string' | 'stringList' | … }`). */
const sectionShapeSchema = z.looseObject({ type: z.string() });

export const sectionSetsSchema = z.object({
  /** Changes whenever a section, a shape or a required flag does. */
  version: z.string(),
  /** Every section of the catalogue, in canonical order: its heading and value shape. */
  sections: z.record(
    z.string(),
    z.object({ heading: z.string().nullable(), shape: sectionShapeSchema }),
  ),
  /** One entry per kind × type cell asked for. A story or epic carries `type: null`. */
  sets: z.array(
    z.object({
      kind: z.string(),
      type: z.string().nullable(),
      sections: z.array(z.object({ name: z.string(), required: z.boolean() })),
    }),
  ),
});
export type V1SectionSets = z.infer<typeof sectionSetsSchema>;

/** Map the registry descriptor to the wire resource — field by field. */
export function presentSectionSets(descriptor: SectionSetsDescriptor): V1SectionSets {
  return {
    version: descriptor.version,
    sections: Object.fromEntries(
      Object.entries(descriptor.sections).map(([name, entry]) => [
        name,
        { heading: entry.heading, shape: { ...entry.shape } },
      ]),
    ),
    sets: descriptor.sets.map((set) => ({
      kind: set.kind,
      type: set.type,
      sections: set.sections.map((s) => ({ name: s.name, required: s.required })),
    })),
  };
}
