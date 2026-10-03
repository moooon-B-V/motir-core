'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/Toast';
import type { PageParentDto } from '@/lib/dto/pages';

// CREATING A PAGE AT A PLACE (Story MOTIR-5752 · MOTIR-7300; placed by Story
// MOTIR-5753 · MOTIR-7373) — `design/pages/design-notes.md` § The page tree,
// "New". The one create path every New in `/pages` goes through: the header's
// New page (the root), a folder's New page here and a page's New sub-page.
//
// One POST to `/api/pages` with the `parent` (MOTIR-7372), then the browser
// moves to the new page, whose title takes focus — no dialog. On success the
// pending state is KEPT: the browser is leaving, and clearing it would invite a
// second page. A failure is the shipped `pages.index.createFailed` toast and the
// pending state clears.
//
// `pending` names WHERE the page is being created, so the tree can draw its
// pending "Creating page…" row in that level. A second create while one is in
// flight is refused by a ref, not only by a disabled control — the ref is what
// stands if a control is re-enabled mid-flight.

/** A refused create, carrying the route's code. */
class CreateRefused extends Error {
  constructor(readonly code: string) {
    super(`POST /api/pages refused: ${code || 'unknown'}`);
  }
}

export interface CreatePageController {
  /** The parent a create is in flight under, or `null`. */
  pending: PageParentDto | null;
  /**
   * Create an empty page under `parent` and move to it. `parentTitle` names the
   * parent page in the refusal when it was archived meanwhile (MOTIR-7423).
   */
  create: (parent: PageParentDto, parentTitle?: string) => Promise<void>;
}

export function useCreatePage(): CreatePageController {
  const t = useTranslations('pages.index');
  const ta = useTranslations('pages.archive.refusal');
  const tp = useTranslations('pages');
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PageParentDto | null>(null);
  const inFlight = useRef(false);

  const create = useCallback(
    async (parent: PageParentDto, parentTitle?: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(parent);
      try {
        const res = await fetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { code?: unknown };
          throw new CreateRefused(typeof body.code === 'string' ? body.code : '');
        }
        const { id } = (await res.json()) as { id: string };
        router.push(`/pages/${encodeURIComponent(id)}`);
      } catch (err) {
        inFlight.current = false;
        setPending(null);
        // A stale tab's New sub-page under a page someone archived (422
        // PAGE_PARENT_ARCHIVED, MOTIR-7418): the archive's own sentence.
        const parentArchived = err instanceof CreateRefused && err.code === 'PAGE_PARENT_ARCHIVED';
        toast({
          variant: 'error',
          title: parentArchived
            ? ta('parentArchived', { parent: parentTitle || tp('untitled') })
            : t('createFailed'),
        });
      }
    },
    [router, t, ta, toast, tp],
  );

  return { pending, create };
}
