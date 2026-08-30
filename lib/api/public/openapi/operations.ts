import { z } from 'zod/v4';
import type { PublicOperation } from '@/lib/api/public/openapi/operation';
import {
  projectCategoriesSchema,
  projectSquarePageSchema,
  publicErrorSchema,
  publicProjectOverviewSchema,
} from '@/lib/api/public/openapi/schemas';

// The public read surface's OPERATION REGISTRY (MOTIR-3946).
//
// One assembly point, the shape v1's per-resource `operations.ts` modules use:
// the declarations live beside the thing they describe and exactly one value
// knows the whole set.
//
// ⚠️ THREE OPERATIONS, and that is the SPINE rather than the contract. They were
// chosen to exercise the pipeline over the three parameter shapes the surface
// has — a path parameter, a query collection and a bare list — so that the
// remaining eight (MOTIR-3990) are the same act repeated rather than a new
// problem. `tests/api/public/contract-coverage.test.ts` is MOTIR-3990's, and it
// is what will stop this list falling behind a route added later; until it
// lands, this file is a snapshot and the card says so.

const identifierParam = {
  name: 'identifier',
  in: 'path',
  required: true,
  description: "The project's key — the public URL segment, e.g. `ACME`.",
  schema: z.string(),
} as const;

export const PUBLIC_OPERATIONS: readonly PublicOperation[] = [
  {
    method: 'GET',
    path: '/api/public/p/{identifier}',
    operationId: 'getPublicProject',
    summary: "A public project's own subject",
    description:
      'The project a public page is ABOUT — its name, key, owning workspace, authored hero ' +
      '(tagline, tags, README) and computed stats. Anonymous: a session, when present, only ' +
      'personalises `viewerCanManage` and member visibility; it never authorises. A project that ' +
      'is not public answers 404 with no existence leak, exactly as an unknown key does.',
    parameters: [identifierParam],
    response: publicProjectOverviewSchema,
    errors: [
      {
        status: 404,
        description:
          'No PUBLIC project carries this key. Deliberately indistinguishable from an unknown key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/explore',
    operationId: 'listPublicProjects',
    summary: 'The public project directory, one page at a time',
    description:
      'The directory of projects being built in public, cursor-paged. Every parameter is ' +
      'optional; omitting all of them returns the default ranking. Fully anonymous — this route ' +
      'makes no session call at all.',
    parameters: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `nextCursor` of a previous page.',
        schema: z.string(),
      },
      {
        name: 'rank',
        in: 'query',
        required: false,
        description: 'The ranking to apply.',
        schema: z.string(),
      },
      {
        name: 'window',
        in: 'query',
        required: false,
        description: 'The time window a ranking is computed over.',
        schema: z.string(),
      },
      {
        name: 'q',
        in: 'query',
        required: false,
        description: 'A free-text search over the directory.',
        schema: z.string(),
      },
      {
        name: 'category',
        in: 'query',
        required: false,
        description: 'Restrict to one topic, by slug.',
        schema: z.string(),
      },
    ],
    response: projectSquarePageSchema,
    errors: [
      {
        status: 400,
        description: 'An unparseable cursor or an out-of-range ranking parameter.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/categories',
    operationId: 'listPublicCategories',
    summary: 'The topics the directory can be filtered by',
    description:
      'Every topic with at least one public project, and how many each holds — the facet behind ' +
      "the directory's category filter. Fully anonymous.",
    parameters: [],
    response: projectCategoriesSchema,
    errors: [],
  },
];
