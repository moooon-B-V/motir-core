// Client-side download trigger shared by the AttachmentsPanel's card/row
// actions (5.2.5) and the AttachmentPreview lightbox's Download button
// (5.2.6). Content attachments are served through the authenticated content
// path (MOTIR-1665); "download" adds the `?download=1` switch the content route
// honours (it presigns with the store's content-disposition), on a transient
// anchor click.

/** The content path with the `?download=1` content-disposition switch. */
export function downloadHref(contentUrl: string): string {
  const sep = contentUrl.includes('?') ? '&' : '?';
  return `${contentUrl}${sep}download=1`;
}

/**
 * Only the two fields a download needs. Narrower than `AttachmentDTO`, which
 * satisfies it structurally — so every existing caller is unchanged, and the
 * design-result panel's published `.png` (whose attachment source the panel DTO
 * deliberately does not admit) can reuse the same download (MOTIR-2670).
 */
export function triggerDownload(attachment: { blobUrl: string; filename: string }): void {
  const anchor = document.createElement('a');
  anchor.href = downloadHref(attachment.blobUrl);
  anchor.download = attachment.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
