'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { switchOrganizationAction } from '@/app/(authed)/_actions';
import type { OrganizationDTO } from '@/lib/dto/organizations';

/**
 * The way back to WORK for a member of more than one organization (MOTIR-752).
 *
 * ⚠️ WITHOUT THIS THE NOTICE IS A TRAP. The active organization and workspace
 * are cookie-pinned, so a member whose pinned workspace sits under the suspended
 * org is redirected here on every page — even though another of their
 * organizations is open. `switchOrganizationAction` re-points BOTH cookies (it
 * re-validates membership server-side), then the app is entered afresh.
 */
export function SwitchOrganizationList({ organizations }: { organizations: OrganizationDTO[] }) {
  const t = useTranslations('platformAdmin.member.suspended');
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2" data-testid="suspended-switch">
      <ul className="flex flex-col gap-2">
        {organizations.map((org) => (
          <li key={org.id}>
            <Button
              variant="secondary"
              className="w-full justify-between"
              rightIcon={<ArrowRight aria-hidden className="h-4 w-4" />}
              loading={pendingId === org.id}
              disabled={pendingId !== null && pendingId !== org.id}
              onClick={() => {
                setPendingId(org.id);
                setFailed(false);
                startTransition(async () => {
                  try {
                    await switchOrganizationAction(org.id);
                    router.push('/');
                  } catch {
                    setFailed(true);
                    setPendingId(null);
                  }
                });
              }}
            >
              {t('switchTo', { org: org.name })}
            </Button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="font-sans text-sm text-(--el-danger-on-surface)">
          {t('switchFailed')}
        </p>
      ) : null}
    </div>
  );
}
