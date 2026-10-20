'use client';

import { X } from 'lucide-react';

/** The exit control's recipe — one string, so a sibling link in the same bar
 *  (the approval overlay's *Open work item*) can wear the identical control. */
export const OVERLAY_EXIT_CONTROL =
  'inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

/**
 * THE OVERLAY EXIT — `✕ Close  Esc`, drawn top left of a full-screen overlay.
 *
 * Extracted from the three copies the planning workspace, the guide workspace and
 * the approval overlay each carried, so the run overlay (MOTIR-8982) draws the
 * same control rather than a fourth. The caller owns both strings, because the
 * label and the key name come from its own message namespace.
 *
 * `escHint="md"` hides the `Esc` chip below the `md` breakpoint, where there is no
 * keyboard to speak of (the approval overlay's narrow panel); the default shows it
 * always. `data-testid="overlay-exit"` is the marker specs target.
 */
export function OverlayExitButton({
  onClose,
  label,
  escLabel,
  escHint = 'always',
}: {
  onClose: () => void;
  label: string;
  escLabel: string;
  escHint?: 'always' | 'md';
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      data-testid="overlay-exit"
      className={OVERLAY_EXIT_CONTROL}
    >
      <X className="h-4 w-4 shrink-0" aria-hidden />
      {label}
      <kbd
        className={`ml-1 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-secondary)${escHint === 'md' ? ' hidden md:inline' : ''}`}
      >
        {escLabel}
      </kbd>
    </button>
  );
}
