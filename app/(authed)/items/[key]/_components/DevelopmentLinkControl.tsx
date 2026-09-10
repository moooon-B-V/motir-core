'use client';

import { createContext, useContext, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleAlert, Plus, X } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { PR_STATE_META } from '@/components/github/DevelopmentSection';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { PullRequestLinkCandidateDto } from '@/lib/dto/github';
import {
  linkPullRequestAction,
  listPullRequestCandidatesAction,
  unlinkPullRequestAction,
} from '../actions';

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
  /** Retract ONE delivery (MOTIR-5005). The PROVIDER owns the write and the
   *  refresh — `RemovePullRequestLinkButton` owns only its popover — so the two
   *  Development writes reconcile the card the same way and cannot drift. */
  unlink: (pullRequestId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
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
        // the newly linked row appears.
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  // ⚠️ NOT optimistic, and that is a DEPARTURE from the design's build-seam
  // note — recorded rather than silently taken. `design/github/` § Panels 5d–5f
  // suggests `RemoveLinkButton`'s optimistic-removal shape, which works there
  // because the relationships panel HOLDS its rows in client state. The
  // Development rows do not: `DevelopmentSectionBody` is a Server Component
  // shared with the read-only peek, so there is no client list to remove from
  // optimistically. Making one would convert a shared server component into a
  // client island — a far larger change than this card — and would leave REMOVE
  // optimistic while LINK, three lines up, still refreshes. So it refreshes,
  // exactly as the link arm does, and the two writes on this surface stay one
  // mechanism.
  async function unlink(pullRequestId: string) {
    const res = await unlinkPullRequestAction({ currentItemId, identifier, pullRequestId });
    if (res.ok) router.refresh();
    return res;
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
        unlink,
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
      // A PR that already DELIVERS other cards shows a neutral chip in place of
      // its state pill (design Panel 5b, amended by MOTIR-3756). Three arms, on
      // the LENGTH of the delivery set: none → the PR-state pill; exactly one →
      // the unchanged "Linked to {key}" copy under its unchanged key; two or more
      // → the COUNT. Not a list — an unbounded string in a fixed-width Combobox
      // row is a layout problem dressed as a copy decision — and not a cap, which
      // is a list with a truncation rule that buys nothing a count does not.
      // Picking it ADDS a delivery row; the chip is information, not a warning.
      trailing:
        c.linkedTo.length === 1 ? (
          <Pill tone="neutral">{t('development.linkedTo', { key: c.linkedTo[0]! })}</Pill>
        ) : c.linkedTo.length > 1 ? (
          <Pill tone="neutral">{t('development.deliversN', { count: c.linkedTo.length })}</Pill>
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

/**
 * The per-row REMOVE control (Story MOTIR-4878 · MOTIR-5005, design
 * `design/github/` Panels 5d–5f) — a quiet `×` after the link-out, LAST in the
 * row, opening a confirm popover.
 *
 * ── It is the SHIPPED gesture, not a new one ──────────────────────────────
 * `RemoveLinkButton` has drawn exactly this on the relationships panel since
 * Subtask 2.4.9, and `PullRequestRow`'s own comment already named it as the
 * convention this surface should use. Same 24×24 box, same 15px `X`, same muted
 * ink with a rose tint and danger ink on hover, same `Popover.Content` at 300px
 * aligned to the trigger's edge, same ghost-Cancel + danger-action row.
 *
 * ── `aria-label`, NEVER an `sr-only` span ─────────────────────────────────
 * The reason is `PullRequestRow`'s, verbatim: an `sr-only` span is
 * `position:absolute`, and with no positioned ancestor it escapes the shell's
 * overflow container and stretches the ROOT scroller — the "empty space past the
 * bottom of the page" bug.
 *
 * ── What the COPY has to say ──────────────────────────────────────────────
 * The reader's fear is not *will this delete a record?* — it is *will this do
 * something to my pull request on GitHub?* So the sentence names the pull
 * request and then says what is NOT happening to it. That promise is only true
 * because `unlinkPullRequest` deletes one delivery row and leaves the mirror
 * untouched; if that ever changes, this copy is what goes stale.
 *
 * The control renders only where the host passes it — the detail page, for an
 * actor holding `work_item:edit`. The read-only peek passes nothing, so the row
 * has no trailing control at all rather than a disabled one (design Q1 / Q4).
 */
export function RemovePullRequestLinkButton({
  pullRequestId,
  target,
}: {
  pullRequestId: string;
  /** `owner/repo · #n` — the row's own identifier, named in the aria-label and
   *  rendered `font-mono` inside the confirm sentence. */
  target: string;
}) {
  const t = useTranslations('github');
  const tc = useTranslations('common');
  const { unlink } = useDevelopmentLink();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    setPending(true);
    void (async () => {
      try {
        const res = await unlink(pullRequestId);
        if (res.ok) setOpen(false);
        else setError(res.error);
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <Popover.Trigger
        className="text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        aria-label={t('development.unlinkAria', { target })}
      >
        <X className="h-[15px] w-[15px]" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={300} align="end">
        <div className="flex flex-col gap-3 p-3.5">
          <p className="text-(--el-text) font-sans text-sm leading-snug">
            {t('development.unlinkConfirmBefore')}{' '}
            <span className="font-mono text-xs whitespace-nowrap">{target}</span>
            {t('development.unlinkConfirmAfter')}
          </p>
          {error ? (
            <p className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-(--radius-control) px-2.5 py-1.5 font-sans text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              {tc('cancel')}
            </Button>
            <Button size="sm" variant="danger" onClick={confirm} loading={pending}>
              {t('development.unlinkAction')}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}
