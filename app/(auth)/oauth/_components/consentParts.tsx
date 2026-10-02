import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { AuthShell } from '../../_components/AuthShell';

// The consent screen's grammar (Story MOTIR-6973 · Subtask MOTIR-6985). The
// design composes these from `/device`'s approval screen — the detail box, the
// tinted callouts, the terminal-state frame — so they are the same markup and
// tokens as `app/(auth)/device/_components/DeviceApproval.tsx`, named here so the
// consent states read alike. None is a design-system primitive in waiting.

/** A terminal screen: headline, subhead, body, a closing line. Announced through
 *  a live region so a screen reader hears the RESULT without re-reading the card. */
export function TerminalState({
  headline,
  subhead,
  foot,
  children,
}: {
  headline: string;
  subhead: string;
  foot: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite">
      <AuthShell headline={headline} subhead={subhead}>
        <div className="flex flex-col gap-5">{children}</div>
        <p className="text-(--el-text-muted) font-sans text-xs leading-relaxed">{foot}</p>
      </AuthShell>
    </div>
  );
}

/** One COLUMN of the detail box (`.dcol`); `divided` draws the column hairline —
 *  on top when the box is one column (a phone, and the consent card's 22rem pane
 *  at `lg`, MOTIR-7379), on the left when it is two (`sm` to `lg`). */
export function DetailColumn({
  divided = false,
  children,
}: {
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col divide-y divide-(--el-border-soft) px-4',
        divided &&
          'border-t border-(--el-border-soft) sm:border-t-0 sm:border-l lg:border-t lg:border-l-0',
      )}
    >
      {children}
    </div>
  );
}

/** One key → value → sub-line block (`.dblock`). The key carries meaning, so it
 *  is `--el-text-muted` (4.54:1 on the white card), never the decorative faint. */
export function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-2.5">
      <span className="text-(--el-text-muted) font-sans text-[11px] font-semibold uppercase tracking-wider">
        {label}
      </span>
      {children}
    </div>
  );
}

export function DetailSub({ children }: { children: ReactNode }) {
  return (
    <span className="text-(--el-text-muted) font-sans text-xs leading-relaxed break-words">
      {children}
    </span>
  );
}

/** A tinted callout — hue in the BACKGROUND with its surface ink on top, always
 *  glyph + words so the state is never carried by colour alone. */
export function Callout({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'success' | 'danger';
  icon: ReactNode;
  children: ReactNode;
}) {
  const surface = {
    warn: 'bg-(--el-warning-surface) text-(--el-warning-text)',
    success: 'bg-(--el-success-surface) text-(--el-text-strong)',
    danger: 'bg-(--el-danger-surface) text-(--el-danger-surface-text)',
  }[tone];
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-2.5 font-sans text-sm leading-normal',
        surface,
      )}
    >
      <span className="inline-flex shrink-0 pt-0.5">{icon}</span>
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}

/** A failure that is NOT a state change — the reader stays and can act on it. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-(--radius-card) bg-(--el-danger-surface) p-(--spacing-card-padding) font-sans text-sm leading-relaxed text-(--el-danger-surface-text)"
    >
      {children}
    </div>
  );
}

/** Bold emphasis inside rich copy — the value the sentence is about. */
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}
