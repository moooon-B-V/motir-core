import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { UnknownSectionCellError } from '@/lib/workItems/sections/errors';
import { describeSectionSets, type SectionSetsDescriptor } from '@/lib/workItems/sections/registry';

// The ONE service every transport of the section registry calls (Story MOTIR-9023
// · MOTIR-9029): the internal AI route motir-ai reads, the MCP `get_section_sets`
// tool and the v1 `GET /api/v1/section-sets`. It builds nothing of its own —
// `describeSectionSets()` is the registry's descriptor — and only narrows it, so
// the three answers cannot drift from each other or from the registry. Pure and
// in-memory: no database, no cache, nothing to invalidate.

export interface DescribeSectionSetsInput {
  kind?: string | null;
  type?: string | null;
}

function legalOrThrow(field: 'kind' | 'type', value: string, legal: readonly string[]): void {
  if (!legal.includes(value)) throw new UnknownSectionCellError(field, value, legal);
}

export const sectionSchemaService = {
  /**
   * The registry's descriptor, optionally narrowed to one kind, one type, or one
   * kind × type cell. A `type` without a `kind` returns that type's cells across
   * every kind. An unknown `kind` or `type` throws `UnknownSectionCellError`.
   */
  describe(input: DescribeSectionSetsInput = {}): SectionSetsDescriptor {
    const kind = input.kind ?? undefined;
    const type = input.type ?? undefined;
    if (kind !== undefined) legalOrThrow('kind', kind, ISSUE_TYPES);
    if (type !== undefined) legalOrThrow('type', type, WORK_ITEM_TYPES);

    const descriptor = describeSectionSets();
    if (kind === undefined && type === undefined) return descriptor;
    return {
      ...descriptor,
      sets: descriptor.sets.filter(
        (set) =>
          (kind === undefined || set.kind === kind) && (type === undefined || set.type === type),
      ),
    };
  },
};
