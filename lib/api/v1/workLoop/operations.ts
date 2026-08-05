import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { dispatchPromptSchema } from '@/lib/api/v1/workLoop/schema';

// The WORK-LOOP operation declarations (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237). Paths, verbs and scopes come from ADR Amendment 6 Q1/Q2; the
// scope of each was read off the SHIPPED `lib/mcp/scopes.ts` entry its MCP
// counterpart carries, never re-derived from the HTTP verb.
//
// ⚠️ **A DECLARATION TRAVELS WITH ITS ROUTE.**
// `tests/api/v1/openapi-operations-coverage.test.ts` asserts both directions —
// every exported verb is documented, AND no operation names a route that does
// not exist. So this module grows one entry per endpoint card (11.7.4–11.7.7)
// rather than being written out in full here: an operation with no route would
// put a path in the published document that answers 404, which is worse for a
// client than a document that is still filling in.
//
// The schemas those cards return into are ALREADY declared, in
// `./schema.ts` — that is what makes them adapters rather than designers, and it
// is the half of "declare ahead" that has no such constraint.

/** The one work-loop endpoint that has shipped so far. */
export const WORK_LOOP_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    operationId: 'getWorkItemDispatchPrompt',
    summary: 'Read the canonical coding-agent prompt for a work item',
    description:
      'Return the server-assembled prompt for one work item — the CONTEXT / WHAT TO DO / ' +
      'ACCEPTANCE CRITERIA / GIT WORKFLOW sections built from the item, its parent, its ' +
      'dependencies and its repo — plus the repo to run it in and which git workflow it ' +
      'carries. A PURE READ: it does not claim the item, move its status, or change its ' +
      'recorded session branch, so fetching a prompt to look at it is always safe. The text ' +
      'is deliberately identical for every agent harness; do not rewrite it. `advisories` is ' +
      'never a gate — it changes what you are told, never what you may do.',
    scope: 'read',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
      {
        name: 'sessionBranch',
        in: 'query',
        required: false,
        description:
          'A session branch to FALL BACK to when this item carries no lineage of its own — ' +
          'the unattended-run seed. It never overrides: an item whose dependencies are ' +
          'already integrated, or that is itself integrated, keeps its own branch, so a ' +
          'caller cannot redirect a live lineage.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchPromptSchema },
      description: 'The assembled prompt and the facts a client routes on.',
    },
    // 404 covers both "no such item" and "outside your workspace" (§4); 422 is a
    // malformed key or an unsafe `sessionBranch`.
    errorStatuses: [404, 422],
  }),
];

/** The named component schemas this resource contributes to the document. */
export const WORK_LOOP_COMPONENTS: Readonly<Record<string, ZodType>> = {
  DispatchPrompt: dispatchPromptSchema,
};
