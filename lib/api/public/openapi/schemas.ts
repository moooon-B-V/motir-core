import { z } from 'zod/v4';

// The RESPONSE SCHEMAS of the published public read surface (MOTIR-3946).
//
// ⚠️ THESE DESCRIBE THE WIRE, AND THE TYPES DESCRIBE THE CODE — the two must
// agree, and `tests/api/public/contract-schemas.test.ts` is what makes them.
// Every schema below is validated against the DTO its route actually returns,
// so a field added to `lib/dto/*` without being declared here fails a test
// rather than silently leaving the contract behind its own API.
//
// `.strict()` throughout, deliberately: an undeclared field reaching a consumer
// is exactly the drift this contract exists to prevent, and a permissive schema
// would document a subset while promising the whole.

/** `{ code }` — what every route on this surface returns on a refusal. */
export const publicErrorSchema = z
  .object({ code: z.string().meta({ description: 'A stable, machine-readable error code.' }) })
  .strict()
  .meta({
    id: 'PublicError',
    description: 'A refusal, addressed to a client rather than a reader.',
  });

const publicProjectStats = z
  .object({
    publicRequests: z.number().int(),
    upvotes: z.number().int(),
    planned: z.number().int(),
    shipped: z.number().int(),
    inProgress: z.number().int(),
  })
  .strict()
  .meta({ id: 'PublicProjectStats' });

const publicProjectLinks = z
  .object({
    website: z.string().optional(),
    repo: z.string().optional(),
    docs: z.string().optional(),
    changelog: z.string().optional(),
  })
  .strict()
  .meta({
    id: 'PublicProjectLinks',
    description: 'Author-supplied outbound links; every field optional.',
  });

/** The SUBJECT of `/p/{identifier}` — the endpoint MOTIR-3945 added. */
export const publicProjectOverviewSchema = z
  .object({
    id: z.string().meta({ description: 'The global id the public WRITE endpoints take.' }),
    name: z.string(),
    identifier: z.string().meta({ description: 'The project key — the public URL segment.' }),
    workspaceName: z.string(),
    publicOverviewMd: z.string().nullable().meta({ description: 'The authored README, or null.' }),
    publicTagline: z.string().nullable(),
    publicTags: z.array(z.string()),
    stats: publicProjectStats,
    links: publicProjectLinks,
    viewerCanManage: z.boolean().meta({
      description: 'Always false for an anonymous caller; the session only personalises.',
    }),
  })
  .strict()
  .meta({ id: 'PublicProjectOverview' });

const projectSquareOrg = z
  .object({ name: z.string(), slug: z.string() })
  .strict()
  .meta({ id: 'ProjectSquareOrg' });

const projectSquareStats = z
  .object({ upvotes: z.number().int(), lastActivityAt: z.string().nullable() })
  .strict()
  .meta({ id: 'ProjectSquareStats' });

const projectSquareCard = z
  .object({
    identifier: z.string(),
    name: z.string(),
    org: projectSquareOrg,
    description: z.string().nullable(),
    stats: projectSquareStats,
  })
  .strict()
  .meta({ id: 'ProjectSquareCard' });

/** One page of the directory. Cursor-paged; `nextCursor` null at the end. */
export const projectSquarePageSchema = z
  .object({ items: z.array(projectSquareCard), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'ProjectSquarePage' });

const projectCategory = z
  .object({ slug: z.string(), label: z.string(), projectCount: z.number().int() })
  .strict()
  .meta({ id: 'ProjectCategory' });

/**
 * ⚠️ The categories route answers `{ categories }`, NOT a bare array — read off
 * `app/api/public/categories/route.ts`, which returns
 * `NextResponse.json({ categories })`. Declaring the array would have been the
 * natural guess and would have documented a shape no client receives.
 */
export const projectCategoriesSchema = z
  .object({ categories: z.array(projectCategory) })
  .strict()
  .meta({ id: 'ProjectCategories' });
