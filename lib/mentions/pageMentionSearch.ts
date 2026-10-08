import type { PageMentionCandidateDto } from '@/lib/dto/pages';

// The client-side fetcher behind the `@` picker's Pages section (Story
// MOTIR-7694 · MOTIR-7697): `GET /api/pages/mention-search`, scoped to the work
// item's project. It REJECTS on a non-OK response — a refused or failed search
// must reach the picker's "Couldn't search pages." state, never read as "no
// pages match".
export async function searchPageMentions(
  projectId: string,
  query: string,
): Promise<PageMentionCandidateDto[]> {
  const res = await fetch(
    `/api/pages/mention-search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Page search failed with HTTP ${res.status}`);
  return (await res.json()) as PageMentionCandidateDto[];
}
