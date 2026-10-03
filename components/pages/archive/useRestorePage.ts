'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/Toast';
import type { RestorePageResultDto } from '@/lib/dto/pages';
import { restorePageRequest, type ArchiveOutcome } from './archiveClient';

// RESTORING AN ARCHIVED PAGE (Story MOTIR-5755 · MOTIR-7423), the one restore
// path every door uses: the archive toast's Undo, the archived page's banner
// and — next — a row of the Archived pages list (MOTIR-7424). Design MOTIR-7416,
// surfaces 4, 5 and 8.
//
// ── THE TOAST IS DECIDED BY WHERE IT LANDED ────────────────────────────────
// `DELETE …/archive` answers `landing.kind` (MOTIR-7421):
//   original      → success — "Restored “{title}” and {n} sub-pages"
//   ancestorPage  → info    — "Restored “{title}”", under "{landing}" because
//                             "{parent}" is archived
//   folder        → info    — into the folder "{folder}"
//   root          → info    — at the project root
// "{parent}" is the page's ORIGINAL parent, which the answer does not carry; the
// caller passes the title it holds (the breadcrumb's last page, the tree row
// above it, the list's came-from trail). The design's fifth row, a rung skipped
// for DEPTH, is the same `ancestorPage` kind on the wire and cannot be told
// apart from it here, so it reads the archived-parent sentence.
//
// Open (the toast's action) is offered where the reader is NOT already looking
// at the page — the list — and left off on the page itself.
//
// ── REFUSALS ───────────────────────────────────────────────────────────────
//   PAGE_ARCHIVE_ROOT_REQUIRED → "Couldn’t restore …", naming the root when the
//                                caller knows it, with Open “{root}” (the 409's
//                                `rootId`).
//   PAGE_NOT_ARCHIVED          → someone restored it already: the outcome goes
//                                back to the caller, which re-reads (the page
//                                refreshes; the list drops the row and says so).
//   anything else              → "Couldn’t restore “{title}”. Try again."
// A second restore of the same page while one is in flight is refused by a ref.

export interface RestoreTarget {
  id: string;
  /** The page's title as the surface shows it (Untitled already resolved). */
  title: string;
  /** Its ORIGINAL parent's title, for the restored-elsewhere reason. */
  parentTitle?: string | null;
  /** Its archive root's title, when the surface knows it — for the root-required refusal. */
  rootTitle?: string | null;
}

export interface RestorePageOptions {
  /** Offer **Open** on the toast — on a surface that is not the page itself. */
  showOpen?: boolean;
}

export interface RestorePageController {
  /** The page a restore is in flight for, or `null`. */
  pendingId: string | null;
  restore: (target: RestoreTarget) => Promise<ArchiveOutcome<RestorePageResultDto> | null>;
}

export function useRestorePage({
  showOpen = false,
}: RestorePageOptions = {}): RestorePageController {
  const t = useTranslations('pages.archive');
  const tp = useTranslations('pages');
  const router = useRouter();
  const { toast } = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());

  const restore = useCallback(
    async (target: RestoreTarget) => {
      if (inFlight.current.has(target.id)) return null;
      inFlight.current.add(target.id);
      setPendingId(target.id);
      const outcome = await restorePageRequest(target.id);
      inFlight.current.delete(target.id);
      setPendingId((current) => (current === target.id ? null : current));

      const open = (id: string, label: string) => ({
        label,
        onClick: () => router.push(`/pages/${encodeURIComponent(id)}`),
      });

      if (outcome.ok) {
        const { landing, restoredIds } = outcome.result;
        const count = Math.max(0, restoredIds.length - 1);
        const action = showOpen ? open(target.id, t('open')) : undefined;
        const parent = target.parentTitle || tp('untitled');
        const named = landing.title || tp('untitled');
        if (landing.kind === 'original') {
          toast({
            variant: 'success',
            title:
              count > 0
                ? t('restored', { title: target.title, count })
                : t('restoredOne', { title: target.title }),
            action,
          });
        } else {
          toast({
            variant: 'info',
            title: t('restoredOne', { title: target.title }),
            description:
              landing.kind === 'ancestorPage'
                ? t('landing.ancestorPage', { landing: named, parent })
                : landing.kind === 'folder'
                  ? t('landing.folder', { folder: named, parent })
                  : t('landing.root'),
            action,
          });
        }
        return outcome;
      }

      if (outcome.kind === 'rootRequired') {
        const root = target.rootTitle || null;
        toast({
          variant: 'error',
          title: t('refusal.rootRequired', { title: target.title }),
          description: root
            ? t('refusal.rootRequiredBody', { title: target.title, root })
            : undefined,
          action: outcome.rootId
            ? open(outcome.rootId, root ? t('openRoot', { root }) : t('open'))
            : undefined,
        });
      } else if (outcome.kind !== 'notArchived') {
        toast({ variant: 'error', title: t('restoreFailed', { title: target.title }) });
      }
      return outcome;
    },
    [router, showOpen, t, toast, tp],
  );

  return { pendingId, restore };
}
