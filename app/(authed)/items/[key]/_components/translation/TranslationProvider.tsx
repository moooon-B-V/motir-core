'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n/locales';
import type { ReaderTranslationDTO, TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import {
  barPhase,
  initialTranslationState,
  revisionsToSend,
  translationReducer,
  type BarPhase,
  type FieldTranslationState,
  type RawFieldResult,
  type SentRevisions,
  type TranslationState,
  type TranslationView,
} from './translationReducer';

// ONE ITEM VIEW'S TRANSLATION (Story MOTIR-7735 · Subtask MOTIR-8122; design
// MOTIR-8112). Holds the offer, each differing field's state and the view mode,
// and is the only thing that talks to `POST /api/work-items/[id]/translate`.
// Mounted once per host — the item page (`_view.tsx`) and the quick view
// (`IssueQuickViewPanel`) — and only when the host has an offer: the public
// project page has none, so it mounts none, and every consumer below falls back
// to the stored text.
//
// ⚠️ THE REQUEST NAMES ONLY THE ITEM. No body: the target language is the
// session's (the route reads it), and the payer is the item's organisation.
//
// The view mode lives here and nowhere else — no cookie, no database — so a
// reload opens on the original and the Translate control (design D2).
//
// AN EDIT (MOTIR-8123). A new `translation` prop — the server's recomputed
// offer — is folded in with `applyOffer`; a field whose revision changed is
// re-requested ONCE, quietly (the bar stays as it is, design panel 10), and
// announced only when its new translation lands (D5). The item page reaches a
// new offer through `router.refresh()`: on any of the page's own refreshes, and,
// while the translated view is open, when the tab is shown again and once a
// minute (`liveRefresh`). Nothing pushes from the server.

interface TranslationContextValue {
  offer: TranslationOfferDTO;
  canAddCredits: boolean;
  /** The fieldRefs this host draws; the bar and the marks count only these. */
  scope: readonly string[];
  state: TranslationState;
  phase: BarPhase;
  /** The target language's name in the reader's interface language. */
  languageName: string;
  /** A field's source language's name, or `null` when it is unknown. */
  sourceName: (fieldRef: string) => string | null;
  translate: () => void;
  retryField: (fieldRef: string) => void;
  setView: (view: TranslationView) => void;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

/** The language's name in `uiLocale` — the platform's display-name lookup. */
export function languageDisplayName(code: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The host's fields: every differing field, or only those named in `fields`. */
function scopeOf(offer: TranslationOfferDTO, fields?: readonly string[]): string[] {
  const differing = Object.keys(offer.fields).filter((ref) => offer.fields[ref]!.needsTranslation);
  return fields ? differing.filter((ref) => fields.includes(ref)) : differing;
}

/** POST once; resolve to the field results, or `null` when the request failed. */
async function postTranslate(itemId: string): Promise<RawFieldResult[] | null> {
  try {
    const res = await fetch(`/api/work-items/${encodeURIComponent(itemId)}/translate`, {
      method: 'POST',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { fields?: unknown };
    return Array.isArray(body.fields) ? (body.fields as RawFieldResult[]) : null;
  } catch {
    return null;
  }
}

/** What the live region says once a press settles (design § Keyboard and AT). */
function settledLine(
  phase: BarPhase,
  t: ReturnType<typeof useTranslations>,
  language: string,
): string {
  if (phase.kind === 'no_credit') return t('liveNoCredits');
  if (phase.kind === 'failed') return t('failedItem');
  if (phase.kind === 'translated' && phase.failedCount > 0) {
    return t('liveFailedCount', { n: phase.failedCount });
  }
  return phase.kind === 'translated' ? t('liveTranslated', { language }) : '';
}

type Dispatch = (a: Parameters<typeof translationReducer>[1]) => void;

/** The fields a quiet answer translates again: sent, still current, edited, now ready. */
function editedNowReady(
  state: TranslationState,
  sent: SentRevisions,
  results: readonly RawFieldResult[],
): string[] {
  return results
    .filter((r) => typeof r.fieldRef === 'string' && r.status === 'ready')
    .map((r) => r.fieldRef as string)
    .filter((ref) => ref in sent && state.fields[ref]?.revision === sent[ref])
    .filter((ref) => state.fields[ref]!.edited);
}

/**
 * The press / retry / toggle actions, each announcing once in the live region.
 * Every request carries the revisions it was sent for, and its answer is
 * applied only to fields still at them — so overlapping requests need no
 * sequence guard, and an answer for older text is discarded field by field.
 */
function useTranslationActions(
  itemId: string,
  stateRef: { readonly current: TranslationState },
  dispatch: Dispatch,
  announce: (line: string) => void,
  lines: TranslationLines,
) {
  const run = useCallback(
    async (only?: readonly string[], quiet?: boolean) => {
      const sent = revisionsToSend(stateRef.current, only);
      dispatch({ type: 'start', sent, quiet });
      if (!quiet) announce(lines.translating);
      const results = await postTranslate(itemId);
      if (!results) return dispatch({ type: 'requestFailed', sent, quiet });
      const edited = quiet ? editedNowReady(stateRef.current, sent, results) : [];
      dispatch({ type: 'apply', results, sent, quiet });
      if (edited.length > 0) announce(edited.map(lines.edited).join(' '));
    },
    [itemId, stateRef, dispatch, announce, lines],
  );
  const setView = useCallback(
    (view: TranslationView) => {
      dispatch({ type: 'setView', view });
      announce(view === 'original' ? lines.showingOriginal : lines.translated);
    },
    [dispatch, announce, lines.showingOriginal, lines.translated],
  );
  return { run, setView };
}

/** The live region's lines, in the reader's interface language. */
function useLiveLines(t: ReturnType<typeof useTranslations>, languageName: string) {
  return useMemo<TranslationLines>(
    () => ({
      translating: t('liveTranslating', { language: languageName }),
      showingOriginal: t('liveShowingOriginal'),
      translated: t('liveTranslated', { language: languageName }),
      edited: (ref) => t('liveEdited', { field: t(FIELD_NAME_KEY[fieldKindOf(ref)]) }),
    }),
    [t, languageName],
  );
}

interface TranslationLines {
  translating: string;
  showingOriginal: string;
  translated: string;
  edited: (fieldRef: string) => string;
}

/** Which of the five field kinds a fieldRef names — for the edited announcement. */
export function fieldKindOf(
  fieldRef: string,
): 'title' | 'description' | 'explanation' | 'todo' | 'instructions' {
  if (fieldRef.startsWith('todo:')) return fieldRef.endsWith(':notes') ? 'instructions' : 'todo';
  if (fieldRef === 'title' || fieldRef === 'description') return fieldRef;
  return 'explanation';
}

const FIELD_NAME_KEY = {
  title: 'fieldTitle',
  description: 'fieldDescription',
  explanation: 'fieldExplanation',
  todo: 'fieldTodo',
  instructions: 'fieldInstructions',
} as const;

/**
 * Fold each new offer in, and re-request every field an edit queued — ONCE per
 * (field, revision), even when the same offer arrives twice or an effect runs
 * twice.
 */
function useStaleFields(
  offer: TranslationOfferDTO,
  state: TranslationState,
  dispatch: Dispatch,
  run: (only?: readonly string[], quiet?: boolean) => Promise<void>,
) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dispatch({ type: 'offer', offer });
  }, [offer, dispatch]);
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (state.queue.length === 0) return;
    const refs = state.queue.filter((ref) => {
      const key = `${ref}@${state.fields[ref]!.revision}`;
      if (requested.current.has(key)) return false;
      requested.current.add(key);
      return true;
    });
    dispatch({ type: 'dequeue', refs: state.queue });
    if (refs.length > 0) void run(refs, true);
  }, [state.queue, state.fields, dispatch, run]);
}

