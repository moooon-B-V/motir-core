import type { FilterAst, FilterCondition } from '@/lib/filters/ast';
import { BUILTIN_FILTER_ID_PREFIX, BUILTIN_RECENT_WINDOW_DAYS } from './constants';

// The built-in default filters (Story 6.2 · Subtask 6.2.1) — the expressible
// subset of Jira's nine system filters, as NON-PERSISTED AST constants (no
// rows, no write paths — "cannot be deleted or edited", the mirror rule).
// They ride the same list/resolve reads as saved rows under `builtin:` ids
// with `builtin: true` in the DTO.
//
// Two inputs parameterize the constants at resolve time:
//   * `userId` — "My open issues" / "Reported by me" pin the CURRENT actor
//     (Jira's currentUser()); a builtin AST is computed per resolve, never
//     stored, so it can never go stale on a user.
//   * `doneStatusKeys` — statuses are project-defined open vocabulary, so
//     "Open"/"Done" compile to the project's done-CATEGORY status keys (the
//     2.2 category roll-up), read fresh per resolve.
// "Viewed recently" is omitted (no view-history substrate — the recorded
// extension slot); "Resolved recently" approximates Jira's resolutiondate
// (a substrate Motir doesn't carry) as done-category + updated-recently —
// the closest expressible shape, noted in the story's recorded deviations.

export interface BuiltinFilterInputs {
  userId: string;
  /** The project's done-category status keys (possibly empty on a degenerate
   * workflow — see {@link doneStatusCondition}). */
  doneStatusKeys: string[];
}

export interface BuiltinFilterDef {
  /** The stable slug after {@link BUILTIN_FILTER_ID_PREFIX}. ALSO the i18n key:
   * the UI threads `t('savedFilters.builtinNames.<slug>')` over it for the
   * localised label (the DTO carries `slug` for exactly this). */
  slug: string;
  /** English fallback name. NOT the user-facing label — every UI consumer
   * localises via the slug; this is only used by callers without a `t` in
   * scope (the `q` search match in savedFiltersService, tools, logs). */
  name: string;
  build: (inputs: BuiltinFilterInputs) => FilterAst;
}

/** `status is_any_of <done keys>` — or, on a workflow with NO done-category
 * status, a never-matching placeholder key: an unknown status key matches
 * nothing by the 6.1.2 stale-referent rule, which is exactly the right
 * degenerate semantics for "Done issues" when nothing can be done. */
function doneStatusCondition(doneStatusKeys: string[]): FilterCondition {
  return {
    field: 'status',
    operator: 'is_any_of',
    value: doneStatusKeys.length > 0 ? doneStatusKeys : ['__no_done_status__'],
  };
}

/** `status is_none_of <done keys>` — on a done-less workflow this is omitted
 * by callers (everything is open when nothing can be done). */
function openStatusConditions(doneStatusKeys: string[]): FilterCondition[] {
  if (doneStatusKeys.length === 0) return [];
  return [{ field: 'status', operator: 'is_none_of', value: doneStatusKeys }];
}

function and(conditions: FilterCondition[]): FilterAst {
  return { combinator: 'and', conditions };
}

/** The registry, in the mirror's menu order. */
export const BUILTIN_FILTERS: ReadonlyArray<BuiltinFilterDef> = [
  {
    slug: 'my-open-issues',
    name: 'My open issues',
    build: ({ userId, doneStatusKeys }) =>
      and([
        { field: 'assignee', operator: 'is_any_of', value: [userId] },
        ...openStatusConditions(doneStatusKeys),
      ]),
  },
  {
    slug: 'reported-by-me',
    name: 'Reported by me',
    build: ({ userId }) => and([{ field: 'reporter', operator: 'is_any_of', value: [userId] }]),
  },
  {
    slug: 'all-issues',
    name: 'All issues',
    build: () => and([]),
  },
  {
    slug: 'open-issues',
    name: 'Open issues',
    build: ({ doneStatusKeys }) => and(openStatusConditions(doneStatusKeys)),
  },
  {
    slug: 'done-issues',
    name: 'Done issues',
    build: ({ doneStatusKeys }) => and([doneStatusCondition(doneStatusKeys)]),
  },
  {
    slug: 'created-recently',
    name: 'Created recently',
    build: () =>
      and([{ field: 'created', operator: 'in_last_days', value: BUILTIN_RECENT_WINDOW_DAYS }]),
  },
  {
    slug: 'updated-recently',
    name: 'Updated recently',
    build: () =>
      and([{ field: 'updated', operator: 'in_last_days', value: BUILTIN_RECENT_WINDOW_DAYS }]),
  },
  {
    slug: 'resolved-recently',
    name: 'Resolved recently',
    build: ({ doneStatusKeys }) =>
      and([
        doneStatusCondition(doneStatusKeys),
        { field: 'updated', operator: 'in_last_days', value: BUILTIN_RECENT_WINDOW_DAYS },
      ]),
  },
];

const BUILTINS_BY_SLUG: ReadonlyMap<string, BuiltinFilterDef> = new Map(
  BUILTIN_FILTERS.map((b) => [b.slug, b]),
);

/** The full `builtin:<slug>` id a builtin rides the read APIs under. */
export function builtinFilterId(slug: string): string {
  return `${BUILTIN_FILTER_ID_PREFIX}${slug}`;
}

/** True when a filter id addresses a builtin (any `builtin:` prefix — an
 * unknown slug then resolves to not-found, not to a row read). */
export function isBuiltinFilterId(filterId: string): boolean {
  return filterId.startsWith(BUILTIN_FILTER_ID_PREFIX);
}

/** Look up a builtin by its full id; null for unknown slugs. */
export function builtinFilterById(filterId: string): BuiltinFilterDef | null {
  if (!isBuiltinFilterId(filterId)) return null;
  return BUILTINS_BY_SLUG.get(filterId.slice(BUILTIN_FILTER_ID_PREFIX.length)) ?? null;
}
