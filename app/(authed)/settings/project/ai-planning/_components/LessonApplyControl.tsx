'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CircleAlert, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';
import { NotAppliedBadge } from './LessonBadges';

// THE ONE DECISION THIS SURFACE OFFERS (Subtask MOTIR-3346 · Story MOTIR-3330):
// whether Motir is applying this lesson. Rendered on the list row and on the
// detail, per `design/ai-settings/design-notes.md` §§L4, L6, L9, L11.
//
// ⚠️ THE PAGE-STATE CONTRACT HAS TWO HALVES HERE, AND THEY WANT OPPOSITE
// TREATMENTS. The reflex after a successful write is to refresh everything, and
// that is wrong for exactly one of the two surfaces this mutation touches:
//
//   1. **The acted-on row's OWN state** — the mutation RESPONSE is the
//      confirmation, and it is the lesson in its new shape. Keep it. A
//      `router.refresh()` re-reads through motir-ai, races the write it just
//      made, and flips the badge back in front of the person who clicked —
//      a revert that looks exactly like the action failing when it succeeded.
//   2. **The server-rendered COUNT line** (`{total} lessons · {applied}
//      applied`, rendered by the list page as a Server Component) — nothing but
//      `router.refresh()` reaches it, and without one it sits stale forever
//      saying a retired lesson is still applied.
//
// So this does BOTH: it holds the response locally AND refreshes. Neither alone
// is correct, which is the whole reason the contract enumerates surface kinds
// rather than prescribing one mechanism.
//
// ⚠️ AND IT SENDS NO OVERRIDE VALUE. `Apply again` sits on BOTH not-applied rows
// (§L6: switched off, and aged out) and means opposite writes on them — clear
// the retirement, or exempt the row from the retention clock. Which one is
// decided by motir-ai from the row's own clock (MOTIR-3344), so this control
// posts a boolean and nothing more. Branching here would put a state machine in
// the browser and could reach `exempt` on a row that never aged out.
//
// ⚠️ NO PERMISSION LOGIC. The control renders only where the server already said
// the actor may act (`canManageLessonLibrary`), and the route refuses
// independently. A client that re-derived the rule would drift from the route
// the first time the model changed — and an un-rendered button was never an
// authorization boundary anyway.

/**
 * ⚠️ EVERY FIELD IS A STRING, ALREADY INTERPOLATED — never a function.
 *
 * A function cannot cross the Server → Client component boundary: React throws
 * *"Functions cannot be passed directly to Client Components"* and the whole
 * route 500s. The sibling `LessonRowCopy` DOES carry functions and is fine,
 * because `LessonRow` is a Server Component — so the two look interchangeable
 * and are not.
 *
 * Both interpolations are per-LESSON constants (the takeaway, and the retention
 * window the row was judged against), so resolving them on the server costs
 * nothing and removes the boundary problem entirely. `lessonApplyCopy` takes the
 * lesson for exactly that reason.
 */
export interface LessonApplyCopy {
  stopApplying: string;
  applyAgain: string;
  /** The accessible name, which must be unambiguous out of context (§L11). */
  stopApplyingNamed: string;
  applyAgainNamed: string;
  errorNotFound: string;
  errorForbidden: string;
  errorUnavailable: string;
  errorGeneric: string;
  /** The badge labels, so the island can re-render the row's own state. */
  notApplied: string;
  notRecurred: string;
}

/**
 * Turn the route's typed refusal into a sentence a person can act on.
 *
 * ⚠️ Each arm is its own message, deliberately. Every refusal this route makes
 * is a rule the product CHOSE — a lesson that is not this project's, a
 * permission a role does not hold, an upstream that is not connected — and one
 * generic "something went wrong" for all of them teaches the reader the feature
 * is unreliable while telling them nothing to do next.
 */
function messageFor(status: number, code: unknown, copy: LessonApplyCopy): string {
  if (status === 404 || code === 'NOT_FOUND') return copy.errorNotFound;
  if (status === 403) return copy.errorForbidden;
  if (status === 503) return copy.errorUnavailable;
  return copy.errorGeneric;
}

