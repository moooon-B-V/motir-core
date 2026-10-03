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

export interface CreatePageController {
  /** The parent a create is in flight under, or `null`. */
  pending: PageParentDto | null;
  /** Create an empty page under `parent` and move to it. */
  create: (parent: PageParentDto) => Promise<void>;
}

export function useCreatePage(): CreatePageController {
  const t = useTranslations('pages.index');
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PageParentDto | null>(null);
  const inFlight = useRef(false);

  const create = useCallback(
    async (parent: PageParentDto) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(parent);
      try {
        const res = await fetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent }),
        });
        if (!res.ok) throw new Error(`POST /api/pages answered ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        router.push(`/pages/${encodeURIComponent(id)}`);
      } catch {
        inFlight.current = false;
        setPending(null);
        toast({ variant: 'error', title: t('createFailed') });
      }
    },
    [router, t, toast],
  );

  return { pending, create };
}
