'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import type { QuickViewData } from '@/lib/dto/quickView';

// The roadmap-canvas WORK-ITEM QUICK-VIEW (Subtask 7.20.11 / MOTIR-1352) — the
// peek the canvas "View" button opens for a work-item node, per the 7.20.10
// design (design/roadmap/design-notes.md → "Canvas detail surfaces"). It REUSES
// the shipped /items peek surface VERBATIM (notes.html #82 — reuse the real
// component, never a stylized stand-in): the same components/ui/Modal shell
// (size="xl", the h-[680px]/82vh two-column dialog) wrapping the same
// IssueQuickViewPanel body (header + scrollable description + core-fields rail,
// read-only), fed by the same GET /api/work-items/peek read → QuickViewData. No
// new endpoint, no hand-rolled modal.
//
// The ONE difference from the /items IssueQuickViewController is what drives it:
// the /items peek lives in the `?peek=` URL (shareable, reload-safe across a list
// route), but the roadmap canvas is a reusable, route-agnostic foundation, so its
// peek is driven by LOCAL state — `peekKey` in + `onClose` out (passed through to
// the panel's close affordances). Same open-immediately-then-stream shape: the
// modal frame + skeleton render the instant `peekKey` is set, and the fields
// stream in over the wire.

type PeekResult =
  | { key: string; status: 'ready'; data: QuickViewData }
  | { key: string; status: 'notfound' };

export function WorkItemQuickView({
  peekKey,
  onClose,
}: {
  /** The work item's identifier (e.g. `MOTIR-12`) to peek, or null when closed. */
  peekKey: string | null;
  /** Close the peek — wired to the panel's × / "Close" and the modal's Esc/backdrop. */
  onClose: () => void;
}) {
  const t = useTranslations('issueViews');
  const [result, setResult] = useState<PeekResult | null>(null);

  useEffect(() => {
    if (!peekKey) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/work-items/peek?key=${encodeURIComponent(peekKey)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          // 404 (stale / deleted / cross-workspace / forbidden — the no-leak
          // contract) and any other failure land on the not-found panel; the peek
          // never crashes the canvas.
          setResult({ key: peekKey, status: 'notfound' });
          return;
        }
        const data = (await res.json()) as QuickViewData;
        setResult({ key: peekKey, status: 'ready', data });
      } catch {
        // An aborted fetch (the peek changed/closed mid-flight) is expected —
        // ignore it; a real network error falls back to the not-found panel.
        if (controller.signal.aborted) return;
        setResult({ key: peekKey, status: 'notfound' });
      }
    })();
    return () => controller.abort();
  }, [peekKey]);

  if (!peekKey) return null;

  // Show the fetched result ONLY when it's for the key currently open; otherwise
  // (first open, or a swap to a new key) the skeleton holds — the loading state is
  // DERIVED from render (showing key !== open key), never set in the effect (the
  // React-19 set-state-in-effect lint).
  const showing = result && result.key === peekKey ? result : null;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      hideClose
      size="xl"
      srTitle={t('quickViewDialogLabel', { key: peekKey })}
      className="h-[680px] max-h-[82vh] w-[90vw] p-0"
    >
      {showing === null ? (
        <IssueQuickViewPanel state="loading" peekKey={peekKey} onClose={onClose} />
      ) : showing.status === 'notfound' ? (
        <IssueQuickViewPanel state="notfound" peekKey={peekKey} onClose={onClose} />
      ) : (
        <IssueQuickViewPanel state="ready" data={showing.data} onClose={onClose} />
      )}
    </Modal>
  );
}
