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

// ── MOTIR-3990: the remaining nine operations ──────────────────────────────
//
// Everything below was read off the DTO the service returns AND the route that
// serialises it, in that order — `lib/dto/publicProjects.ts`, then the handler.
// The DTO alone is not the wire: `/api/public/categories` returns
// `{ categories }` around its array, and only the handler says so.

/** `{ code, error }` — the shape every WRITE refusal carries. */
export const publicErrorWithMessageSchema = z
  .object({
    code: z.string().meta({ description: 'A stable, machine-readable error code.' }),
    error: z.string().meta({ description: 'A human-readable sentence. Never parse it.' }),
  })
  .strict()
  .meta({ id: 'PublicWriteError' });

/**
 * The 403 a signed-in caller gets when their organization or workspace requires
 * a second factor they have not enrolled.
 *
 * Declared because it is REACHABLE on every session-required operation here:
 * `requireCompliantSession` answers 401 for no session and this for a held one.
 * A consumer that treats it as a generic 403 sends a person nowhere; `enrolAt`
 * is the address that resolves it.
 */
export const twoFactorRequiredSchema = z
  .object({
    code: z.literal('TWO_FACTOR_REQUIRED'),
    tier: z.enum(['organization', 'workspace']),
    tierName: z.string(),
    enrolAt: z.string(),
  })
  .strict()
  .meta({ id: 'TwoFactorRequired' });

const workItemKind = z
  .enum(['epic', 'story', 'task', 'bug', 'subtask'])
  .meta({ id: 'PublicWorkItemKind' });
const workItemPriority = z
  .enum(['lowest', 'low', 'medium', 'high', 'highest'])
  .meta({ id: 'PublicWorkItemPriority' });
const statusCategory = z.enum(['todo', 'in_progress', 'done']).meta({ id: 'PublicStatusCategory' });

/**
 * One public-safe work item.
 *
 * ⚠️ WHAT IS ABSENT IS THE POINT. No assignee, no `estimateMinutes`, no
 * `storyPoints`, no internal comments — the public projection does not HAVE
 * those fields, so a mapper that forgets to drop one is a compile error rather
 * than a leak. Declaring them here would document an exposure that does not
 * exist; `.strict()` means a future one fails the drift guard.
 */
const publicWorkItem = z
  .object({
    id: z.string(),
    identifier: z.string().meta({ description: 'The work-item key, e.g. `ACME-42`.' }),
    key: z.number().int().meta({ description: 'The per-project number (ACME-**42**).' }),
    title: z.string(),
    kind: workItemKind,
    status: z.string().meta({ description: 'The workflow status KEY, e.g. `in_progress`.' }),
    statusCategory,
    priority: workItemPriority,
    childrenHidden: z
      .boolean()
      .optional()
      .meta({
        description:
          'Present and true ONLY on a private epic seen by a non-member. Its descendants are ' +
          'excluded server-side, not hidden client-side.',
      }),
  })
  .strict()
  .meta({ id: 'PublicWorkItem' });

const publicTreeRow = publicWorkItem
  .extend({
    parentId: z.string().nullable(),
    hasChildren: z
      .boolean()
      .meta({ description: 'Whether the node has PUBLICLY visible children.' }),
  })
  .strict()
  .meta({ id: 'PublicWorkItemTreeRow' });

/** One lazily-loaded LEVEL of the public tree. Offset-paged, not cursor-paged. */
export const publicTreeLevelSchema = z
  .object({
    rows: z.array(publicTreeRow),
    hasMore: z.boolean(),
    total: z
      .number()
      .int()
      .meta({ description: "The level's full sibling count, independent of paging." }),
  })
  .strict()
  .meta({ id: 'PublicTreeLevel' });