/** How often the open translated view asks the page for a fresh offer. */
export const TRANSLATION_REFRESH_MS = 60_000;

/**
 * The item page's way to SEE an edit (MOTIR-8123): while the translated view is
 * open, re-read the page when the tab is shown again and once a minute. The page
 * has no live channel, and this adds none — `router.refresh()` re-runs the page
 * read, whose new offer reaches the provider as a prop.
 */
function LiveOfferRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, TRANSLATION_REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(timer);
    };
  }, [router]);
  return null;
}

export function TranslationProvider({
  itemId,
  translation,
  fields,
  liveRefresh = false,
  children,
}: {
  itemId: string;
  translation: ReaderTranslationDTO;
  /** The fields this host draws (the quick view: title and description). Default: all. */
  fields?: readonly string[];
  /** Re-read the page for a fresh offer while the translated view is open (the item page). */
  liveRefresh?: boolean;
  children: ReactNode;
}) {
  const { offer, canAddCredits } = translation;
  const t = useTranslations('itemTranslation');
  const uiLocale = useLocale();
  const [state, dispatch] = useReducer(translationReducer, offer, initialTranslationState);
  const stateRef = useLatest(state);
  const [announcement, setAnnouncement] = useState('');
  const scope = useMemo(() => scopeOf(offer, fields), [offer, fields]);
  const phase = barPhase(state, scope);
  const languageName = languageDisplayName(offer.targetLanguage, uiLocale);
  const lines = useLiveLines(t, languageName);
  const { run, setView } = useTranslationActions(
    itemId,
    stateRef,
    dispatch,
    setAnnouncement,
    lines,
  );
  useStaleFields(offer, state, dispatch, run);
  useSettledAnnouncement(state.busy, phase, setAnnouncement, t, languageName);

  const value = useMemo<TranslationContextValue>(
    () => ({
      offer,
      canAddCredits,
      scope,
      state,
      phase,
      languageName,
      sourceName: (ref) => sourceNameOf(offer, ref, uiLocale),
      translate: () => void run(),
      retryField: (ref) => void run([ref]),
      setView,
    }),
    [offer, canAddCredits, scope, state, phase, languageName, uiLocale, run, setView],
  );
  return (
    <TranslationContext.Provider value={value}>
      {children}
      {liveRefresh && state.pressed && state.view === 'translated' ? <LiveOfferRefresh /> : null}
      <span role="status" aria-live="polite" className="sr-only" data-translation-live>
        {announcement}
      </span>
    </TranslationContext.Provider>
  );
}

