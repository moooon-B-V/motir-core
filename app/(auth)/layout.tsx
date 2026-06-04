import { type ReactNode } from 'react';

/**
 * Shared frame for the auth pages (sign-in, sign-up, reset-password,
 * reset-password/[token]). A white card centered on a tinted page
 * background — see design/auth/* for the original Story-1.1 mockups
 * and the v1.1.10 update note in PRODECT.md.
 *
 * Wordmark is intentionally absent. In a real Prodect-planned project,
 * the brand mark (wordmark + logomark) is scheduled as a late-Epic-4
 * Subtask (agent or human task) once the product has enough surface
 * for the brand decision to be informed. Until then we ship without
 * placeholder branding rather than letting a filler "P" tile become
 * load-bearing across every auth screen.
 *
 * Width pinned to a literal value rather than `max-w-md`: the design
 * system's @theme block defines a custom `--spacing-md` (= 16px)
 * which Tailwind v4 resolves into the default `max-w-md` utility —
 * leaving the column 16px wide. Pinning the card width here keeps
 * the design-system token set un-touched and the layout predictable.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center overflow-x-clip bg-(--el-surface) px-6 py-12 sm:px-10">
      <main className="w-full max-w-[28rem]">
        <div className="rounded-(--radius-card) bg-(--el-page-bg) px-6 py-10 shadow-(--shadow-elevated) sm:px-10">
          {children}
        </div>
      </main>
    </div>
  );
}
