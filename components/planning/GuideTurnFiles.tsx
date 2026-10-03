'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, FileUp, TriangleAlert, X } from 'lucide-react';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import { uploadFailureMessage } from '@/lib/blob/uploadClient';
import type { GuideFileRefusal, GuideQueuedFile } from '@/lib/hooks/useGuideTurnFiles';
import { formatBytes } from '@/lib/utils/bytes';
import { AttachmentGlyph } from '@/app/(authed)/items/[key]/_components/AttachmentGlyph';
import {
  AttachmentPreview,
  isPreviewable,
} from '@/app/(authed)/items/[key]/_components/AttachmentPreview';
import { triggerDownload } from '@/app/(authed)/items/[key]/_components/attachmentDownload';

// FILES ON A GUIDE TURN, as the rail draws them (Story MOTIR-7471 · MOTIR-7486;
// design MOTIR-7482 `planning-workspace--guide-files.mock.html`). Every element
// is the item page's attachment grammar shrunk to a chip — `AttachmentGlyph`,
// the upload track, the rose refusal row, the shipped preview — so nothing here
// is a new visual language:
//
//   * GuideFileTray     — the queued files above the field (panels 2, 4, 5, 6);
//   * GuideFileRefusals — the item page's inline refusal row (panel 7);
//   * GuideFilesNotSent — the line a failed upload leaves (panel 6);
//   * GuideSentFiles    — a sent turn's chips under its bubble (panel 8);
//   * GuideDropOverlay  — the rail as a drop target (panel 3).

const CHIP =
  'relative inline-flex max-w-full items-center gap-2 rounded-(--radius-control) border text-xs';
const CHIP_PAD = 'px-(--spacing-control-x) py-(--spacing-control-y)';
const META = 'font-mono text-[10px] text-(--el-text-secondary)';

/** The file's type as its chip names it: PNG, Markdown, Text, PDF, File. */
function useTypeLabel() {
  const tf = useTranslations('planningWorkspace.guide.files');
  return (mime: string): string => {
    const base = mime.split(';')[0]!.trim().toLowerCase();
    if (base.startsWith('image/') || base === 'application/pdf') {
      return base.split('/')[1]!.replace(/\+.*$/, '').toUpperCase();
    }
    if (base === 'text/markdown') return tf('typeMarkdown');
    if (base.startsWith('text/')) return tf('typeText');
    return tf('typeFile');
  };
}

// A local object URL or the authenticated content path; next/image optimises
// neither (the item page's strip view draws its thumbnails the same way).
function Thumb({ src }: { src: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-[38px] w-[52px] flex-none rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-page-bg) object-cover"
    />
  );
}