/** The latest state for the actions, which read it when they send and answer. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/** A field's source language's name in the UI locale, or `null` when unknown. */
function sourceNameOf(offer: TranslationOfferDTO, ref: string, uiLocale: string): string | null {
  const code = offer.fields[ref]?.sourceLanguage as Locale | null | undefined;
  return code ? languageDisplayName(code, uiLocale) : null;
}

/** Announce the outcome ONCE when a request settles — per press, never per field. */
function useSettledAnnouncement(
  busy: boolean,
  phase: BarPhase,
  announce: (line: string) => void,
  t: ReturnType<typeof useTranslations>,
  language: string,
) {
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) announce(settledLine(phase, t, language));
    wasBusy.current = busy;
  }, [busy, phase, announce, t, language]);
}

/** The view's translation, or `null` where no provider is mounted (the public page). */
export function useTranslationContext(): TranslationContextValue | null {
  return useContext(TranslationContext);
}

export type FieldMarkKind = 'translating' | 'edited' | 'translated' | 'failed' | null;

export interface FieldTranslation {
  /** The text to render instead of the stored one, or `null` for the stored one. */
  text: string | null;
  /** The field's state, or `null` when it takes no part (or there is no provider). */
  state: FieldTranslationState | null;
  translated: boolean;
  mark: FieldMarkKind;
}

const NONE: FieldTranslation = { text: null, state: null, translated: false, mark: null };

/**
 * One field's translation for its renderer. A field outside the host's scope,
 * or one already in the reader's language, answers {@link NONE}: never marked,
 * never swapped. A failed field is marked only beside translated ones (panel 8);
 * when the whole item failed the bar says so and the fields stay unmarked (7).
 */
export function useFieldTranslation(fieldRef: string | null): FieldTranslation {
  const ctx = useTranslationContext();
  if (!ctx || !fieldRef || !ctx.scope.includes(fieldRef)) return NONE;
  const entry = ctx.state.fields[fieldRef];
  if (!entry) return NONE;
  if (entry.state === 'pending') {
    const mark = entry.edited ? 'edited' : 'translating';
    return { text: null, state: 'pending', translated: false, mark };
  }
  const showing = ctx.state.view === 'translated';
  if (entry.state === 'ready' && showing) {
    return { text: entry.text, state: 'ready', translated: true, mark: 'translated' };
  }
  const failed = entry.state === 'failed' || entry.state === 'timeout';
  const mark = failed && showing && ctx.phase.kind === 'translated' ? 'failed' : null;
  return { text: null, state: entry.state, translated: false, mark };
}
