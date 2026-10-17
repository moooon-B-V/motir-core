'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import type { HTMLAttributes } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, CircleAlert, Languages } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import { languageDisplayName } from '@/app/(authed)/items/[key]/_components/translation/TranslationProvider';
import {
  failedCount,
  foldAnswer,
  foldFailure,
  hasTranslatedTitle,
  idsToRequest,
  initialSurfaceTitleState,
  markPending,
  setShowOriginal,
  surfacePhase,
  titleView,
  type SurfaceTitleItem,
  type SurfaceTitleState,
  type TitleView,
} from './surfaceTitleState';
import { requestTitleTranslations } from './titleTranslationClient';

// ONE SURFACE'S TITLE TRANSLATION (Story MOTIR-7738 · Subtask MOTIR-8833; design
// MOTIR-8824). A browsing surface — the work items list and tree, the board, the
// backlog and its sprints, Ready, Triage, the roadmap — mounts ONE provider
// around itself. Every title on it renders through `SurfaceTitle`; the surface's
// header carries one `SurfaceShowOriginalSwitch` and one `SurfaceTitlesNotice`.
//
// ⚠️ THE PROVIDER ASKS FOR NOTHING IT WAS NOT HANDED. A surface registers the
// ids (and stored titles) it has in hand, including rows that arrive after mount
// (a Ready cursor page, a drilled roadmap level); the provider sends only the ids
// that have no answer yet — or whose stored title changed since the answer — and
// keeps every answer by work item id. A `null` context (a Visitor) or a switched-off
// project mounts nothing: the children render untouched and no request is made.
//
// Show original is a view flag in this provider's state and nothing else: no
// cookie, no storage, no write, no request in either direction.

interface SurfaceValue {
  projectKey: string;
  state: SurfaceTitleState;
  items: readonly SurfaceTitleItem[];
  canAddCredit: boolean;
  uiLocale: string;
  /** The language the titles are translated INTO — the `lang` of a translated title. */
  targetLanguage: string;
  register: (items: readonly SurfaceTitleItem[]) => void;
  setShowOriginal: (showOriginal: boolean) => void;
}

const SurfaceContext = createContext<SurfaceValue | null>(null);

function useSurface(): SurfaceValue | null {
  return useContext(SurfaceContext);
}

export function SurfaceTitleTranslationProvider({
  projectKey,
  context,
  followView,
  children,
}: {
  projectKey: string;
  /** The reader's resolved context, or `null` (a Visitor). */
  context: AutoTranslateContextDTO | null;
  /**
   * Titles that sit INSIDE an opened work item follow that item's own host (its
   * single Show original) instead of carrying a switch of their own: pass the
   * host's view here and the titles show the original exactly while it does. The
   * host also owns the announcement and the no-credit message, so the live region
   * is not drawn.
   */
  followView?: 'original' | 'translated';
  children: ReactNode;
}) {
  if (!context || !context.autoTranslateWorkContent) return <>{children}</>;
  return (
    <ActiveProvider projectKey={projectKey} context={context} followView={followView}>
      {children}
    </ActiveProvider>
  );
}

