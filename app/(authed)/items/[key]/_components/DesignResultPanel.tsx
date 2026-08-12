'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExternalLink,
  FileWarning,
  GitCommitHorizontal,
  ImageOff,
  PanelsTopLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { renderMarkdown } from '@/lib/markdown/render';
import { AttachmentPreview, type PreviewableAttachment } from './AttachmentPreview';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// The Design result panel (Story MOTIR-2664 · Subtask MOTIR-2670), built to
// design/work-items/design-result.png. Rendered inside a ContentSectionCard on a
// leaf's detail page. Colour via --el-*, shape via element-semantic tokens;
// primitives are Button / Pill and the shipped AttachmentPreview lightbox.
//
// ⚠️ THREE states, not five. docs/decisions/design-result.md §2 decided the
// feature has NO entitlement axis, so unlike the acceptance panel beside it
// there is no upsell and no toggle to render.
//
// The panel is READ-ONLY: it exposes no control that writes and never advances
// the item's status. Approve / request-changes and the revise loop belong to the
// runtime design-approval gate (§7), whose surface COMPOSES this one.

/** The frame height the design measured (design-notes.md § Design result panel). */
const FRAME_HEIGHT = 'h-[32rem]';

export interface DesignResultPanelProps {
  evidence: DesignEvidenceDTO | null;
  /** Shown in the empty state so a reader knows where a result comes from. */
  isDesignCard: boolean;
}

/** The last path segment of a repo path — the display name for an artifact. */
function basenameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
}

/**
 * The lightbox's contract, built from a design asset. `AttachmentDTO` is NOT
 * used: its `source` union deliberately excludes the lifecycle-owned sources,
 * and the lightbox never reads that field anyway (MOTIR-2670).
 */
function toPreviewable(asset: DesignAssetDTO): PreviewableAttachment | null {
  if (!asset.url) return null;
  return {
    filename: basenameOf(asset.sourcePath),
    blobUrl: asset.url,
    sizeBytes: asset.sizeBytes ?? 0,
    isImage: true,
    isPdf: false,
  };
}

