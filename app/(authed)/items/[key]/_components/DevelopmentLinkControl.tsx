'use client';

import { createContext, useContext, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleAlert, Plus } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { PR_STATE_META } from '@/components/github/DevelopmentSection';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { PullRequestLinkCandidateDto } from '@/lib/dto/github';
import { linkPullRequestAction, listPullRequestCandidatesAction } from '../actions';

// The explicit item→PR link affordance (Story 7.10 · MOTIR-1596, design/github
// Panel 5) — the manual override of the MOTIR-892 auto-resolver, on the
// detail-page Development card. The "+ Link pull request" DOOR sits in the card
// header (headerRight, Panel 5a) and the inline picker FORM expands in the card
// body (Panel 5b) — two separate ContentSectionCard slots that must share ONE
// open/selection/search state. A React context threads that state: the provider
// wraps the (server-rendered) ContentSectionCard, and the door + form are client
// descendants that read it across the server boundary — so the card chrome stays
// the shipped ContentSectionCard, no bespoke rebuild. The picker is the shipped
// AddLinkControl + query-driven Combobox grammar (6.9.2) applied to PRs; the
// peek carries NO door (it stays read-only — Open full page routes here).

interface DevelopmentLinkContextValue {
  open: boolean;
  openForm: () => void;
  cancel: () => void;
  submit: () => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  changeQuery: (query: string) => void;
  search: ReturnType<typeof useLinkCandidateSearch<PullRequestLinkCandidateDto>>;
  error: string | null;
  pending: boolean;
}

const DevelopmentLinkContext = createContext<DevelopmentLinkContextValue | null>(null);

function useDevelopmentLink(): DevelopmentLinkContextValue {
  const ctx = useContext(DevelopmentLinkContext);
  if (!ctx) throw new Error('LinkPullRequestDoor/Form must render inside DevelopmentLinkProvider');
  return ctx;
}

export function DevelopmentLinkProvider({
  currentItemId,
  identifier,
  children,
}: {
  currentItemId: string;
  identifier: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Per-keystroke debounced server search over the workspace's ingested PRs. The
  // action returns a typed error (e.g. the disconnected workspace) as
  // `search.error`, which the form's banner surfaces.
  const search = useLinkCandidateSearch<PullRequestLinkCandidateDto>({
    fetcher: (query) => listPullRequestCandidatesAction(currentItemId, query),
  });

  // Typing invalidates a prior pick.
  function changeQuery(query: string) {
    setSelectedId(null);
    search.setQuery(query);
  }
  function openForm() {
    setOpen(true);
    setError(null);
  }
  function cancel() {
    setOpen(false);
    setError(null);
    setSelectedId(null);
    search.reset();
  }
  function submit() {
    if (!selectedId) return;
    setError(null);
    startTransition(async () => {
      const res = await linkPullRequestAction({
        currentItemId,
        identifier,
        pullRequestId: selectedId,
      });
      if (res.ok) {
        cancel();
        // The Development card is server-rendered — re-run the server read so
        // the new/moved row (and its "linked manually" suffix) appears.
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <DevelopmentLinkContext.Provider
      value={{
        open,
        openForm,
        cancel,
        submit,
        selectedId,
        setSelectedId,
        changeQuery,
        search,
        error,
        pending,
      }}
    >
      {children}
    </DevelopmentLinkContext.Provider>
  );
}

/** The header door — "+ Link pull request" (design Panel 5a). Hidden while the
 *  form is open (the form owns the surface then). Rendered in the card's
 *  `headerRight` slot. */
export function LinkPullRequestDoor() {
  const t = useTranslations('github');
  const { open, openForm } = useDevelopmentLink();
  if (open) return null;
  return (
    <button
      type="button"
      onClick={openForm}
      className="text-(--el-link) inline-flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 font-sans text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <Plus className="h-4 w-4" aria-hidden />
      {t('development.linkPr')}
    </button>
  );
}

/** The inline picker form (design Panel 5b) — query-driven Combobox over the
 *  workspace's ingested PRs, Link + Cancel, the rose typed-error banner.
 *  Rendered at the top of the card body, above the linked-PR rows. */
export function LinkPullRequestForm() {
  const t = useTranslations('github');
  const tc = useTranslations('common');
  const { open, cancel, submit, selectedId, setSelectedId, changeQuery, search, error, pending } =
    useDevelopmentLink();
  if (!open) return null;

  const options: ComboboxOption<string>[] = search.candidates.map((c) => {
    const meta = PR_STATE_META[c.state];
    const Glyph = meta.icon;
    return {
      value: c.id,
      label: c.title,
      // owner/repo · #n — --el-text-identifier (the Combobox's secondary slot),
      // NOT -muted (the AA sidebar-caption lesson at 12px).
      secondary: `${c.repo} · #${c.number}`,
      icon: <Glyph className="h-4 w-4 text-(--el-icon-muted)" />,
      // A PR already linked ELSEWHERE shows the neutral takeover chip in place of
      // its state pill — picking it MOVES the link (design Panel 5b). Otherwise
      // the PR-state pill (the shared tone table — no new token).
      trailing: c.linkedTo ? (
        <Pill tone="neutral">{t('development.linkedTo', { key: c.linkedTo })}</Pill>
      ) : (
        <Pill {...meta.pill}>
          <Glyph className="h-3 w-3" aria-hidden />
          {t(`development.prState.${c.state}`)}
        </Pill>
      ),
    };
  });

  // The candidate-fetch error (typed, e.g. the disconnected workspace) OR a link
  // submit error — either surfaces in the one rose banner (design Panel 5c).
  const shownError = error ?? search.error;

  return (
    <div className="bg-(--el-surface-soft) border-(--el-border) mb-3 flex flex-col gap-2.5 rounded-(--radius-card) border p-3">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-eyebrow) uppercase">
          {t('development.linkPrField')}
        </span>
        <Combobox
          label={t('development.linkPrField')}
          options={options}
          value={selectedId}
          onChange={(v) => setSelectedId(v)}
          searchable
          query={search.query}
          onQueryChange={changeQuery}
          placeholder={t('development.searchPlaceholder')}
          searchPlaceholder={t('development.searchPlaceholder')}
          loading={search.loading}
          emptyText={
            search.tooShort ? (
              t('development.typeToSearch')
            ) : (
              <>
                <span className="block">{t('development.noMatches')}</span>
                <span className="mt-1 block text-(--el-text-identifier)">
                  {t('development.noMatchesHint')}
                </span>
              </>
            )
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={!selectedId || pending} loading={pending}>
          {t('development.linkAction')}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={pending}>
          {tc('cancel')}
        </Button>
      </div>
      {shownError ? (
        <div className="bg-(--el-tint-rose) flex items-start gap-2 rounded-(--radius-control) px-3 py-2">
          <CircleAlert className="text-(--el-danger) mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-(--el-text-strong) font-sans text-[13px]">{shownError}</span>
        </div>
      ) : null}
    </div>
  );
}
