import type { AttachmentDTO } from '@/lib/dto/attachments';

// Client-side download trigger shared by the AttachmentsPanel's card/row
// actions (5.2.5) and the AttachmentPreview lightbox's Download button
// (5.2.6). Attachments are served straight from the blob store (the recorded
// public-unguessable-URL decision), so "download" is the store URL with its
// forced content-disposition switch on a transient anchor click.

/** The blob URL with the store's forced content-disposition switch. */
export function downloadHref(blobUrl: string): string {
  try {
    const url = new URL(blobUrl);
    url.searchParams.set('download', '1');
    return url.toString();
  } catch {
    return blobUrl;
  }
}

export function triggerDownload(attachment: AttachmentDTO): void {
  const anchor = document.createElement('a');
  anchor.href = downloadHref(attachment.blobUrl);
  anchor.download = attachment.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
