'use client';

import { useCallback, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

// The quick-view (peek) MODAL FRAME (Subtask 2.5.19) — the client shell the
// Server Component renders when `?peek=<key>` is present on /issues. It composes
// the shipped components/ui/Modal (Radix focus-trap + Esc + backdrop-close +
// return-focus) as a LARGE dialog (size="xl", h-[680px] capped to 82vh, p-0 so
// the peek owns its own full-bleed header/body) per
// design/work-items/quick-view.mock.html. The body is passed as `children` (a
// streamed Server Component behind a Suspense boundary), so the modal opens
// IMMEDIATELY with a skeleton while the item's fields fetch.
//
// The peek lives in the URL: closing (Esc / backdrop / the × / "Close") clears
// `?peek` while preserving every other param (view/sort/filter/page), so the
// underlying list view is untouched. `usePeekClose` is the one place that
// computes the cleared URL — reused by the header × and the not-found Close
// (QuickViewCloseButton).

/** Returns a stable callback that navigates to the current URL minus `?peek`. */
export function usePeekClose() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString());
    params.delete('peek');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);
}

export function IssueQuickView({ peekKey, children }: { peekKey: string; children: ReactNode }) {
  const t = useTranslations('issueViews');
  const close = usePeekClose();

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      hideClose
      size="xl"
      srTitle={t('quickViewDialogLabel', { key: peekKey })}
      className="h-[680px] max-h-[82vh] w-[90vw] p-0"
    >
      {children}
    </Modal>
  );
}
