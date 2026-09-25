'use client';

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Crown,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { OrgMemberDTO, OrgMemberPageDTO } from '@/lib/dto/organizations';

// Transfer ownership — the button in the Owner's danger zone and its dialog
// (Story MOTIR-6167 · MOTIR-6313, design MOTIR-6303 panel 4, states 4a–4e).
//
// The picker is the ROSTER's own paged read (`GET /api/organizations/[orgId]/members`,
// `organizationsService.listMembers`) with `excludeOwner=1` and a name/email `q` —
// never a load-all. The submit calls MOTIR-6310's
// `POST /api/organizations/[orgId]/ownership-transfer`, which re-checks the typed
// name, the target and the Owner under a row lock.
//
// ⚠️ PAGE STATE AFTER THE MUTATION (motir-core/CLAUDE.md, case 2): the danger zone
// and the "You're the owner" pill are SERVER-rendered off the viewer's role, so
// success is a `router.refresh()` — the page redraws as the Admin's view (panel
// 3, no danger zone). The deep-link `dialog` param is dropped first so the refresh
// cannot re-open anything.

/** The danger-zone row's id, and the fragment that opens the dialog. */
export const TRANSFER_OWNERSHIP_HASH = '#transfer-ownership';

/** Five rows a page — the design's picker (panel 4). */
export const TRANSFER_PICKER_PAGE_SIZE = 5;
const SEARCH_DEBOUNCE_MS = 250;

type LoadState = 'loading' | 'ready' | 'error';

export function TransferOwnershipControl({
  orgId,
  orgName,
  initialOpen,
}: {
  orgId: string;
  orgName: string;
  initialOpen: boolean;
}) {
  const t = useTranslations('orgAdmin');
  const [explicitOpen, setExplicitOpen] = useState(initialOpen);
  // The roster's Owner-row link lands on `#transfer-ownership` (MOTIR-6311): the
  // hash opens the dialog exactly as the `?dialog=transfer-ownership` param does.
  // The server never sees a fragment, so it is read from the browser — as an
  // external store, which renders '' on the server and during hydration.
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const [hashDismissed, setHashDismissed] = useState(false);
  const open = explicitOpen || (hash === TRANSFER_OWNERSHIP_HASH && !hashDismissed);
  return (
    <>
      <Button
        variant="danger"
        leftIcon={<ArrowRightLeft className="h-4 w-4" aria-hidden />}
        onClick={() => setExplicitOpen(true)}
      >
        {t('settings.transferCta')}
      </Button>
      {open ? (
        <TransferOwnershipDialog
          orgId={orgId}
          orgName={orgName}
          onClose={() => {
            setExplicitOpen(false);
            setHashDismissed(true);
          }}
        />
      ) : null}
    </>
  );
}

