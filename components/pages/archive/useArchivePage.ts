'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/Toast';
import type {
  ArchivePageResultDto,
  PageArchiveSetDto,
  RestorePageResultDto,
} from '@/lib/dto/pages';
import { archivePageRequest, readArchiveSet } from './archiveClient';
import { useRestorePage } from './useRestorePage';

// ARCHIVING A PAGE (Story MOTIR-5755 · MOTIR-7423) — design MOTIR-7416, surfaces
// 1–4 and the tree's refusals (surface 9). The one archive path the `/pages`
// tree's row menu and the page's own ⋯ both go through; it mirrors
// `WorkItemActionsMenu`'s `runArchive` / `archivedToast` / `runUnarchive`.
//
// ── THE FLOW ───────────────────────────────────────────────────────────────
// `request(target)`:
//   • a page the caller KNOWS has no sub-pages (a tree row with no chevron)
//     archives at once — no dialog, the work-item precedent;
//   • otherwise the set is read first (`GET …/archive`): none → archive at once;
//     some → the confirm opens with the count and the first names
//     (`confirm`, rendered by the caller as `ArchivePageDialog`).
// The archive (`POST …/archive`) then hands its answer to `onArchived` — the tree
// takes the rows out of its loaded levels, the page re-reads itself into the
// archived state — and a success toast offers **Undo**, which restores the set
// through `useRestorePage` and hands that answer to `onRestored`.
//
// ── REFUSALS ───────────────────────────────────────────────────────────────
//   409 PAGE_ARCHIVED (a stale tab) → "“{title}” is already archived" and
//                                     `onStale`, so the tree re-reads the level
//   404 (it is gone)                → the failure toast and `onStale`
//   anything else                   → "Couldn’t archive “{title}”. Try again.";
//                                     nothing on screen changes
// A second request while one is in flight is refused by a ref.

export interface ArchiveTarget {
  id: string;
  /** The page's title as the surface shows it (Untitled already resolved). */
  title: string;
  /** `false` when the caller knows the page has no live sub-pages; unknown otherwise. */
  hasChildren?: boolean;
  /** Its parent's title, for Undo's restored-elsewhere reason. */
  parentTitle?: string | null;
}

export interface ArchivePageOptions {
  onArchived: (target: ArchiveTarget, result: ArchivePageResultDto) => void;
  onRestored: (target: ArchiveTarget, result: RestorePageResultDto) => void;
  /** The page was already archived or is gone: the surface re-reads. */
  onStale?: (target: ArchiveTarget) => void;
}

/** The open confirm — `ArchivePageDialog`'s props. */
export interface ArchiveConfirmState {
  title: string;
  set: PageArchiveSetDto;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface ArchivePageController {
  request: (target: ArchiveTarget) => void;
  /** The page an archive is in flight for (the set read included), or `null`. */
  pendingId: string | null;
  /** The confirm to render, or `null`. */
  confirm: ArchiveConfirmState | null;
}

export function useArchivePage({
  onArchived,
  onRestored,
  onStale,
}: ArchivePageOptions): ArchivePageController {
  const t = useTranslations('pages.archive');
  const { toast } = useToast();
  const { restore } = useRestorePage();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [open, setOpen] = useState<{ target: ArchiveTarget; set: PageArchiveSetDto } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);
  // The confirm's own guard: a double click lands twice in ONE render, where the
  // `confirming` state each closure read is still false.
  const confirmingRef = useRef(false);

  const finish = useCallback(() => {
    inFlight.current = false;
    confirmingRef.current = false;
    setPendingId(null);
    setConfirming(false);
    setOpen(null);
  }, []);

  const undo = useCallback(
    async (target: ArchiveTarget) => {
      const outcome = await restore({
        id: target.id,
        title: target.title,
        parentTitle: target.parentTitle,
      });
      if (outcome?.ok) onRestored(target, outcome.result);
    },
    [restore, onRestored],
  );

  const run = useCallback(
    async (target: ArchiveTarget) => {
      setConfirming(true);
      const outcome = await archivePageRequest(target.id);
      finish();
      if (outcome.ok) {
        onArchived(target, outcome.result);
        const count = outcome.result.subPageCount;
        toast({
          variant: 'success',
          title:
            count > 0
              ? t('archived', { title: target.title, count })
              : t('archivedOne', { title: target.title }),
          action: { label: t('undo'), onClick: () => void undo(target) },
        });
        return;
      }
      if (outcome.kind === 'alreadyArchived') {
        toast({
          variant: 'error',
          title: t('refusal.alreadyArchived', { title: target.title }),
          description: t('refusal.alreadyArchivedBody'),
        });
      } else {
        toast({ variant: 'error', title: t('archiveFailed', { title: target.title }) });
      }
      if (outcome.kind === 'alreadyArchived' || outcome.kind === 'gone') onStale?.(target);
    },
    [finish, onArchived, onStale, t, toast, undo],
  );

  const request = useCallback(
    (target: ArchiveTarget) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPendingId(target.id);
      if (target.hasChildren === false) {
        void run(target);
        return;
      }
      void (async () => {
        const outcome = await readArchiveSet(target.id);
        if (outcome.ok && outcome.result.subPageCount === 0) {
          await run(target);
          return;
        }
        if (outcome.ok) {
          setOpen({ target, set: outcome.result });
          return;
        }
        finish();
        toast({ variant: 'error', title: t('archiveFailed', { title: target.title }) });
        if (outcome.kind === 'gone') onStale?.(target);
      })();
    },
    [finish, onStale, run, t, toast],
  );

  const confirm: ArchiveConfirmState | null = open
    ? {
        title: open.target.title,
        set: open.set,
        pending: confirming,
        onConfirm: () => {
          if (confirmingRef.current) return;
          confirmingRef.current = true;
          void run(open.target);
        },
        onCancel: finish,
      }
    : null;

  return { request, pendingId, confirm };
}
