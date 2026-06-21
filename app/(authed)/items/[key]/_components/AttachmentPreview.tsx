'use client';

import { useTranslations } from 'next-intl';
import { Download, FileText, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import { formatBytes } from '@/lib/utils/bytes';
import { downloadHref, triggerDownload } from './attachmentDownload';

// The preview lightbox (Story 5.2 · Subtask 5.2.6) —
// `design/work-items/attachments.mock.html` panel 6 is the layout authority:
//
//   * a full-screen `Modal` (the new `full` size, the 2.5.19 growth pattern)
//     over ONE focused attachment; the backdrop deepens to `bg-black/80`;
//   * header bar (white-on-scrim): filename + size · a Download button · the
//     close ×, floated over the stage on a fading top gradient;
//   * images render contain-fit, centered on the scrim, carrying the filename
//     as alt; PDFs render in an embedded `<object>` frame over the blob URL
//     with the can't-inline fallback message + Download;
//   * non-previewable types NEVER open it — the 5.2.5 card/row activation
//     downloads instead (the DTO's `isImage`/`isPdf` split, `isPreviewable`
//     below); NO prev/next navigation (unverified in the mirror, documented
//     out in the 5.2.4 design notes);
//   * a11y — the full Modal contract: Radix focus-traps the dialog, Esc
//     closes, focus returns to the opening card; the dialog is labelled by
//     the filename (`srTitle`); preview state is conveyed as header text
//     (name + size), not imagery alone.
//
// Colour note: the header renders literal white on the theme-INVARIANT black
// scrim — the mockup hardcodes #fff deliberately (the scrim is bg-black/80 in
// light AND dark, so an `--el-*` token would wrongly flip with the theme).
// Shape still flows through the element tokens.

/** The Jira-verified preview split: images + PDFs preview, the rest download. */
export function isPreviewable(attachment: AttachmentDTO): boolean {
  return attachment.isImage || attachment.isPdf;
}

export function AttachmentPreview({
  attachment,
  onClose,
}: {
  /** The focused attachment, or null while the lightbox is closed. */
  attachment: AttachmentDTO | null;
  onClose: () => void;
}) {
  const t = useTranslations('attachments');

  if (!attachment) return null;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="full"
      hideClose
      srTitle={attachment.filename}
      overlayClassName="bg-black/80"
      className="rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {/* The stage fills the viewport behind the floating header. */}
      <div className="absolute inset-0 flex items-center justify-center px-8 pt-[52px] pb-6">
        {attachment.isImage ? (
          /* eslint-disable-next-line @next/next/no-img-element -- the blob
             store's host isn't in next/image's remotePatterns, and a
             full-screen contain-fit of a user upload gains nothing from the
             optimizer; the design mandates the filename as alt. */
          <img
            src={attachment.blobUrl}
            alt={attachment.filename}
            className="max-h-full max-w-full rounded-(--radius-control) object-contain"
          />
        ) : (
          <object
            data={attachment.blobUrl}
            type="application/pdf"
            aria-label={attachment.filename}
            className="h-full w-full max-w-[60rem] rounded-(--radius-control)"
          >
            {/* Rendered only when the browser can't inline PDFs. */}
            <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center text-white">
              <FileText className="h-7 w-7 opacity-80" aria-hidden />
              <p className="max-w-[36ch] font-sans text-[13px] opacity-85">{t('pdfFallback')}</p>
              <a
                href={downloadHref(attachment.blobUrl)}
                download={attachment.filename}
                className="inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) border border-white/35 bg-white/10 px-(--spacing-control-x) font-sans text-xs font-medium text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                {t('previewDownload')}
              </a>
            </div>
          </object>
        )}
      </div>

      {/* Header bar — white-on-scrim over a fading top gradient (panel 6). */}
      <div className="relative z-[2] flex shrink-0 items-center gap-2.5 bg-gradient-to-b from-black/55 to-transparent px-3.5 py-2.5 text-white">
        <span className="truncate font-sans text-[13px] font-semibold" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="shrink-0 font-sans text-xs opacity-75">
          {formatBytes(attachment.sizeBytes)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => triggerDownload(attachment)}
            className="inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) border border-white/35 bg-white/10 px-(--spacing-control-x) font-sans text-xs font-medium text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t('previewDownload')}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closePreviewAria')}
            className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </Modal>
  );
}
