import type { PageLinkCandidatesDto } from '@/lib/dto/pages';

// The client-side fetcher behind the work item's Link page picker (Story
// MOTIR-7567 · MOTIR-9204): `GET /api/pages/link-search`, scoped to the work
// item's project, one page at a time. It REJECTS on a non-OK response — a
// refused or failed search must reach the picker's error state, never read as
// "no pages match" (the same contract `lib/mentions/pageMentionSearch.ts`
// records for the `@` popup's fetcher).
export async function searchLinkablePages(
  projectId: string,
  query: string,
  cursor?: string | null,
): Promise<PageLinkCandidatesDto> {
  const params = new URLSearchParams({ projectId, q: query });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/pages/link-search?${params.toString()}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Page link search failed with HTTP ${res.status}`);
  return (await res.json()) as PageLinkCandidatesDto;
}
