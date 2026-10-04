/**
 * The list's URL filter keys. A plain module, not the client `LessonFilters`:
 * the server page reads them too, and a value exported from a `'use client'`
 * file reaches a Server Component only as a client reference, never as the array.
 */
export const FILTER_KEYS = ['q', 'scope', 'type', 'category', 'org', 'state'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
