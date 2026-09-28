import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';

// `WorkItem.fixDetail` → its DTO (Story MOTIR-6588 · MOTIR-6600).
//
// The column is JSON, so what comes back from a read is `unknown` to the type system
// however carefully `fixReasonService` wrote it. This is where it is narrowed, once,
// field by field — a missing or mistyped field reads as `null` (or `0` for a count)
// rather than arriving `undefined` in a row that renders it. And it is `null` whenever
// the reason is, whatever the column holds, so a reader can trust the pair.

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

export function toFixDetailDto(
  fixReason: WorkItemFixReasonDto | null,
  raw: unknown,
): FixDetailDto | null {
  if (fixReason === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const d = raw as Record<string, unknown>;
  return {
    repair: d.repair === 'run' ? 'run' : 'fix',
    check: str(d.check),
    queueReason: str(d.queueReason),
    base: str(d.base),
    reviewerName: str(d.reviewerName),
    notePreview: str(d.notePreview),
    gate: d.gate === 'pull_request_approval' || d.gate === 'acceptance_result' ? d.gate : null,
    affected: count(d.affected),
    total: count(d.total),
  };
}
