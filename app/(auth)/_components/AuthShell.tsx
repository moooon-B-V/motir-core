import { type ReactNode } from 'react';

/**
 * Per-page content block inside the auth column. Renders the big serif
 * headline + optional subhead, then the slotted body (form fields,
 * buttons, footer link). Spacing here is what gives every auth page
 * the same vertical rhythm — keep it here, not on individual pages.
 */
export function AuthShell({
  headline,
  subhead,
  children,
}: {
  headline: string;
  subhead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-(--el-text) sm:text-5xl">
          {headline}
        </h1>
        {subhead ? <p className="text-(--el-text-muted) font-sans text-base">{subhead}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Horizontal "OR" divider used to separate the Google button from the
 * email form on sign-in / sign-up. Matches mockups 01 + 03.
 */
export function OrDivider() {
  return (
    <div
      className="flex items-center gap-4"
      role="separator"
      aria-orientation="horizontal"
      aria-label="or"
    >
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
      <span className="text-(--el-text-muted) font-sans text-xs uppercase tracking-wider">OR</span>
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
    </div>
  );
}

/**
 * Top-of-form inline error banner — used for OAuth errors and other
 * page-scoped failures that aren't tied to a single field. Mockup 06
 * shows the styling.
 */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 rounded-(--radius-input) px-(--spacing-input-x) py-(--spacing-sm) font-sans text-sm"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--el-danger) 12%, transparent)',
        color: 'var(--el-danger)',
      }}
    >
      <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-12a1 1 0 00-1 1v3a1 1 0 102 0V7a1 1 0 00-1-1zm0 8a1 1 0 100-2 1 1 0 000 2z"
          />
        </svg>
      </span>
      <span>{children}</span>
    </div>
  );
}
