import { File, FileArchive, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// The MIME-family file-type glyph (Story 5.2 · Subtask 5.2.5), per the
// `attachments.mock.html` glyph map: a lucide glyph whose stroke takes the
// conventional family hue through EXISTING semantic tokens (finding #54 —
// palette colour, no new token):
//
//   application/pdf            → file-text        --el-danger
//   docs / text / markdown     → file-text        --el-info
//   spreadsheets / CSV         → file-spreadsheet --el-success
//   archives (zip)             → file-archive     --el-warning
//   image without a thumbnail  → image            --el-text-secondary
//
// The map is keyed off the `lib/blob/allowlist.ts` MIME families; anything
// outside it can't exist as a row (the upload route 415s), but an unknown
// type still gets a neutral generic-file glyph rather than a crash.

const SHEET_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const DOC_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export function AttachmentGlyph({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === 'application/pdf') {
    return <FileText className={cn('text-(--el-danger)', className)} aria-hidden />;
  }
  if (SHEET_TYPES.has(mimeType)) {
    return <FileSpreadsheet className={cn('text-(--el-success)', className)} aria-hidden />;
  }
  if (mimeType === 'application/zip') {
    return <FileArchive className={cn('text-(--el-warning)', className)} aria-hidden />;
  }
  if (DOC_TYPES.has(mimeType)) {
    return <FileText className={cn('text-(--el-info)', className)} aria-hidden />;
  }
  if (mimeType.startsWith('image/')) {
    return <ImageIcon className={cn('text-(--el-text-secondary)', className)} aria-hidden />;
  }
  return <File className={cn('text-(--el-text-secondary)', className)} aria-hidden />;
}
