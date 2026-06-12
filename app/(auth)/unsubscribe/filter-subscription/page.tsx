import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CheckCircle2, BellOff, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { verifyUnsubscribeToken } from '@/lib/savedFilters/subscriptionToken';

// Token-authenticated unsubscribe landing (Story 6.2 · Subtask 6.2.5) — the
// target of the "Unsubscribe" link in a filter-subscription email. No session:
// the link carries an HMAC token that authenticates exactly one subscription
// (lib/savedFilters/subscriptionToken). The page CONFIRMS before acting (a
// real submit, so an email-client link-prefetch can't silently unsubscribe),
// then the inline server action removes the row and redirects to the done
// state. Idempotent: re-confirming an already-removed subscription still
// reports success; only a malformed/forged token shows the invalid state.

type SearchParams = Promise<{ token?: string; status?: string }>;

async function unsubscribeAction(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  const result = await savedFilterSubscriptionsService.unsubscribeByToken(token);
  redirect(`/unsubscribe/filter-subscription?status=${result.status}`);
}

export default async function UnsubscribeFilterSubscriptionPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';
  const t = await getTranslations('unsubscribeFilters');

  if (sp.status === 'unsubscribed') {
    return (
      <Panel
        icon={<CheckCircle2 className="size-6 text-(--el-success)" aria-hidden />}
        title={t('done.title')}
        body={t('done.body')}
      >
        <Link href="/issues" className={buttonVariants({ variant: 'secondary' })}>
          {t('done.action')}
        </Link>
      </Panel>
    );
  }

  // An invalid/forged token, OR a confirmed unsubscribe whose token didn't
  // verify — the same "this link isn't valid" terminus.
  if (sp.status === 'invalid' || verifyUnsubscribeToken(token) === null) {
    return (
      <Panel
        icon={<TriangleAlert className="size-6 text-(--el-warning)" aria-hidden />}
        title={t('invalid.title')}
        body={t('invalid.body')}
      >
        <Link href="/issues" className={buttonVariants({ variant: 'secondary' })}>
          {t('invalid.action')}
        </Link>
      </Panel>
    );
  }

  return (
    <Panel
      icon={<BellOff className="size-6 text-(--el-text-secondary)" aria-hidden />}
      title={t('confirm.title')}
      body={t('confirm.body')}
    >
      <form action={unsubscribeAction}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" variant="danger">
          {t('confirm.action')}
        </Button>
      </form>
    </Panel>
  );
}

function Panel({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span aria-hidden className="inline-flex">
        {icon}
      </span>
      <h1 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h1>
      <p className="text-sm text-(--el-text-secondary)">{body}</p>
      <div className="pt-2">{children}</div>
    </div>
  );
}
