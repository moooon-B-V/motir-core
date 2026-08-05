import { Pill } from '@/components/ui/Pill';
import type { V1Status } from '@/lib/api/v1/openapi/statuses';

// The HTTP-method and status chips (Story 11.4 · Subtask 11.4.7 — MOTIR-2188;
// design `design/api-docs/design-notes.md` § "The HTTP method chip").
//
// Both compose the SHIPPED `Pill` primitive and its `severity` axis rather than
// hand-rolling a chip, because that axis already renders exactly the four tint
// slots the design specifies — sky / mint / peach / rose — with the hue in the
// BACKGROUND and `--el-text-strong` ink, which is the AA recipe every coloured
// chip in this codebase follows (finding #35).
//
// The mapping is stated here because it is a mapping and not an identity:

/** Verb → the `severity` tone whose tint the design specifies for it. */
const METHOD_SEVERITY = {
  // sky — a read, the quiet one.
  GET: 'info',
  // mint — a create; the same tint `status="done"` uses for a good outcome.
  POST: 'success',
  // peach — a partial write, the one to read twice before running.
  PATCH: 'warning',
  // rose — the destructive verb. Here `danger` is not a stretch: DELETE is the
  // one method on this surface that removes something.
  DELETE: 'danger',
} as const satisfies Record<string, 'info' | 'success' | 'warning' | 'danger'>;

/** Status CLASS → tone. Three colours, not eleven — the design's rule. */
function statusSeverity(status: V1Status): 'success' | 'warning' | 'danger' {
  if (status < 300) return 'success';
  if (status < 500) return 'warning';
  return 'danger';
}

/** An HTTP verb, as the catalogue and the operation head render it. */
export function MethodPill({ method }: { method: string }) {
  const severity = METHOD_SEVERITY[method as keyof typeof METHOD_SEVERITY] ?? 'info';
  return (
    <Pill
      severity={severity}
      className="min-w-[52px] justify-center font-mono text-[10.5px] font-bold tracking-wide"
    >
      {/* DELETE is abbreviated so every verb fits one chip width; the full verb
          stays in the accessible name so a screen reader is not given a
          truncation. */}
      <span aria-hidden>{method === 'DELETE' ? 'DEL' : method}</span>
      <span className="sr-only">{method}</span>
    </Pill>
  );
}

/** An HTTP status, in the response table. */
export function StatusPill({ status }: { status: V1Status }) {
  return (
    <Pill
      severity={statusSeverity(status)}
      className="min-w-[42px] justify-center font-mono text-[11px] font-bold"
    >
      {status}
    </Pill>
  );
}

/**
 * The scope an operation requires.
 *
 * ⚠️ A DELIBERATE DEVIATION from the design, recorded in
 * `design/api-docs/design-notes.md`: the asset specifies `--el-tint-lavender`
 * so a scope reads as a different KIND of fact from a verb. The shipped `Pill`
 * has no lavender tone that is not already semantically claimed
 * (`status="planned"`, `tone="private"`), and adding one is a
 * `packages/design-system` change outside this card's boundary. `tone="neutral"`
 * is still distinct from all four verb tints — the property the lavender was
 * for — and the monospace face carries the rest of the distinction.
 */
export function ScopePill({ scope }: { scope: string }) {
  return (
    <Pill tone="neutral" className="font-mono text-[11px]">
      {scope}
    </Pill>
  );
}
