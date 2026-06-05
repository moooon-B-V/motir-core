'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { FormAlert } from '@/app/(auth)/_components/AuthShell';
import { switchWorkspaceAction } from '../../_actions';

export function AcceptInviteButton({ token }: { token: string }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  function handleAccept() {
    setError(undefined);
    startTransition(async () => {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      });
      if (!res.ok) {
        // Re-render the page to show the matching error state (expired /
        // used / wrong-email) — the server re-inspects the token.
        router.refresh();
        setError(t('inviteAcceptFailed'));
        return;
      }
      const data = (await res.json()) as { workspaceId: string };
      // Switch the active workspace cookie to the just-joined workspace,
      // then land on the dashboard with it active.
      await switchWorkspaceAction(data.workspaceId);
      router.push('/dashboard');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <FormAlert>{error}</FormAlert> : null}
      <Button variant="primary" className="w-full" onClick={handleAccept} loading={isPending}>
        {t('acceptInvite')}
      </Button>
    </div>
  );
}
