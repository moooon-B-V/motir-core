import { type ReactNode } from 'react';

/**
 * Shared frame for the auth pages (sign-in, sign-up, reset-password,
 * reset-password/[token]). A white card centered on a tinted page
 * background — see design/auth/* for the original Story-1.1 mockups
 * and the v1.1.10 update note in MOTIR.md.
 *
 * Wordmark is intentionally absent. In a real Motir-planned project,
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
 *
 * ONE page in this group is wider, and it says so from the inside:
 * `/device`'s confirm screen (Subtask MOTIR-1867) renders a two-column
 * detail block at 40rem, because `design/cli-connect/design-notes.md`
 * MEASURED the single-column 28rem version at 1106px tall — overflowing
 * every laptop, which puts Approve below the fold and lets the reader
 * scroll PAST the four facts the screen exists to make them read. The
 * `has-[…]` variant is how a descendant widens an ancestor it cannot
 * otherwise reach; every other page renders no `data-auth-wide` and is
 * byte-identical to before.
 *
 * The wide state also tightens the page's and the card's own vertical
 * padding (py-12 → py-8, py-10 → py-5, the mock's figure). That is the
 * cheapest 36px in the fold budget: it is whitespace AROUND the content,
 * so nothing the reader has to read gets compressed to buy it. Measured
 * in Chromium at 1366×648 after the change — card 558px, page 622px,
 * both CTAs ending at 590px, no scroll.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center overflow-x-clip bg-(--el-auth-wash) px-6 py-12 has-[[data-auth-wide]]:py-8 sm:px-10">
      <main className="w-full max-w-[28rem] has-[[data-auth-wide]]:max-w-[40rem]">
        <div className="rounded-(--radius-card) bg-(--el-page-bg) px-6 py-10 shadow-(--shadow-elevated) sm:px-10 has-[[data-auth-wide]]:py-5 sm:has-[[data-auth-wide]]:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}
