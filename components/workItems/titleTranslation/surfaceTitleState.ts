import type { Locale } from '@/lib/i18n/locales';
import type {
  TitleTranslationResultDTO,
  TitlesTranslateResponseDTO,
} from '@/lib/dto/workItemTranslation';

// The per-surface state of auto-translated TITLES (Story MOTIR-7738 · Subtask
// MOTIR-8833; design MOTIR-8824 § *Surface-level states*, § *Per-title values*).
// Pure: no request, no React, no clock. A surface holds one of these, keyed by
// WORK ITEM ID — never by row position, because Ready recycles rows and the
// board pages its columns.
//
// What the state knows: which ids are in flight, what each answered, and whether
// the surface is showing the originals. What it does NOT know is which titles
// DIFFER from the reader's language — the row DTOs carry no recorded language, so
// the route alone decides, and an id it leaves out is "already in your language".

/** One title the surface has in hand: its id and the stored text on screen. */
export interface SurfaceTitleItem {
  id: string;
  title: string;
}

/** The title as the surface last asked for it, and what came back. */
export type TitleEntry =
  | { kind: 'pending'; forTitle: string }
  | { kind: 'translated'; forTitle: string; text: string; sourceLanguage: Locale | null }
  | { kind: 'failed'; forTitle: string }
  | { kind: 'already'; forTitle: string };

/** The six values a title can show (design § *Per-title values*). */
export type TitleValue = 'stored' | 'pending' | 'translated' | 'original' | 'failed' | 'already';

/** The surface-level phases (design § *Surface-level states*, S1–S8). */
export type SurfacePhase =
  | 'off'
  | 'nothing-differs'
  | 'pending'
  | 'translated'
  | 'showing-original'
  | 'failed'
  | 'no-credit';

export interface SurfaceTitleState {
  /** The project's switch, as the last answer or the context said it. */
  enabled: boolean;
  /** The surface is showing the stored text (the Show original press). */
  showOriginal: boolean;
  /** The context or an answer said the organisation cannot pay. */
  noCredit: boolean;
  /** An answer said the reader may add credit (the context cannot know it up front). */
  canAddCredit: boolean;
  entries: Readonly<Record<string, TitleEntry>>;
}

export function initialSurfaceTitleState(enabled: boolean, noCredit = false): SurfaceTitleState {
  return { enabled, showOriginal: false, noCredit, canAddCredit: false, entries: {} };
}

/**
 * The ids to ask for: the ones with no entry, and the ones whose entry was made
 * for a DIFFERENT stored title (an edit — never served stale, re-asked alone).
 * Order of arrival is kept, repeats collapse. Nothing is asked while the switch
 * is off or the organisation cannot pay.
 */
export function idsToRequest(
  state: SurfaceTitleState,
  items: readonly SurfaceTitleItem[],
): string[] {
  if (!state.enabled || state.noCredit) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { id, title } of items) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = state.entries[id];
    if (!entry || entry.forTitle !== title) ids.push(id);
  }
  return ids;
}

/** Marks the given items in flight. */
export function markPending(
  state: SurfaceTitleState,
  items: readonly SurfaceTitleItem[],
  ids: readonly string[],
): SurfaceTitleState {
  const want = new Set(ids);
  const entries = { ...state.entries };
  for (const { id, title } of items) {
    if (want.has(id)) entries[id] = { kind: 'pending', forTitle: title };
  }
  return { ...state, entries };
}

/**
 * Folds the route's (merged) answer into the state for the items that were asked:
 * `ready` → translated; `failed` / `timeout` → failed (silent, no Retry — the next
 * load retries); `no_credit` → the surface's no-credit phase and the title back to
 * its stored text; an id the answer left out → already in the reader's language.
 * `enabled: false` (the switch was turned off between render and answer) clears
 * every entry and turns the surface off.
 */
