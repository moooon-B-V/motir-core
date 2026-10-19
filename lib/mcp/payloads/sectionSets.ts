import type { z } from 'zod/v4';
import { sectionSetsSchema } from '@/lib/api/v1/sectionSets/schema';
import { definePayload } from './define';

// The `get_section_sets` payload (Story MOTIR-9023 · MOTIR-9029): v1's
// `SectionSets` resource whole, so it PROBES that resource: the drift guard
// compares the MCP payload with the v1 resource directly, and a field added on
// one surface and forgotten on the other fails the build.
export const sectionSetsPayload = definePayload({
  schema: sectionSetsSchema as unknown as z.ZodType<z.infer<typeof sectionSetsSchema>>,
  probes: [{ resource: 'SectionSets', select: (p) => [p] }],
});
