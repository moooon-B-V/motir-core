'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { IssueQuickView } from './IssueQuickView';
import { IssueQuickViewPanel } from './IssueQuickViewPanel';
import type { QuickViewData } from '@/lib/dto/quickView';

// The quick-view (peek) CONTROLLER (bug 8.8.2) — the single client island that
// drives the `?peek=<identifier>` modal on every surface it appears (/items,
// /ready, /boards). It reads `peek` from the URL via `useSearchParams`, so the
// modal FRAME + skeleton render INSTANTLY the moment the param is set (the open
// is a shallow URL update — see usePeekOpen — that never re-renders the host
// server page), then it client-FETCHES the item's fields from /api/work-items/peek
// and swaps the skeleton for the populated panel when they land. Closing is the
// same shallow URL clear: the param drops, this renders nothing, the modal
// dismisses immediately with no underlying-list refetch.
//
// This replaces the former server-rendered peek block (an <IssueQuickView> whose
// <Suspense> body was the async IssueQuickViewContent), which sat BEHIND each
// host page's blocking data reads — so opening `?peek` waited on that server
// work and closing (router.push) re-ran it. The island decouples the peek from
// the page's render entirely.
//
// The loading state is DERIVED from render (the showing key !== the URL key),
// never set synchronously in the effect (the React-19 set-state-in-effect lint).

type PeekResult =
  | { key: string; status: 'ready'; data: QuickViewData }
  | { key: string; status: 'notfound' };

export function IssueQuickViewController() {
  const searchParams = useSearchParams();
  const peek = searchParams.get('peek')?.trim() || null;
  const [result, setResult] = useState<PeekResult | null>(null);

  useEffect(() => {
    if (!peek) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/work-items/peek?key=${encodeURIComponent(peek)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          // 404 (stale / deleted / cross-workspace / forbidden — the no-leak
          // contract) and any other failure both land on the not-found panel;
          // the peek never crashes the host surface.
          setResult({ key: peek, status: 'notfound' });
          return;
        }
        const data = (await res.json()) as QuickViewData;
        setResult({ key: peek, status: 'ready', data });
      } catch {
        // An aborted fetch (the peek changed/closed mid-flight) is expected —
        // ignore it; a real network error falls back to the not-found panel.
        if (controller.signal.aborted) return;
        setResult({ key: peek, status: 'notfound' });
      }
    })();
    return () => controller.abort();
  }, [peek]);

  if (!peek) return null;

  // Show the fetched result ONLY when it's for the key currently in the URL;
  // otherwise (first open, or a swap to a new blocker) the skeleton holds.
  const showing = result && result.key === peek ? result : null;

  return (
    <IssueQuickView peekKey={peek}>
      {showing === null ? (
        <IssueQuickViewPanel state="loading" peekKey={peek} />
      ) : showing.status === 'notfound' ? (
        <IssueQuickViewPanel state="notfound" peekKey={peek} />
      ) : (
        <IssueQuickViewPanel state="ready" data={showing.data} />
      )}
    </IssueQuickView>
  );
}
