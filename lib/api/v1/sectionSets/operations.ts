import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { sectionSetsSchema } from '@/lib/api/v1/sectionSets/schema';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';

// The SECTION-SETS operation (Story MOTIR-9023 · MOTIR-9029), read off
// `app/api/v1/section-sets/route.ts`. The MCP `get_section_sets` tool describes
// the same read.

export const SECTION_SET_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/section-sets',
    operationId: 'getSectionSets',
    summary: 'Read the section sets by kind and type',
    description:
      'Which sections a work item of a given kind and type has, which are required, and the heading each renders under in the free-text `descriptionMd`. Narrow it with `kind`, `type`, or both; a value that names no kind or type is `UNKNOWN_SECTION_CELL`, never a default set. The sets are a product contract, the same for every tenant, so there is no project in the path. The `version` changes whenever a set does.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'kind',
        in: 'query',
        required: false,
        description: 'Only this kind’s sets: `epic`, `story`, `task`, `subtask` or `bug`.',
        schema: z.string(),
      },
      {
        name: 'type',
        in: 'query',
        required: false,
        description:
          'Only this type’s sets, one cell per kind (a story and an epic have one set whatever the type).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: sectionSetsSchema },
      description: 'The section sets.',
    },
    errorStatuses: [422],
  }),
];

export const SECTION_SET_COMPONENTS: Readonly<Record<string, ZodType>> = {
  SectionSets: sectionSetsSchema,
};