export function GuideFileTray({
  files,
  cardKey,
  uploading,
  onRemove,
  onRetry,
}: {
  files: readonly GuideQueuedFile[];
  cardKey: string;
  uploading: boolean;
  onRemove: (key: number) => void;
  onRetry: () => void;
}) {
  const tf = useTranslations('planningWorkspace.guide.files');
  const typeLabel = useTypeLabel();
  if (files.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={tf('trayAria')}
      data-testid="guide-file-tray"
      className="mb-2 flex flex-wrap gap-1.5"
    >
      {files.map((file) => {
        const failed = file.status === 'failed';
        const meta =
          file.status === 'uploading'
            ? file.pct === null
              ? tf('uploading')
              : tf('uploadingPct', { pct: file.pct })
            : file.status === 'done'
              ? tf('onCard', { key: cardKey })
              : file.status === 'waiting' && uploading
                ? tf('waiting')
                : `${typeLabel(file.mime)} · ${formatBytes(file.sizeBytes)}`;
        return (
          <span
            key={file.key}
            data-testid="guide-file-chip"
            data-status={file.status}
            className={`${CHIP} ${file.previewUrl ? 'py-1 pr-2 pl-1' : CHIP_PAD} border-(--el-border) ${
              failed
                ? 'bg-(--el-tint-rose) text-(--el-text-strong)'
                : 'bg-(--el-card) text-(--el-text)'
            }`}
          >
            {file.previewUrl ? (
              <Thumb src={file.previewUrl} />
            ) : (
              <span
                className={`inline-flex flex-none ${failed ? 'text-(--el-text-strong)' : 'text-(--el-text-secondary)'}`}
              >
                <AttachmentGlyph mimeType={file.mime} className="size-4" />
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="max-w-[150px] truncate font-medium" title={file.name}>
                {file.name}
              </span>
              {file.status === 'uploading' ? (
                <span
                  className="relative block h-1 w-24 overflow-hidden rounded-full bg-(--el-muted)"
                  aria-hidden="true"
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-(--el-accent)"
                    style={{ width: `${file.pct ?? 30}%` }}
                  />
                </span>
              ) : null}
              {failed ? (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={uploading}
                  data-testid="guide-file-retry"
                  className="self-start rounded-(--radius-control) text-[11px] font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  {tf('retry')}
                </button>
              ) : (
                <span className={`${META} inline-flex items-center gap-1`}>
                  {file.status === 'done' ? (
                    <Check className="size-3 text-(--el-success)" aria-hidden="true" />
                  ) : null}
                  {meta}
                </span>
              )}
            </span>
            {file.status === 'uploading' || uploading ? null : (
              <button
                type="button"
                onClick={() => onRemove(file.key)}
                aria-label={tf('removeAria', { name: file.name })}
                className="inline-flex flex-none rounded-(--radius-control) p-0.5 text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** The item page's inline refusal row, unchanged in grammar (panel 7). */
export function GuideFileRefusals({
  refusals,
  onDismiss,
}: {
  refusals: readonly GuideFileRefusal[];
  onDismiss: (key: number) => void;
}) {
  const tf = useTranslations('planningWorkspace.guide.files');
  const tErrors = useTranslations('errors');
  const ta = useTranslations('attachments');
  if (refusals.length === 0) return null;
  return (
    <div role="alert" className="mb-2 flex flex-col gap-1.5" data-testid="guide-file-refusals">
      {refusals.map((refusal) => (
        <div
          key={refusal.key}
          data-testid="guide-file-refusal"
          className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs leading-relaxed text-(--el-text-strong)"
        >
          <TriangleAlert
            className="mt-px size-3.5 shrink-0 text-(--el-danger-on-surface)"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="font-semibold">{refusal.name}</span> —{' '}
            {refusal.code === 'CAP'
              ? tf('cap')
              : uploadFailureMessage(tErrors, {
                  ...(refusal.code ? { code: refusal.code } : {}),
                  ...(refusal.entitlement ? { entitlement: refusal.entitlement } : {}),
                })}
          </span>
          <button
            type="button"
            onClick={() => onDismiss(refusal.key)}
            aria-label={ta('dismissErrorAria', { name: refusal.name })}
            className="ml-auto shrink-0 rounded-(--radius-control) p-0.5 text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The turn was not sent because a file did not upload (panel 6) — the
 *  composer's awaiting-answer strip, in its warning tint. */
export function GuideFilesNotSent({ cardKey }: { cardKey: string }) {
  const tf = useTranslations('planningWorkspace.guide.files');
  return (
    <p
      role="status"
      data-testid="guide-files-not-sent"
      className="mb-2 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2 text-xs text-(--el-warning-text)"
    >
      {tf.rich('notSent', {
        key: cardKey,
        b: (chunks) => <span className="font-semibold">{chunks}</span>,
      })}
    </p>
  );
}

/**
 * A sent turn's files (panel 8): under the user bubble, right-aligned, never
 * inside the accent bubble. An image or PDF opens the shipped preview; any other
 * file downloads — the item page's activation split (5.2.6). A file removed from
 * the card since is a dashed *Removed* chip that opens nothing.
 */
export function GuideSentFiles({
  attachmentIds,
  attachments,
}: {
  attachmentIds: readonly string[];
  attachments: Readonly<Record<string, AttachmentDTO>>;
}) {
  const tf = useTranslations('planningWorkspace.guide.files');
  const ta = useTranslations('attachments');
  const typeLabel = useTypeLabel();
  const [preview, setPreview] = useState<AttachmentDTO | null>(null);
  if (attachmentIds.length === 0) return null;
  return (
    <div className="-mt-1.5 flex flex-wrap justify-end gap-1.5 pr-9" data-testid="guide-turn-files">
      {attachmentIds.map((id) => {
        const attachment = attachments[id];
        if (!attachment) {
          return (
            <span
              key={id}
              data-testid="guide-turn-file-removed"
              className={`${CHIP} ${CHIP_PAD} border-dashed border-(--el-border) bg-transparent text-(--el-text-secondary)`}
            >
              {tf('removed')}
            </span>
          );
        }
        return (
          <button
            key={id}
            type="button"
            data-testid="guide-turn-file"
            {...(isPreviewable(attachment)
              ? { 'aria-label': ta('previewAria', { name: attachment.filename }) }
              : {})}
            onClick={() =>
              isPreviewable(attachment) ? setPreview(attachment) : triggerDownload(attachment)
            }
            className={`${CHIP} ${attachment.isImage ? 'py-1 pr-2 pl-1' : CHIP_PAD} border-(--el-border) bg-(--el-card) text-left text-(--el-text) hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
          >
            {attachment.isImage ? (
              <Thumb src={attachment.blobUrl} />
            ) : (
              <span className="inline-flex flex-none text-(--el-text-secondary)">
                <AttachmentGlyph mimeType={attachment.mimeType} className="size-4" />
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="max-w-[150px] truncate font-medium">{attachment.filename}</span>
              <span className={META}>
                {typeLabel(attachment.mimeType)} · {formatBytes(attachment.sizeBytes)}
              </span>
            </span>
          </button>
        );
      })}
      <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

/** The rail as a drop target (panel 3) — the shipped dropzone grammar.
 *  Decorative: the attach control is the accessible way in. */
export function GuideDropOverlay({ cardKey }: { cardKey: string }) {
  const tf = useTranslations('planningWorkspace.guide.files');
  return (
    <div
      aria-hidden="true"
      data-testid="guide-drop-overlay"
      className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-1.5 rounded-(--radius-card) border-2 border-dashed border-(--el-accent) bg-(--el-droptarget-bg) px-6 text-center"
    >
      <FileUp className="size-6 text-(--el-accent-on-surface)" aria-hidden="true" />
      <p className="text-sm font-semibold text-(--el-text-strong)">{tf('dropTitle')}</p>
      <p className="text-xs text-(--el-text-secondary)">{tf('dropSub', { key: cardKey })}</p>
    </div>
  );
}