function ActiveProvider({
  projectKey,
  context,
  followView,
  children,
}: {
  projectKey: string;
  context: AutoTranslateContextDTO;
  followView?: 'original' | 'translated';
  children: ReactNode;
}) {
  const uiLocale = useLocale();
  const [state, setState] = useState<SurfaceTitleState>(() =>
    initialSurfaceTitleState(true, context.credit === 'no_credit'),
  );
  // The state is mirrored in a ref so a request decided in an effect reads the
  // value the previous decision wrote, not the render before it.
  const stateRef = useRef(state);
  const registry = useRef(new Map<string, string>());
  const [items, setItems] = useState<readonly SurfaceTitleItem[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((fn: (s: SurfaceTitleState) => SurfaceTitleState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    if (mounted.current) setState(next);
  }, []);

  const send = useCallback(
    (all: readonly SurfaceTitleItem[]) => {
      const ids = idsToRequest(stateRef.current, all);
      if (ids.length === 0) return;
      const want = new Set(ids);
      const asked = all.filter((i) => want.has(i.id));
      update((s) => markPending(s, all, ids));
      requestTitleTranslations(projectKey, ids)
        .then((answer) => update((s) => foldAnswer(s, asked, answer)))
        .catch(() => update((s) => foldFailure(s, asked)));
    },
    [projectKey, update],
  );

  // Rows register themselves as they mount (a Ready page, a drilled roadmap level,
  // a board re-read), so the registrations of one commit are collected and sent as
  // ONE batch from a microtask — not one request per row.
  const incomingRef = useRef(new Map<string, string>());
  const scheduled = useRef(false);
  const flush = useCallback(() => {
    scheduled.current = false;
    if (!mounted.current) return;
    let changed = false;
    for (const [id, title] of incomingRef.current) {
      if (registry.current.get(id) !== title) {
        registry.current.set(id, title);
        changed = true;
      }
    }
    incomingRef.current.clear();
    if (!changed) return;
    const all = [...registry.current].map(([id, title]) => ({ id, title }));
    setItems(all);
    send(all);
  }, [send]);
  const register = useCallback(
    (incoming: readonly SurfaceTitleItem[]) => {
      for (const { id, title } of incoming) incomingRef.current.set(id, title);
      if (scheduled.current) return;
      scheduled.current = true;
      queueMicrotask(flush);
    },
    [flush],
  );

  // A title inside an opened item reads the host's view; the surface's own flag
  // is then never the one that counts.
  const effective = useMemo(
    () => (followView === undefined ? state : setShowOriginal(state, followView === 'original')),
    [state, followView],
  );

  const value = useMemo<SurfaceValue>(
    () => ({
      projectKey,
      state: effective,
      items,
      canAddCredit: context.canAddCredit,
      uiLocale,
      targetLanguage: context.targetLanguage,
      register,
      setShowOriginal: (showOriginal) => update((s) => setShowOriginal(s, showOriginal)),
    }),
    [
      projectKey,
      effective,
      items,
      context.canAddCredit,
      context.targetLanguage,
      uiLocale,
      register,
      update,
    ],
  );

  return (
    <SurfaceContext.Provider value={value}>
      {children}
      {followView === undefined ? <SurfaceLiveRegion /> : null}
    </SurfaceContext.Provider>
  );
}

/**
 * A surface registers the titles it has in hand. Safe to call with the same rows
 * on every render (nothing is re-sent for an id that has an answer), and with
 * rows that arrive later. A no-op without a provider.
 */
export function useSurfaceTitles(items: readonly SurfaceTitleItem[]): void {
  const surface = useSurface();
  const register = surface?.register;
  useEffect(() => {
    if (register && items.length > 0) register(items);
  }, [register, items]);
}

/** What one title shows now, plus the accessible name it contributes. */
export interface DisplayedTitle {
  view: TitleView;
  /** The text on screen. */
  text: string;
  /** The text plus the mark's meaning, for a row's accessible name. */
  name: string;
  /** The language to put on the text element, when known. */
  lang: string | undefined;
}

type Translate = ReturnType<typeof useTranslations<'titleTranslation'>>;

function displayedTitle(
  surface: SurfaceValue | null,
  t: Translate,
  id: string,
  stored: string,
): DisplayedTitle {
  if (!surface) {
    return {
      view: { value: 'stored', text: stored, sourceLanguage: null },
      text: stored,
      name: stored,
      lang: undefined,
    };
  }
  const view = titleView(surface.state, id, stored);
  let name = view.text;
  if (view.value === 'pending') name = `${view.text}. ${t('pendingMark')}`;
  if (view.value === 'translated') {
    name = `${view.text}. ${
      view.sourceLanguage
        ? t('markedFrom', { language: languageDisplayName(view.sourceLanguage, surface.uiLocale) })
        : t('marked')
    }`;
  }
  return {
    view,
    text: view.text,
    name,
    lang: view.value === 'translated' ? surface.targetLanguage : undefined,
  };
}

function useDisplayedTitle(id: string, stored: string, register = false): DisplayedTitle {
  const t = useTranslations('titleTranslation');
  const surface = useSurface();
  const registerTitles = surface?.register;
  useEffect(() => {
    if (register && id) registerTitles?.([{ id, title: stored }]);
  }, [register, registerTitles, id, stored]);
  return displayedTitle(surface, t, id, stored);
}

/**
 * The same resolution as a FUNCTION, for the places that build a label for many
 * rows in one render (a list row's link, a tree row's `getRowLabel`) and so cannot
 * call a hook per row. Without a provider it returns the stored text.
 */
export function useSurfaceTitleResolver(): (id: string, stored: string) => DisplayedTitle {
  const surface = useSurface();
  const t = useTranslations('titleTranslation');
  return (id, stored) => displayedTitle(surface, t, id, stored);
}

/** The title as a string — for an `aria-label`, a native `title`, a sentence. It
 *  registers the title with the surface, like {@link SurfaceTitle} does; an empty
 *  `id` registers nothing (a title that may be absent). */
export function useSurfaceTitleText(id: string, stored: string): string {
  return useDisplayedTitle(id, stored, true).text;
}

/** The title with its mark's meaning appended — the row's accessible name part. */
export function useSurfaceTitleName(id: string, stored: string): string {
  return useDisplayedTitle(id, stored, true).name;
}

const MARK = 'inline-flex h-4 w-4 shrink-0 items-center justify-center text-(--el-text-secondary)';

function TitleMark({ value }: { value: 'pending' | 'translated' }) {
  return (
    <span aria-hidden="true" data-title-mark={value} className={MARK}>
      {value === 'pending' ? (
        <Spinner size="sm" aria-hidden className="h-3 w-3 border-[1.5px]" />
      ) : (
        <Languages className="h-3 w-3" aria-hidden />
      )}
    </span>
  );
}

/**
 * A work item's title; it registers itself with the surface's provider, so a row
 * that mounts later is asked for later. Without a provider — or while it has nothing to show but
 * the stored text — it is the shipped `<span className>{title}</span>`. While the
 * title is in flight or translated it adds the mark beside the text and keeps the
 * title on the same box: `layout="truncate"` for a single-line row (the text
 * truncates, the mark stays), `layout="clamp"` for a multi-line clamp (the mark
 * follows the text inline).
 */
export function SurfaceTitle({
  id,
  title,
  className,
  layout = 'truncate',
  reserveTwoLines = false,
  elementProps,
}: {
  id: string;
  title: string;
  className?: string;
  layout?: 'truncate' | 'clamp';
  /** A differing title takes the two-line region from the first frame, so the
   *  answer landing never moves what is below it (the board card's rule). */
  reserveTwoLines?: boolean;
  /** Attributes the host's own span carried (`data-*`, a native `title`): they
   *  ride the outer element in every state, so a host's selectors keep working. */
  elementProps?: HTMLAttributes<HTMLSpanElement> & Record<`data-${string}`, string | boolean>;
}) {
  const shown = useDisplayedTitle(id, title);
  const register = useSurface()?.register;
  useEffect(() => {
    register?.([{ id, title }]);
  }, [register, id, title]);
  const { value } = shown.view;
  if (value === 'pending' || value === 'translated') {
    if (layout === 'clamp') {
      return (
        <span
          {...elementProps}
          className={`${className ?? ''}${reserveTwoLines ? ' min-h-[2lh]' : ''}`}
          lang={shown.lang}
        >
          {shown.text}{' '}
          {/* `-my-1`: the wrapper is a line tall (its own strut) and sits 2px low, so
              the line it ends grew by 2px and the card with it, the moment a mark
              appeared on a two-line English title. The negative margin takes it out
              of the line box; the mark does not move. */}
          <span className="-my-1 inline-block align-[-2px]">
            <TitleMark value={value} />
          </span>
        </span>
      );
    }
    return (
      <span {...elementProps} className={`${className ?? ''} flex min-w-0 items-center gap-1.5`}>
        <span className="min-w-0 truncate" lang={shown.lang}>
          {shown.text}
        </span>
        <TitleMark value={value} />
      </span>
    );
  }
  return (
    <span {...elementProps} className={className}>
      {shown.text}
    </span>
  );
}

/** The Show original / Show translation switch: present once a title came back translated. */
export function SurfaceShowOriginalSwitch() {
  const surface = useSurface();
  const t = useTranslations('titleTranslation');
  if (!surface || !hasTranslatedTitle(surface.state, surface.items)) return null;
  const showing = !surface.state.showOriginal;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      leftIcon={<Languages className="h-3.5 w-3.5" aria-hidden />}
      aria-pressed={showing}
      data-titles-switch
      onClick={() => surface.setShowOriginal(showing)}
    >
      {showing ? t('showOriginal') : t('showTranslation')}
    </Button>
  );
}

