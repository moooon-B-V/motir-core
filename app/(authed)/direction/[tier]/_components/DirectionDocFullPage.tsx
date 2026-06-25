'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, FileQuestion } from 'lucide-react';
import { DirectionDocView } from '@/components/onboarding/DirectionDocView';
import {
  TIER_META,
  type DirectionDocKind,
  type DirectionDocView as DirectionDocModel,
  type FeatureCatalogView,
} from '@/lib/onboarding/directionDoc';

// The read-only tier-doc FULL PAGE body (Subtask 7.20.14 / MOTIR-1355) — the
// `/direction/[tier]` route's client shell, per `design/roadmap/detail-surfaces`
// panel 5: a thin top bar (← Back to roadmap + breadcrumb) over the SHIPPED
// `DirectionDocView` (834) at full reading width. The server page owns the read;
// this owns the back affordance (`router.back()` returns to the canvas the viewer
// was opened from) and routes the cross-links to each tier's own full page.

export interface DirectionDocFullPageProps {
  tier: DirectionDocKind;
  /** The produced doc, or null when this tier hasn't been drafted (empty state). */
  doc: DirectionDocModel | null;
  catalog: FeatureCatalogView | null;
  availableDocs: DirectionDocKind[];
  /** The pre-plan read failed upstream (motir-ai 502) — the error state. */
  error?: boolean;
}

export function DirectionDocFullPage({
  tier,
  doc,
  catalog,
  availableDocs,
  error = false,
}: DirectionDocFullPageProps) {
  const router = useRouter();
  const meta = TIER_META[tier];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--el-border) pb-(--spacing-control-y)">
        <button
          type="button"
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 rounded-(--radius-btn) px-(--spacing-btn-x) py-(--spacing-btn-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back to roadmap
        </button>
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
          <span className="text-(--el-text-muted)">Roadmap</span>
          <span className="text-(--el-text-faint)" aria-hidden="true">
            ›
          </span>
          <span className="text-(--el-text-muted)">Direction</span>
          <span className="text-(--el-text-faint)" aria-hidden="true">
            ›
          </span>
          <span className="font-semibold text-(--el-text)">{meta.label}</span>
        </nav>
      </div>

      <div className="py-8">
        {error ? (
          <div className="mx-auto flex max-w-[45rem] flex-col items-center gap-1 py-16 text-center">
            <p className="text-sm font-semibold text-(--el-text)">Couldn&apos;t load this doc</p>
            <p className="text-sm text-(--el-text-muted)">
              Something went wrong reading your direction. Try again in a moment.
            </p>
          </div>
        ) : doc ? (
          <DirectionDocView
            doc={doc}
            catalog={catalog}
            availableDocs={availableDocs}
            onNavigate={(kind) => router.push(`/direction/${kind}`)}
          />
        ) : (
          <div className="mx-auto flex max-w-[45rem] flex-col items-center gap-2 py-16 text-center">
            <FileQuestion className="size-7 text-(--el-text-faint)" aria-hidden="true" />
            <p className="text-sm font-semibold text-(--el-text)">
              {meta.label} isn&apos;t ready yet
            </p>
            <p className="max-w-[24rem] text-sm text-(--el-text-muted)">
              This tier hasn&apos;t been drafted for this project. It&apos;ll appear here once Motir
              writes it up in the chat.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
