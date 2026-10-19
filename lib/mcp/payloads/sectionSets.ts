import type { z } from 'zod/v4';
import { sectionSetsSchema } from '@/lib/api/v1/sectionSets/schema';
import { definePayload } from './define';

// The `get_section_sets` payload (Story MOTIR-9023 · MOTIR-9029): v1's
// `SectionSets` resource whole. It carries no shared-resource probe — the
// resource is not embedded anywhere else — and, being v1's schema itself, it
// cannot drift from the REST read.
export const sectionSetsPayload = definePayload({
  schema: sectionSetsSchema as unknown as z.ZodType<z.infer<typeof sectionSetsSchema>>,
  probes: [],
});