/** A cursor-paginated page of public-safe work items. */
export const publicWorkItemPageSchema = z
  .object({ items: z.array(publicWorkItem), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicWorkItemPage' });

const roadmapBucket = z
  .enum(['submitted', 'planned', 'in_progress', 'done'])
  .meta({ id: 'PublicRoadmapBucket' });

const roadmapCard = z
  .object({
    id: z.string(),
    identifier: z.string(),
    key: z.number().int(),
    title: z.string(),
    kind: workItemKind,
    voteCount: z.number().int(),
    voted: z
      .boolean()
      .meta({ description: 'Whether the CURRENT viewer upvoted it; false anonymously.' }),
  })
  .strict()
  .meta({ id: 'PublicRoadmapCard' });

/** One roadmap column's next page. `bucket` echoes which column it belongs to. */
export const publicRoadmapColumnPageSchema = z
  .object({ bucket: roadmapBucket, cards: z.array(roadmapCard), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicRoadmapColumnPage' });

const changelogEntry = z
  .object({
    identifier: z.string(),
    key: z.number().int(),
    title: z.string(),
    kind: z.string(),
    status: z.string(),
    priority: z.string(),
    shippedAt: z
      .string()
      .meta({ description: 'ISO 8601 — the MOST RECENT transition into a done-category status.' }),
    epic: z
      .object({ identifier: z.string(), title: z.string() })
      .strict()
      .nullable()
      .meta({ id: 'PublicChangelogEpicChip' }),
    descriptionMd: z
      .string()
      .nullable()
      .optional()
      .meta({ description: 'Present on the FEED read only; absent on the page read.' }),
  })
  .strict()
  .meta({ id: 'PublicChangelogEntry' });

/** One page of the changelog. Cursor-paged on `(shippedAt, key)`. */
export const publicChangelogPageSchema = z
  .object({ entries: z.array(changelogEntry), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicChangelogPage' });

/**
 * The follow control's state.
 *
 * ⚠️ `following` reports the ACCOUNT tier ONLY, and the omission is deliberate:
 * saying whether an ADDRESS follows a project would make this an enumeration
 * oracle, which is the same reason `/subscribe` answers 202 to everything.
 */
export const publicFollowStateSchema = z
  .object({
    following: z.boolean(),
    digestOptIn: z.boolean(),
    followerCount: z.number().int().meta({ description: 'Both stored tiers.' }),
    digestAvailable: z
      .boolean()
      .meta({ description: 'False where the deployment has no transactional-email backend.' }),
  })
  .strict()
  .meta({ id: 'PublicFollowState' });

/** The body of `POST …/follow`. Bodiless is the plain "follow" case. */
export const publicFollowBodySchema = z
  .object({ digestOptIn: z.boolean().optional() })
  .strict()
  .meta({ id: 'PublicFollowBody' });

/** The body of `POST …/subscribe`. */
export const publicSubscribeBodySchema = z
  .object({ email: z.string().meta({ description: 'The address to send the digest to.' }) })
  .strict()
  .meta({ id: 'PublicSubscribeBody' });

/** The body of `POST …/requests`. */
export const publicRequestBodySchema = z
  .object({
    kind: z.string().meta({ description: '`bug` or `task`; anything else is refused 422.' }),
    title: z.string(),
    descriptionMd: z.string().nullable().optional(),
  })
  .strict()
  .meta({ id: 'PublicRequestBody' });

/** What a submitted request answers with — the allocated item. */
export const publicRequestResultSchema = z
  .object({
    id: z.string(),
    kind: workItemKind,
    identifier: z.string(),
    title: z.string(),
  })
  .strict()
  .meta({ id: 'PublicRequestResult' });

const requestMatch = z
  .object({
    id: z.string(),
    kind: workItemKind,
    identifier: z.string(),
    title: z.string(),
    status: z.string(),
    voteCount: z.number().int(),
  })
  .strict()
  .meta({ id: 'PublicRequestMatch' });

/** The duplicate pre-check's answer. Empty `candidates` means "submit as new". */
export const publicDuplicateMatchesSchema = z
  .object({ candidates: z.array(requestMatch) })
  .strict()
  .meta({ id: 'PublicDuplicateMatches' });
