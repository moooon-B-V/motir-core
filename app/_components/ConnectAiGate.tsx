import Link from 'next/link';
import { Plug, Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

// The self-host Connect-Motir-AI gate (Subtask 7.3.14 — design Surface 6 /
// screen K). When the deployment is self-hosted and no Motir Cloud token is
// connected (`isAiPlanningConfigured()` is false), the front door shows THIS gate
// instead of the hero — the chat is a client for the closed cloud planner, so
// there's nothing to type into until a connection exists (the cloud-gated-AI
// decision). Cloud deployments never reach this branch.
//
// The "Connect Motir AI" CTA routes to the organization settings area, where the
// cloud-connection control lives; an unauthenticated visitor is bounced through
// sign-in by the (authed) layout. (The token-connection settings surface itself
// is owned by a separate self-host story; this card owns the GATE.)
export async function ConnectAiGate() {
  const t = await getTranslations('onboarding');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-(--el-page-bg) px-6 text-(--el-text)">
      <Link href="/" className="mb-8 flex items-center gap-2 font-sans text-base font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
          <Sparkles className="h-4 w-4" aria-hidden />
        </span>
        Motir
      </Link>
      <Card
        tint="yellow"
        className="flex max-w-[28rem] items-start gap-3 shadow-(--shadow-card)"
        role="status"
      >
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-warning)">
          <Plug className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-sm font-semibold text-(--el-text)">{t('connectGate.title')}</h1>
          <p className="mt-1 text-sm leading-relaxed text-(--el-text-secondary)">
            {t('connectGate.body')}
          </p>
          <Link
            href="/settings/organization"
            className={`${buttonVariants({ variant: 'primary', size: 'sm' })} mt-3`}
          >
            {t('connectGate.cta')}
          </Link>
        </div>
      </Card>
    </main>
  );
}
