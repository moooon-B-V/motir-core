import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { type ReactNode } from 'react';
import { BrandMark } from '@/components/brand/BrandMark';

/**
 * Shared frame for the auth pages (sign-in, sign-up, reset-password,
 * reset-password/[token]). A white card centered on a tinted page
 * background — see design/auth/* for the original Story-1.1 mockups
 * and the v1.1.10 update note in MOTIR.md.
 *
 * THE WORDMARK IS NO LONGER ABSENT. The deferral this docstring used to record
 * is closed by MOTIR-1150: the horizontal lockup at 28px, top-left of the card,
 * `design/brand/design-notes.md` §7b. It lives HERE rather than on each page so
 * all five auth screens inherit it from one place.
 *
 * ⚠️ WITH ONE EXCEPTION — `/device`, and it is a MEASUREMENT, not a taste call.
 * That screen's confirm step is the product's one auth-time DECISION screen, and
 * its fold budget is measured: `design/cli-connect/design-notes.md` recorded the
 * single-column form at 1106px (which is why `AuthShell`'s `tight` mode and this
 * layout's `data-auth-wide` widening exist at all), and the wide rebuild landed
 * at a 622px page inside a 1366×648 viewport — 26px of headroom, all of it.
 *
 * So the question this card had to answer was how tall the new row actually is.
 * Measured in Chromium at 1366×648 against `design/brand/brand-mark.mock.html`
 * (which inlines the real Tailwind output and the real theme.css, so the numbers
 * are the shipped ones): the 28px lockup renders 28px tall and the mark-only
 * form 24px. Both then pay this column's `gap-8` on top — 60px and 56px — which
 * puts the page at 682px or 678px against a 648px viewport and pushes
 * Approve/Deny below the fold. That is precisely the failure the wide rebuild
 * bought back, on the one screen where the reader must SEE what they are
 * approving. Neither of §7b's two options fits, so the third thing it allows is
 * what ships: the lockup is SUPPRESSED on the wide screen. Every other auth
 * screen keeps it.
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
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('auth');
  return (
    <div className="flex min-h-screen w-full items-center justify-center overflow-x-clip bg-(--el-auth-wash) px-6 py-12 has-[[data-auth-wide]]:py-8 sm:px-10">
      <main className="w-full max-w-[28rem] has-[[data-auth-wide]]:max-w-[40rem]">
        {/* The card is the brand row's column: `gap-8` matches the rhythm
            `AuthShell` already sets inside itself, so the lockup reads as the
            first item of one stack rather than a header bolted on top.
            `display:none` (not `invisible`) is what removes the gap too, so the
            wide screen is byte-identical to what it measured at. The variant is
            written as ONE arbitrary selector rather than a stacked
            `has-…:[&_…]` pair so what it compiles to is not in doubt. */}
        <div className="flex flex-col gap-8 rounded-(--radius-card) bg-(--el-page-bg) px-6 py-10 shadow-(--shadow-elevated) [&:has([data-auth-wide])_[data-brand-lockup]]:hidden sm:px-10 has-[[data-auth-wide]]:py-5 sm:has-[[data-auth-wide]]:px-8">
          {/* Decorative glyph + visible wordmark, so the link takes its name
              from the text and carries NO `aria-label` — §8's "never both". */}
          <Link href="/" data-brand-lockup className="self-start">
            <BrandMark size={28} label={t('brand')} />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