/** The ONE no-credit notice of a surface; renders nothing otherwise. */
export function SurfaceTitlesNotice() {
  const surface = useSurface();
  const t = useTranslations('titleTranslation');
  if (!surface?.state.noCredit) return null;
  return (
    <div
      data-titles-notice="no-credit"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] leading-snug text-(--el-text)"
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden />
      <span>
        {t('noCredit')}{' '}
        {surface.canAddCredit ? (
          <Link
            href="/settings/organization/billing"
            className="inline-flex items-center gap-1 font-medium text-(--el-link) underline"
          >
            {t('addCredit')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </span>
    </div>
  );
}

/** The ONE live region: translating, then done, failed or no credit — never per title. */
function SurfaceLiveRegion() {
  const surface = useSurface()!;
  const t = useTranslations('titleTranslation');
  const phase = surfacePhase(surface.state, surface.items);
  const failed = failedCount(surface.state, surface.items);
  // Once something other than "translating" has been announced, a later page of
  // rows going in flight does not announce it again. Both facts are derived while
  // rendering (the state-from-props pattern), not synchronised from an effect.
  const [settled, setSettled] = useState(false);
  const [announced, setAnnounced] = useState('');
  let message = '';
  if (phase === 'no-credit') message = t('liveNoCredit');
  else if (phase === 'pending') message = settled ? '' : t('livePending');
  else if (failed > 0) message = t('liveFailed');
  else if (phase === 'translated' || phase === 'showing-original') message = t('liveDone');
  if (message && message !== announced) setAnnounced(message);
  if (message && phase !== 'pending' && !settled) setSettled(true);
  return (
    <div role="status" aria-live="polite" className="sr-only" data-titles-live>
      {announced}
    </div>
  );
}