export function foldAnswer(
  state: SurfaceTitleState,
  asked: readonly SurfaceTitleItem[],
  answer: Pick<TitlesTranslateResponseDTO, 'enabled' | 'titles' | 'canAddCredit'>,
): SurfaceTitleState {
  if (!answer.enabled) return { ...state, enabled: false, showOriginal: false, entries: {} };
  const byId = new Map<string, TitleTranslationResultDTO>();
  for (const result of answer.titles) byId.set(result.workItemId, result);
  const entries = { ...state.entries };
  let noCredit = state.noCredit;
  for (const { id, title } of asked) {
    // An answer for a title that has been edited since it was asked is dropped:
    // the new stored text is re-requested on its own.
    const current = entries[id];
    if (current && current.forTitle !== title) continue;
    const result = byId.get(id);
    if (!result) {
      entries[id] = { kind: 'already', forTitle: title };
    } else if (result.status === 'ready') {
      entries[id] = {
        kind: 'translated',
        forTitle: title,
        text: result.text,
        sourceLanguage: result.sourceLanguage,
      };
    } else if (result.status === 'no_credit') {
      noCredit = true;
      delete entries[id];
    } else {
      entries[id] = { kind: 'failed', forTitle: title };
    }
  }
  return {
    ...state,
    noCredit,
    canAddCredit: state.canAddCredit || answer.canAddCredit === true,
    entries,
  };
}

/** A request that could not be made at all: the asked titles read as failed. */
export function foldFailure(
  state: SurfaceTitleState,
  asked: readonly SurfaceTitleItem[],
): SurfaceTitleState {
  const entries = { ...state.entries };
  for (const { id, title } of asked) entries[id] = { kind: 'failed', forTitle: title };
  return { ...state, entries };
}

export function setShowOriginal(
  state: SurfaceTitleState,
  showOriginal: boolean,
): SurfaceTitleState {
  return { ...state, showOriginal };
}

/** What one title shows now, given the stored text on screen. */
export interface TitleView {
  value: TitleValue;
  /** The text to draw. */
  text: string;
  sourceLanguage: Locale | null;
}

export function titleView(state: SurfaceTitleState, id: string, stored: string): TitleView {
  const base: TitleView = { value: 'stored', text: stored, sourceLanguage: null };
  if (!state.enabled || state.noCredit) return base;
  const entry = state.entries[id];
  // An entry made for other text is stale: show the new text, marked pending, and
  // let the provider re-ask. Nothing of the old translation is ever drawn.
  if (!entry) return base;
  if (entry.forTitle !== stored) return { ...base, value: 'pending' };
  switch (entry.kind) {
    case 'pending':
      return { ...base, value: 'pending' };
    case 'translated':
      return state.showOriginal
        ? { value: 'original', text: stored, sourceLanguage: entry.sourceLanguage }
        : { value: 'translated', text: entry.text, sourceLanguage: entry.sourceLanguage };
    case 'failed':
      return { ...base, value: 'failed' };
    case 'already':
      return { ...base, value: 'already' };
  }
}

/** The surface-level phase over the titles it has in hand. */
export function surfacePhase(
  state: SurfaceTitleState,
  items: readonly SurfaceTitleItem[],
): SurfacePhase {
  if (!state.enabled) return 'off';
  if (state.noCredit) return 'no-credit';
  let pending = false;
  let translated = false;
  let failed = false;
  for (const { id, title } of items) {
    const entry = state.entries[id];
    if (!entry || entry.forTitle !== title || entry.kind === 'pending') pending = true;
    else if (entry.kind === 'translated') translated = true;
    else if (entry.kind === 'failed') failed = true;
  }
  if (translated) return state.showOriginal ? 'showing-original' : 'translated';
  if (pending) return 'pending';
  if (failed) return 'failed';
  return 'nothing-differs';
}

/** Whether the Show original switch is offered: at least one title came back translated. */
export function hasTranslatedTitle(
  state: SurfaceTitleState,
  items: readonly SurfaceTitleItem[],
): boolean {
  if (!state.enabled || state.noCredit) return false;
  return items.some(({ id, title }) => {
    const entry = state.entries[id];
    return entry?.kind === 'translated' && entry.forTitle === title;
  });
}

/** How many titles on the surface could not be translated (for the live region). */
export function failedCount(state: SurfaceTitleState, items: readonly SurfaceTitleItem[]): number {
  return items.filter(({ id, title }) => {
    const entry = state.entries[id];
    return entry?.kind === 'failed' && entry.forTitle === title;
  }).length;
}