function Provenance({ evidence }: { evidence: DesignEvidenceDTO }) {
  const t = useTranslations('designResult');
  const chip =
    'inline-flex items-center gap-1 rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text-secondary)';

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-(--el-border-soft) pt-3.5 text-xs text-(--el-text-secondary)">
      {evidence.commitSha ? (
        <span className={chip}>
          <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
          <span className="font-mono">{evidence.commitSha.slice(0, 7)}</span>
        </span>
      ) : null}
      {evidence.ciRunUrl ? (
        <a className={chip} href={evidence.ciRunUrl} target="_blank" rel="noopener noreferrer">
          {t('ciRun')}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
      {evidence.producedByKey ? (
        <span className={chip}>
          {t('publishedBy')} <span className="font-mono">{evidence.producedByKey}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The sandboxed mock frame. Its `src` is the AUTHENTICATED content route, which
 * 302s to a presigned URL on the object-store host — so the document is
 * cross-origin to the app before the sandbox is applied at all.
 *
 * ⚠️ `sandbox=""` grants NOTHING: neither `allow-scripts` nor
 * `allow-same-origin`, never the two together. The shipped assets tolerate it
 * because they are self-contained inline CSS with no `<script>`; a mock that
 * needs JavaScript renders inert, which is the recorded trade (§5c).
 */
function MockFrame({ asset }: { asset: DesignAssetDTO }) {
  const t = useTranslations('designResult');
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const url = asset.url;

  // ⚠️ WHY A PROBE RATHER THAN `onError` ON THE IFRAME.
  // An iframe does NOT fire `error` for an HTTP error response — the browser
  // simply renders the error body inside the frame — so an `onError` handler
  // would leave the failure state unreachable and the reader staring at a box
  // containing someone else's 404 page. The content route is SAME-ORIGIN
  // (`/api/attachments/<id>/content`), so a `fetch` can read its status; only
  // the 302's destination is cross-origin, which is what keeps the rendered
  // document isolated. `redirect: 'manual'` stops the fetch following that hop:
  // an opaque redirect response is exactly the success signal we want, and it
  // avoids spending the single-use signed URL before the frame asks for it.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // No `setState('loading')` here: the initial state IS 'loading', and the
    // retry handler resets it before bumping `attempt` — so the effect only ever
    // reports an OUTCOME, which is what keeps it out of the set-state-in-effect
    // rule the act environment enforces.
    fetch(url, { method: 'GET', redirect: 'manual' })
      .then((res) => {
        if (cancelled) return;
        // `type: 'opaqueredirect'` (the 302 we expect) reports `ok: false` and
        // `status: 0`, so treat any non-error settlement as reachable and let
        // an explicit 4xx/5xx be the failure.
        setState(res.type === 'opaqueredirect' || res.ok ? 'ready' : 'failed');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [url, attempt]);

  if (!url) return null;

  return (
    <>
      <div className="flex items-center gap-2 rounded-t-(--radius-input) border border-b-0 border-(--el-border) bg-(--el-surface-soft) px-2.5 py-1.5 text-xs text-(--el-text-secondary)">
        <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden />
        <span className="truncate font-mono">{asset.sourcePath}</span>
        <a
          className="ml-auto inline-flex items-center gap-1 text-(--el-link) hover:underline"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('openInNewTab')}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>

      {state === 'failed' ? (
        <div className="flex gap-3.5 rounded-b-(--radius-input) bg-(--el-tint-peach) p-4">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-page-bg)">
            <FileWarning className="h-[18px] w-[18px] text-(--el-text-strong)" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-(--el-text-strong)">{t('frameFailed')}</h3>
            <p className="mt-0.5 mb-3 text-[13px] leading-snug text-(--el-text-strong)">
              {t('frameFailedBody')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setState('loading');
                setAttempt((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : state === 'loading' ? (
        <div
          className={`${FRAME_HEIGHT} flex w-full items-center justify-center rounded-b-(--radius-input) border border-(--el-border) bg-(--el-muted) text-[13px] text-(--el-text-secondary)`}
          role="status"
        >
          {t('frameLoading')}
        </div>
      ) : (
        <iframe
          // Remounts on retry so the browser requests a fresh signed URL.
          key={attempt}
          src={url}
          title={t('frameTitle', { path: basenameOf(asset.sourcePath) })}
          sandbox=""
          className={`${FRAME_HEIGHT} w-full rounded-b-(--radius-input) border border-(--el-border) bg-(--el-page-bg)`}
        />
      )}
    </>
  );
}

export function DesignResultPanel({ evidence, isDesignCard }: DesignResultPanelProps) {
  const t = useTranslations('designResult');
  const [preview, setPreview] = useState<PreviewableAttachment | null>(null);

  // ── Nothing published yet ──────────────────────────────────────────────────
  // The most-seen state for a long while: every design subtask that shipped
  // before this feature has no result. It reads as "this predates the feature",
  // never as an error, and says where a result comes from so nobody hunts for
  // an upload control that does not exist.
  if (!evidence) {
    return (
      <div className="flex gap-3.5 rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) p-4">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-page-bg)">
          <ImageOff className="h-[18px] w-[18px] text-(--el-text-muted)" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-(--el-text)">{t('empty.title')}</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-(--el-text-secondary)">
            {isDesignCard ? t('empty.bodyDesign') : t('empty.body')}
          </p>
        </div>
      </div>
    );
  }

  const mocks = evidence.assets.filter((a) => a.kind === 'mock' && a.url);
  const images = evidence.assets.filter((a) => a.kind === 'image' && a.url);
  const noteFile = evidence.assets.find((a) => a.kind === 'note_file' && a.url);

  return (
    <div>
      {evidence.noteMd ? (
        // The note goes through the SINGLE shipped Markdown renderer — the same
        // one the description and explanation use. `design-notes.md` sections
        // carry wide tables, so `markdown-body`'s table container scrolls
        // horizontally inside the section; the page body never scrolls sideways.
        <div className="markdown-body overflow-x-auto text-sm">
          {renderMarkdown(evidence.noteMd)}
        </div>
      ) : null}

      {evidence.noteTruncated ? (
        <p className="mt-3 flex items-center gap-2 rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) px-3 py-2 text-[13px] text-(--el-text-secondary)">
          {t('noteTruncated')}
          {noteFile?.url ? (
            <a className="text-(--el-link) hover:underline" href={`${noteFile.url}?download=1`}>
              {t('downloadNote')}
            </a>
          ) : null}
        </p>
      ) : null}

      {mocks.map((asset) => (
        <div key={asset.id} className="mt-5">
          <MockFrame asset={asset} />
        </div>
      ))}

      {images.length > 0 ? (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
            {t('screenshots')}
          </p>
          <div className="flex flex-wrap gap-3">
            {images.map((asset) => {
              const previewable = toPreviewable(asset);
              return (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setPreview(previewable)}
                  className="w-44 overflow-hidden rounded-(--radius-input) border border-(--el-border) bg-(--el-surface-soft) text-left"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- the
                      authenticated content route 302s to a signed URL on the
                      object store; next/image cannot optimise an opaque redirect. */}
                  <img
                    src={asset.url!}
                    alt={basenameOf(asset.sourcePath)}
                    className="h-26 w-full object-cover"
                  />
                  <span className="block truncate border-t border-(--el-border-soft) px-2 py-1.5 text-[11px] text-(--el-text-secondary)">
                    {basenameOf(asset.sourcePath)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <Provenance evidence={evidence} />

      <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
