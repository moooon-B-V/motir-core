import type {
  TitleTranslationResultDTO,
  TitlesTranslateResponseDTO,
} from '@/lib/dto/workItemTranslation';
import { TITLE_TRANSLATION_MAX_ITEMS } from '@/lib/translation/titleBound';

// The ONE browser-side call to `POST /api/projects/[key]/translate-titles`
// (Story MOTIR-7738 · Subtask MOTIR-8833). The only place the path is named.
//
// ⚠️ THE BODY IS `{ workItemIds }` AND NOTHING ELSE. The target language is the
// reader's own interface language, taken by the route from the request; sending
// one here would be ignored at best and a lie about who decides at worst.
//
// A `truncated` answer means more ids were sent than one request answers and
// the FIRST `TITLE_TRANSLATION_MAX_ITEMS` unique ones were: the client asks again
// for the rest, in the order asked, until none remain, and merges the answers.

type Fetch = typeof fetch;

export class TitleTranslationRequestError extends Error {
  constructor(readonly status: number) {
    super(`translate-titles answered ${status}`);
  }
}

async function ask(
  projectKey: string,
  workItemIds: readonly string[],
  fetchImpl: Fetch,
): Promise<TitlesTranslateResponseDTO> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectKey)}/translate-titles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workItemIds }),
  });
  if (!res.ok) throw new TitleTranslationRequestError(res.status);
  return (await res.json()) as TitlesTranslateResponseDTO;
}

export async function requestTitleTranslations(
  projectKey: string,
  workItemIds: readonly string[],
  fetchImpl: Fetch = fetch,
): Promise<TitlesTranslateResponseDTO> {
  let remaining = [...new Set(workItemIds)];
  const titles: TitleTranslationResultDTO[] = [];
  let merged: TitlesTranslateResponseDTO | null = null;
  let canAddCredit = false;
  while (remaining.length > 0) {
    const answer = await ask(projectKey, remaining, fetchImpl);
    merged = merged ?? { ...answer, truncated: false, titles: [] };
    if (!answer.enabled) return { ...merged, enabled: false, truncated: false, titles: [] };
    titles.push(...answer.titles);
    canAddCredit ||= answer.canAddCredit === true;
    // Nothing is left to ask once an answer is not truncated, or when an
    // `no_credit` entry says every further request would be refused alike.
    if (!answer.truncated || answer.titles.some((t) => t.status === 'no_credit')) break;
    remaining = remaining.slice(TITLE_TRANSLATION_MAX_ITEMS);
  }
  return merged
    ? { ...merged, truncated: false, ...(canAddCredit ? { canAddCredit } : {}), titles }
    : { targetLanguage: 'en', enabled: true, truncated: false, titles: [] };
}
