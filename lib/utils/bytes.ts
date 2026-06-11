// Human-readable file sizes for the attachment surfaces (Story 5.2 ·
// Subtask 5.2.5) — "6 KB" / "860 KB" / "1.2 MB", the grammar the
// `attachments.mock.html` cards and list rows draw. Uploads cap at 10 MB
// (lib/blob/allowlist.ts), so MB is the largest unit a real value reaches;
// the unit labels are locale-stable symbols (like "UTC" in datetime.ts),
// not translated copy.

export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '0 B';
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
