import Link from 'next/link';
import {
  ArrowRight,
  ChevronDown,
  ListChecks,
  Network,
  Palette,
  Search,
  Shapes,
  Shield,
  Sparkles,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { submitIdeaAction } from '@/app/_actions/frontDoor';
import { MAX_PENDING_IDEA_LENGTH } from '@/lib/onboarding/pendingIdea';

// The public front door (Subtask 7.3.14 — design Surfaces 1 + 2).
//
// Surface 1 — the cloud marketing landing + hero prompt (design screen B): a
// Replit-style top nav (cloud-only chrome) + a hero where the visitor types their
// idea, over a preview of what happens next (the 3 mandatory steps + a disclosure
// of the optional ones). Surface 2 — the login gate + idea preservation — lives in
// the hero form's server action (`submitIdeaAction`): a logged-out submit preserves
// the typed idea and raises the `(auth)` flow; see `lib/onboarding/pendingIdea.ts`.
//
// Only `--el-*` colour + element-semantic shape tokens; the hero reaches the
// planner ONLY through the 7.3.4 chat route (driven later by 7.3.5) — nothing here
// imports `motir-ai` (the open-core invariant).
export async function PublicFrontDoor() {
  const t = await getTranslations('onboarding');

  const steps = [
    {
      Icon: Search,
      tint: 'bg-(--el-tint-sky)',
      title: t('landing.steps.understandTitle'),
      desc: t('landing.steps.understandDesc'),
    },
    {
      Icon: Shapes,
      tint: 'bg-(--el-tint-lavender)',
      title: t('landing.steps.scopeTitle'),
      desc: t('landing.steps.scopeDesc'),
    },
    {
      Icon: Network,
      tint: 'bg-(--el-tint-rose)',
      title: t('landing.steps.planTitle'),
      desc: t('landing.steps.planDesc'),
    },
  ];
  const optionalSteps = [
    {
      Icon: Shield,
      tint: 'bg-(--el-tint-mint)',
      title: t('landing.optional.worthTitle'),
      desc: t('landing.optional.worthDesc'),
      tag: t('landing.optional.optionalTag'),
    },
    {
      Icon: ListChecks,
      tint: 'bg-(--el-tint-mint)',
      title: t('landing.optional.demandTitle'),
      desc: t('landing.optional.demandDesc'),
      tag: t('landing.optional.optionalTag'),
    },
    {
      Icon: Palette,
      tint: 'bg-(--el-tint-peach)',
      title: t('landing.optional.designTitle'),
      desc: t('landing.optional.designDesc'),
      tag: t('landing.optional.webOnlyTag'),
    },
  ];

  return (
    <main className="min-h-screen bg-(--el-page-bg) text-(--el-text)">
      {/* ── Top nav — cloud-only marketing chrome ───────────────────────── */}
      <nav
        aria-label={t('nav.product')}
        className="flex items-center gap-4 border-b border-(--el-border) px-6 py-4 sm:px-10"
      >
        <Link href="/" className="flex items-center gap-2 font-sans text-base font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          Motir
        </Link>
        <div className="hidden flex-1 items-center justify-center gap-6 text-sm text-(--el-text-secondary) sm:flex">
          <Link href="/" className="hover:text-(--el-text)">
            {t('nav.product')}
          </Link>
          <Link href="/" className="hover:text-(--el-text)">
            {t('nav.pricing')}
          </Link>
          <Link href="/" className="hover:text-(--el-text)">
            {t('nav.docs')}
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <Link href="/sign-in" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('nav.logIn')}
          </Link>
          <Link href="/sign-up" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            {t('nav.signUp')}
          </Link>
        </div>
      </nav>

      {/* ── Hero — capture the idea ─────────────────────────────────────── */}
      <section className="mx-auto max-w-[45rem] px-6 pb-4 pt-12 text-center sm:pt-16">
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {t('landing.badge')}
        </span>
        <h1 className="font-serif text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          {t('landing.headline')}
        </h1>
        <p className="mx-auto mt-3 max-w-[58ch] text-sm leading-relaxed text-(--el-text-secondary) sm:text-base">
          {t('landing.subhead')}
        </p>

        <Card className="mt-7 bg-(--el-surface) text-left shadow-(--shadow-card)">
          <form action={submitIdeaAction} className="flex flex-col gap-2">
            <label htmlFor="hero-idea" className="sr-only">
              {t('landing.ideaLabel')}
            </label>
            <textarea
              id="hero-idea"
              name="idea"
              rows={2}
              maxLength={MAX_PENDING_IDEA_LENGTH}
              placeholder={t('landing.heroPlaceholder')}
              className="w-full resize-none rounded-(--radius-input) bg-transparent px-(--spacing-input-x) py-(--spacing-input-y) text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            />
            <div className="flex items-center gap-3">
              <span className="text-xs text-(--el-text-muted)">{t('landing.heroHint')}</span>
              <span className="flex-1" />
              <Button
                type="submit"
                variant="primary"
                rightIcon={<ArrowRight className="h-4 w-4" aria-hidden />}
              >
                {t('landing.startPlanning')}
              </Button>
            </div>
          </form>
        </Card>
      </section>

      {/* ── Workflow preview — what happens after you submit ────────────── */}
      <section className="mx-auto max-w-[58rem] px-6 pb-16">
        <p className="mb-4 text-center font-mono text-xs uppercase tracking-wide text-(--el-text-faint)">
          {t('landing.previewCaption')}
        </p>
        <ol className="grid gap-3 sm:grid-cols-3">
          {steps.map(({ Icon, tint, title, desc }, i) => (
            <li key={title}>
              <Card className="h-full bg-(--el-surface)">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-(--radius-control) ${tint} text-(--el-text-strong)`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="font-mono text-xs text-(--el-text-faint)">{i + 1}</span>
                </div>
                <h2 className="mt-3 text-sm font-semibold text-(--el-text)">{title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-(--el-text-secondary)">{desc}</p>
              </Card>
            </li>
          ))}
        </ol>

        {/* Optional steps — native disclosure (keyboard-reachable, no JS) */}
        <details className="group mt-3" open>
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)">
            <ChevronDown
              className="h-4 w-4 transition-transform group-open:rotate-0 [details:not([open])_&]:-rotate-90"
              aria-hidden
            />
            <span className="font-semibold">{t('landing.optional.summary')}</span>
            <span className="text-(--el-text-muted)">{t('landing.optional.summaryHint')}</span>
            <span className="ml-auto hidden font-mono text-xs text-(--el-text-faint) sm:inline">
              {t('landing.optional.names')}
            </span>
          </summary>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {optionalSteps.map(({ Icon, tint, title, desc, tag }) => (
              <li key={title}>
                <Card className="h-full border-dashed bg-(--el-surface)">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-(--radius-control) ${tint} text-(--el-text-strong)`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <h2 className="mt-3 flex items-center gap-2 text-sm font-semibold text-(--el-text)">
                    {title}
                    <span className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-medium uppercase tracking-wide text-(--el-text-muted)">
                      {tag}
                    </span>
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-(--el-text-secondary)">{desc}</p>
                </Card>
              </li>
            ))}
          </ul>
        </details>

        <p className="mx-auto mt-4 max-w-[60ch] text-center text-xs text-(--el-text-muted)">
          {t('landing.footnote')}
        </p>
      </section>
    </main>
  );
}