export function LessonApplyControl({
  lesson,
  projectKey,
  copy,
  /** The detail view's longer label — "Stop applying this lesson" (§L9). */
  retireLabel,
  revealOnHover = false,
  showBadge = true,
  onApplied,
}: {
  lesson: ProjectLessonDTO;
  projectKey: string;
  copy: LessonApplyCopy;
  retireLabel?: string;
  /**
   * Reveal the BUTTON on the row's hover / focus (§L4) — the list only.
   *
   * ⚠️ The BADGE is never hidden by this: it states what the planner is being
   * told, which is not a hover-time fact. And `opacity-0` leaves the button
   * focusable and in the accessibility tree, which is what makes this a visual
   * reveal rather than a mouse-only affordance (§L11). The detail view has no
   * row to hover, so it passes nothing.
   */
  revealOnHover?: boolean;
  /**
   * Whether the badge renders HERE. False on the detail view, where the parent
   * island renders the whole live-state region (callout OR badge) and this is
   * only the button — so one fact is never drawn twice.
   */
  showBadge?: boolean;
  /** Lets a parent hold the new row state too (the detail page's badge). */
  onApplied?: (lesson: ProjectLessonDTO) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // ⚠️ THE ROW'S OWN STATE LIVES HERE, seeded from the server prop and thereafter
  // owned by this island — the BADGE as well as the button. That is surface kind
  // 1 above: the response is the confirmation. Leaving the badge on the server
  // would mean the only way to update it was the `router.refresh()` this rule
  // forbids for the acted-on row.
  //
  // `useState(initialProp)` runs once at mount, so the refresh below re-renders
  // the server row and this island IGNORES the new props — which is the
  // client-island behaviour the contract warns about, and here it is exactly
  // what keeps the row from reverting.
  const [state, setState] = useState(lesson);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applied = state.injectionBlock === null;
  const next = !applied;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/lessons/${encodeURIComponent(lesson.id)}/applied`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ applied: next }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: unknown };
        // ⚠️ Nothing changed server-side, so nothing changes here either. A
        // control that flipped optimistically and then failed silently would
        // leave the row asserting a state the planner does not have.
        setError(messageFor(res.status, body.code, copy));
        return;
      }
      const updated = (await res.json()) as ProjectLessonDTO;
      // (1) The row's own state, from the RESPONSE — never re-read.
      setState(updated);
      onApplied?.(updated);
      // (2) The server-rendered count elsewhere on the page. The ONLY thing
      // `router.refresh()` is for here, and the only thing that reaches it.
      startTransition(() => router.refresh());
    } catch {
      setError(copy.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  const label = applied ? (retireLabel ?? copy.stopApplying) : copy.applyAgain;
  const accessibleName = applied ? copy.stopApplyingNamed : copy.applyAgainNamed;

  return (
    <span className="flex flex-col items-end gap-1.5">
      <span className="flex items-center gap-2">
        {showBadge && state.injectionBlock !== null && (
          <NotAppliedBadge
            block={state.injectionBlock}
            label={state.injectionBlock === 'disabled' ? copy.notApplied : copy.notRecurred}
          />
        )}
        <span
          className={
            revealOnHover
              ? 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'
              : undefined
          }
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="lesson-apply-control"
            data-applied={applied ? 'true' : 'false'}
            aria-label={accessibleName}
            disabled={busy || pending}
            onClick={submit}
          >
            {applied ? (
              <Ban className="size-3.5" aria-hidden />
            ) : (
              <RotateCcw className="size-3.5" aria-hidden />
            )}
            {label}
          </Button>
        </span>
      </span>
      {error && (
        // `role="alert"` rather than a toast: the message belongs beside the
        // control that produced it, and it must reach a screen reader without
        // the reader having gone looking for it.
        <span
          role="alert"
          data-testid="lesson-apply-error"
          className="flex max-w-[32ch] items-start justify-end gap-1.5 text-right text-xs text-(--el-text)"
        >
          {/* ⚠️ THE HUE IS IN THE GLYPH, NOT THE INK. `--el-danger-text` is the
              ink FOR a danger FILL — `#ffffff` in the default light palette — so
              a message painted with it is white on white and invisible. And
              `--el-danger` AS text is 4.25:1 on the dark page, which fails AA.
              A graphic needs only 3:1, so the glyph carries the danger and the
              sentence stays on `--el-text` (17.4:1 in both themes). */}
          <CircleAlert className="mt-px size-3.5 shrink-0 text-(--el-danger)" aria-hidden />
          <span>{error}</span>
        </span>
      )}
    </span>
  );
}
