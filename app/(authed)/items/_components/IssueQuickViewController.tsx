'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { IssueQuickView } from './IssueQuickView';
import { IssueQuickViewPanel } from './IssueQuickViewPanel';
import { useNotifyIssuesChanged } from '../../_components/CreateIssueProvider';
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const peek = searchParams.get('peek')?.trim() || null;
  const [result, setResult] = useState<PeekResult | null>(null);
  // MOTIR-2563 — the host surface behind the modal. The rail edits
  // optimistically and NEVER refreshes the route on success (doing that per edit
  // is what caused `bug-inline-status-revert-on-second-edit`), so the list/board
  // underneath keeps rendering what the server sent before the peek opened. The
  // design (panel 12) settles it: re-read ONCE, on CLOSE, and only when an edit
  // was actually confirmed. Close is the only moment that is both safe — the
  // modal is going away, so no optimistic cell can be repainted by the re-read —
  // and sufficient, because the user's next glance is at the list.
  //
  // MOTIR-2604 — settling takes BOTH mechanisms, because this controller's hosts
  // are two different KINDS of surface at once (CLAUDE.md § page state after a
  // mutation). `router.refresh()` re-runs the Server Components and updates the
  // genuinely server-rendered bits. It does NOT reach `IssueTreeTable` or
  // `BoardContainer`: both are client islands seeded once from server props, so
  // the refreshed props are ignored by a `useState` initializer that already ran
  // and neither key changes to force a remount. Those watch the provider's
  // `issuesChangedAt` tick instead — so the peek bumps that too. Shipping only
  // the refresh left the row behind the modal reading its pre-edit value until
  // the user reloaded by hand, which is the panel-12 promise not being kept on
  // the primary surface. The non-throwing accessor is deliberate: this island
  // also mounts in unit tests and on surfaces with no provider above it.
  const notifyIssuesChanged = useNotifyIssuesChanged();
  const editedRef = useRef(false);
  const markEdited = useCallback(() => {
    editedRef.current = true;
  }, []);

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

  // The peek closed (the `?peek` param cleared). If anything was written while
  // it was open, re-read the host surface now — both halves of it (MOTIR-2604).
  useEffect(() => {
    if (peek) return;
    if (!editedRef.current) return;
    editedRef.current = false;
    router.refresh();
    notifyIssuesChanged();
  }, [peek, router, notifyIssuesChanged]);

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
        // KEYED BY THE ITEM (MOTIR-2566). A blocker link inside the peek SWAPS the
        // peeked item without unmounting this panel, and the rail's editors seed
        // their state from the payload once (`useState(initial)`), so an unkeyed
        // panel would carry the previous item's chips, overrides and
        // acknowledged `updatedAt` onto the new one. The key makes a swap a
        // remount, which is what the seeded state assumes.
        <IssueQuickViewPanel
          key={showing.data.identifier}
          state="ready"
          data={showing.data}
          onEdited={markEdited}
        />
      )}
    </IssueQuickView>
  );
}