function TransferOwnershipDialog({
  orgId,
  orgName,
  onClose,
}: {
  orgId: string;
  orgName: string;
  onClose: () => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [page, setPage] = useState<OrgMemberPageDTO | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [pageIndex, setPageIndex] = useState(0);
  // cursorStack[i] = the cursor that fetched page i (null for the first page).
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<OrgMemberDTO | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Only the latest request may land — a slow page 1 must not overwrite page 2.
  const requestSeq = useRef(0);

  async function fetchPage(q: string, cursor: string | null, index: number): Promise<void> {
    const seq = ++requestSeq.current;
    setLoad('loading');
    try {
      const params = new URLSearchParams({
        limit: String(TRANSFER_PICKER_PAGE_SIZE),
        excludeOwner: '1',
      });
      if (q.trim()) params.set('q', q.trim());
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/organizations/${orgId}/members?${params.toString()}`);
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        setLoad('error');
        return;
      }
      const next = (await res.json()) as OrgMemberPageDTO;
      if (seq !== requestSeq.current) return;
      setPage(next);
      setPageIndex(index);
      setLoad('ready');
    } catch {
      if (seq === requestSeq.current) setLoad('error');
    }
  }

  // First page on open, and a fresh first page (debounced) whenever the search changes.
  useEffect(() => {
    const handle = setTimeout(
      () => {
        setCursorStack([null]);
        void fetchPage(query, null, 0);
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(handle);
    // fetchPage is stable in behaviour for a given orgId; re-running on it would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, orgId]);

  function goNext() {
    if (!page?.nextCursor) return;
    const nextIndex = pageIndex + 1;
    const cursor = page.nextCursor;
    setCursorStack((stack) => {
      const copy = stack.slice(0, nextIndex);
      copy[nextIndex] = cursor;
      return copy;
    });
    void fetchPage(query, cursor, nextIndex);
  }

  function goPrev() {
    if (pageIndex === 0) return;
    const prevIndex = pageIndex - 1;
    void fetchPage(query, cursorStack[prevIndex] ?? null, prevIndex);
  }

  const nameMatches = typed === orgName;
  const canSubmit = selected !== null && nameMatches && !isPending;

  function submit() {
    if (!selected || !nameMatches) return;
    const target = selected;
    setError(null);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/organizations/${orgId}/ownership-transfer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toUserId: target.userId, confirmName: typed }),
        });
      } catch {
        setError(t('transfer.errorGeneric'));
        return;
      }
      if (res.ok) {
        toast({
          variant: 'success',
          title: t('transfer.success', { name: displayName(target), org: orgName }),
        });
        onClose();
        const url = new URL(window.location.href);
        if (url.searchParams.has('dialog')) {
          url.searchParams.delete('dialog');
          router.replace(`${url.pathname}${url.search}`);
        }
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        reason?: string;
      } | null;
      setError(refusalMessage(body, target));
    });
  }

  function refusalMessage(
    body: { code?: string; reason?: string } | null,
    target: OrgMemberDTO,
  ): string {
    switch (body?.code) {
      case 'INVALID_OWNERSHIP_TARGET':
        return body.reason === 'not_member'
          ? t('transfer.errorNotMember', { name: displayName(target), org: orgName })
          : t('transfer.errorGeneric');
      case 'OWNERSHIP_CHANGED':
        return t('transfer.errorChanged', { org: orgName });
      case 'OWNERSHIP_CONFIRMATION_MISMATCH':
        return t('transfer.errorNameMismatch', { org: orgName });
      default:
        return t('transfer.errorGeneric');
    }
  }

  const members = page?.members ?? [];
  const total = page?.total ?? 0;
  const from = members.length === 0 ? 0 : pageIndex * TRANSFER_PICKER_PAGE_SIZE + 1;
  const to = pageIndex * TRANSFER_PICKER_PAGE_SIZE + members.length;

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !isPending) onClose();
      }}
      size="md"
      // The dialog draws its own visible heading below (the icon + title row), so
      // the accessible name comes from `srTitle` — without it Radix names the
      // dialog "Dialog" and a screen reader never hears which org is at stake.
      srTitle={t('transfer.title', { org: orgName })}
    >
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-lavender)' }}
        >
          <ArrowRightLeft className="h-5 w-5 text-(--el-text-strong)" aria-hidden />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('transfer.title', { org: orgName })}
          </h2>
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">
            {t('transfer.description')}
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Modal.Body owns the ring-safe scroll recipe (MOTIR-2491): the member
            list, the consequence line and an inline error can outgrow a short
            viewport, so the fields scroll and the footer below stays pinned. */}
        <Modal.Body className="gap-(--spacing-md)">
          {/* `min-w-0`: a fieldset's intrinsic minimum is its content's min-content
              width, so inside Modal.Body's scroll box it would refuse to shrink and
              push the role pills and the pager past the dialog's edge, where the
              scroll box clips them (seen in the MOTIR-6167 acceptance recording). */}
          <fieldset disabled={isPending} className={isPending ? 'min-w-0 opacity-60' : 'min-w-0'}>
            <legend className="mb-1.5 font-sans text-sm font-medium text-(--el-text)">
              {t('transfer.pickerLabel')}
            </legend>
            <div className="rounded-(--radius-card) border border-(--el-border)">
              <div className="border-b border-(--el-border) p-2">
                <Input
                  aria-label={t('transfer.searchPlaceholder')}
                  placeholder={t('transfer.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  addonStart={<Search className="text-(--el-text-muted) h-4 w-4" aria-hidden />}
                />
              </div>
              <MemberList
                load={load}
                members={members}
                query={query}
                selectedId={selected?.userId ?? null}
                onSelect={(m) => {
                  setSelected(m);
                  setError(null);
                }}
                onRetry={() => void fetchPage(query, cursorStack[pageIndex] ?? null, pageIndex)}
              />
              <div className="flex items-center justify-between gap-3 border-t border-(--el-border) px-3 py-2">
                <span className="text-(--el-text-muted) font-sans text-xs" aria-live="polite">
                  {t('transfer.pickerFoot', { from, to, total })}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('transfer.previous')}
                    onClick={goPrev}
                    disabled={pageIndex === 0 || load === 'loading'}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('transfer.next')}
                    onClick={goNext}
                    disabled={!page?.nextCursor || load === 'loading'}
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          </fieldset>
        </Modal.Body>

        {/* PINNED with the footer, outside the scroll body: on a short viewport the
            body scrolls, and what sat at its foot — the consequence line, then the
            confirmation while it was typed in — was cut off (the MOTIR-6167
            acceptance review). What the person is deciding and acting in stays
            whole; only the member picker scrolls. */}
        <div className="flex shrink-0 flex-col gap-(--spacing-sm) pt-(--spacing-xs)">
          {selected ? (
            <div
              className="flex items-start gap-2 rounded-(--radius-card) p-3"
              style={{ backgroundColor: 'var(--el-tint-lavender)' }}
              data-testid="transfer-consequence"
            >
              <Crown className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-strong)" aria-hidden />
              <div className="font-sans text-sm">
                <p className="font-semibold text-(--el-text-strong)">
                  {t('transfer.consequence', { name: displayName(selected) })}
                </p>
                <p className="text-(--el-text-secondary) mt-0.5">{t('transfer.consequenceSub')}</p>
              </div>
            </div>
          ) : null}
          <Input
            label={t('transfer.confirmLabel', { org: orgName })}
            placeholder={orgName}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={isPending}
            autoComplete="off"
          />

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-card) p-3 font-sans text-sm text-(--el-text-strong)"
              style={{ backgroundColor: 'var(--el-tint-rose)' }}
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <Modal.Footer className="shrink-0">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={!canSubmit} loading={isPending}>
            {isPending ? t('transfer.pending') : t('transfer.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function MemberList({
  load,
  members,
  query,
  selectedId,
  onSelect,
  onRetry,
}: {
  load: LoadState;
  members: OrgMemberDTO[];
  query: string;
  selectedId: string | null;
  onSelect: (member: OrgMemberDTO) => void;
  onRetry: () => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  if (load === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-4 font-sans text-sm text-(--el-text-muted)">
        <span>{t('transfer.pickerLoadError')}</span>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {tc('retry')}
        </Button>
      </div>
    );
  }
  if (load === 'ready' && members.length === 0) {
    return (
      <p className="px-3 py-4 font-sans text-sm text-(--el-text-muted)">
        {query.trim()
          ? t('transfer.pickerNoMatch', { q: query.trim() })
          : t('transfer.pickerEmpty')}
      </p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('transfer.pickerLabel')}
      aria-busy={load === 'loading'}
      className={load === 'loading' ? 'opacity-60' : undefined}
    >
      {members.map((m) => {
        const checked = m.userId === selectedId;
        return (
          <label
            key={m.userId}
            className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
              checked ? 'bg-(--el-surface-soft) shadow-[inset_2px_0_0_var(--el-accent)]' : ''
            }`}
          >
            <input
              type="radio"
              name="transfer-target"
              value={m.userId}
              checked={checked}
              onChange={() => onSelect(m)}
              className="accent-(--el-accent)"
            />
            <span className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold">
              {(m.name || m.email).charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
                {displayName(m)}
              </span>
              <span className="text-(--el-text-secondary) block truncate font-sans text-xs">
                {m.email}
              </span>
            </span>
            <Pill orgRole={m.role === 'admin' ? 'admin' : 'member'}>
              {m.role === 'admin' ? t('roles.admin') : t('roles.member')}
            </Pill>
          </label>
        );
      })}
    </div>
  );
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function readHash(): string {
  return window.location.hash;
}

function displayName(m: Pick<OrgMemberDTO, 'name' | 'email'>): string {
  return m.name || m.email;
}
