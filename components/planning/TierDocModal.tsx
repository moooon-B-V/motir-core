'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, FileQuestion, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { DirectionDocView } from '@/components/onboarding/DirectionDocView';
import {
  TIER_META,
  type DirectionDocKind,
  type DirectionDocView as DirectionDocModel,
  type FeatureCatalogView,
} from '@/lib/onboarding/directionDoc';
import { fetchPreplanState, findTierDoc, producedTierKinds } from '@/lib/onboarding/preplanClient';

// TierDocModal (Subtask 7.20.14 / MOTIR-1355) — the on-canvas viewer for the four
// pre-plan DIRECTION-TIER docs (discovery / vision / feasibility / validation).
// Opened by the View button on a selected tier STATION on the roadmap canvas
// (per the 7.20.10 design, `design/roadmap/detail-surfaces.*`): it reuses the
// SAME shared `Modal` shell (size="xl", srTitle — the body owns its heading) as
// the work-item quick-view (MOTIR-1352), and renders the SHIPPED read-only
// `DirectionDocView` (MOTIR-834) inside — NEVER a redrawn stand-in (notes #82/#95).
//
// It reads the doc from the pre-plan store through `GET /api/ai/pre-plan` (the
// active project's resumable state) via the shared `fetchPreplanState` client; the
// modal owns the I/O so it can surface loading / error / empty(no-doc) states. The
// modal head carries `Open full page` → the read-only full-page route
// `/direction/[tier]` (the same `DirectionDocView` at full reading width).

interface LoadStateLoading {
  status: 'loading';
}
interface LoadStateError {
  status: 'error';
}
interface LoadStateEmpty {
  status: 'empty';
}
interface LoadStateReady {
  status: 'ready';
  doc: DirectionDocModel;
  catalog: FeatureCatalogView | null;
  availableDocs: DirectionDocKind[];
}
type LoadState = LoadStateLoading | LoadStateError | LoadStateEmpty | LoadStateReady;

export interface TierDocModalProps {
  /** The tier whose doc to show; `null` keeps the modal closed. */
  tier: DirectionDocKind | null;
  /** Close the modal (the consumer clears its open-tier state). */
  onClose: () => void;
  /**
   * Where the modal is mounted, which decides what "Open full page" does (MOTIR-1366):
   * - `roadmap` (default) — the user is already inside the app shell, so the full
   *   page opens in the SAME tab, in-shell (`/direction/[tier]`).
   * - `onboarding` — the user hasn't seen the app yet, so the full page opens in a
   *   NEW TAB, full-screen, WITHOUT the app shell (`/onboarding/direction/[tier]`).
   */
  origin?: 'onboarding' | 'roadmap';
}

export function TierDocModal({ tier, onClose, origin = 'roadmap' }: TierDocModalProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Discard an out-of-order resolve (the tier changed mid-fetch) by sequence.
  const reqSeq = useRef(0);

  useEffect(() => {
    if (tier === null) return;
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    void (async () => {
      setState({ status: 'loading' });
      try {
        const preplan = await fetchPreplanState(controller.signal);
        if (seq !== reqSeq.current) return;
        if (!preplan) {
          setState({ status: 'error' });
          return;
        }
        const doc = findTierDoc(preplan, tier);
        if (!doc) {
          setState({ status: 'empty' });
          return;
        }
        setState({
          status: 'ready',
          doc,
          catalog: preplan.catalog,
          availableDocs: producedTierKinds(preplan),
        });
      } catch {
        // An aborted fetch (unmount / tier change) lands here too; the seq guard
        // means a superseded request never overwrites the current state.
        if (seq === reqSeq.current) setState({ status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [tier]);

  const meta = tier ? TIER_META[tier] : null;

  return (
    <Modal
      open={tier !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      // The doc renders its own visible heading (plain-language tier label), so we
      // give the dialog its accessible name via srTitle rather than a visible title.
      srTitle={meta?.label}
      // The head below carries the close + Open-full-page controls (the design's
      // thin m-head), so suppress Modal's own corner ×.
      hideClose
      className="h-[min(46rem,90vh)] p-0"
    >
      {/* Thin head — a contextual kicker, the Open-full-page action, and close.
          Mirrors `detail-surfaces.mock.html` panel 4's `m-head`. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--el-border) px-(--spacing-card-padding) py-(--spacing-control-y)">
        <span className="text-xs font-medium tracking-wide text-(--el-text-muted) uppercase">
          Direction{tier ? ` · ${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : ''}
        </span>
        <span className="flex-1" />
        {tier &&
          (origin === 'onboarding' ? (
            // Onboarding: open the SHELL-LESS full page in a NEW TAB so the user
            // stays in the immersive onboarding flow (never dropped into the app
            // shell they haven't seen). A plain anchor, not next/link — it's a
            // cross-context, new-tab navigation.
            <a
              href={`/onboarding/direction/${tier}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-(--radius-btn) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <ArrowUpRight className="size-4" aria-hidden="true" />
              Open full page
            </a>
          ) : (
            <Link
              href={`/direction/${tier}`}
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-(--radius-btn) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <ArrowUpRight className="size-4" aria-hidden="true" />
              Open full page
            </Link>
          ))}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <X className="size-4" />
        </button>
      </div>

      <Modal.Body className="px-(--spacing-card-padding) py-(--spacing-card-padding)">
        {state.status === 'loading' && (
          <div aria-busy="true" className="flex min-h-[16rem] flex-1 items-center justify-center">
            <Spinner aria-label="Loading the direction doc" />
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex min-h-[16rem] flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-semibold text-(--el-text)">Couldn&apos;t load this doc</p>
            <p className="text-sm text-(--el-text-muted)">
              Something went wrong reading your direction. Close and try again.
            </p>
          </div>
        )}

        {state.status === 'empty' && (
          <div className="flex min-h-[16rem] flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FileQuestion className="size-6 text-(--el-text-faint)" aria-hidden="true" />
            <p className="text-sm font-semibold text-(--el-text)">
              {meta ? meta.label : 'This part of your direction'} isn&apos;t ready yet
            </p>
            <p className="max-w-[22rem] text-sm text-(--el-text-muted)">
              This tier hasn&apos;t been drafted for this project. It&apos;ll appear here once Motir
              writes it up in the chat.
            </p>
          </div>
        )}

        {state.status === 'ready' && (
          <DirectionDocView
            doc={state.doc}
            catalog={state.catalog}
            availableDocs={state.availableDocs}
          />
        )}
      </Modal.Body>
    </Modal>
  );
}
