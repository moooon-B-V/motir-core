'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { FormAlert } from '@/app/(auth)/_components/AuthShell';
import { switchWorkspaceAction } from '../../_actions';
import { afterContextSwitchTarget } from '@/lib/navigation/afterContextSwitch';

export function AcceptInviteButton({ token }: { token: string }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const pathname = usePathname();
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
      // then land with it active. Accepting an invite IS a context switch — it
      // calls the same server action the workspace switcher does — so it asks
      // the same helper where to go instead of naming a route (MOTIR-5132).
      // This site named `/dashboard`, and had since before the landing existed.
      await switchWorkspaceAction(data.workspaceId);
      const target = afterContextSwitchTarget(pathname);
      if (target) router.push(target);
      else router.refresh();
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
