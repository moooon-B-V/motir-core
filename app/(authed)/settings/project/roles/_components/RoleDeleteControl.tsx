'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { RoleDTO } from '@/lib/dto/permissions';

// Deleting a custom role (Story MOTIR-2257 · Subtask MOTIR-2480) — the one
// destructive surface in this story, built to `roles-permissions.mock.html`
// panel 5.
//
// ⚠️ THE DIALOG OPENS FIRST; THE SERVER'S COUNT WINS WHENEVER THEY DISAGREE.
//
// The card described pressing `Delete` as issuing a destination-less `DELETE`
// "to learn the truth" from the 409. That works for a role somebody holds — and
// for one NOBODY holds it is a 204: the role would be destroyed with no
// confirmation at all, which panel 5 state B explicitly draws as a plain
// confirm. A destructive action does not get to skip its confirm because it
// happens to be cheap.
//
// So the dialog opens on `role.memberCount`, which is not a client-side count —
// it is `getRoleCatalog`'s grouped read (MOTIR-2478), computed on the server for
// this exact screen. The CONFIRM then issues the write, and if the server
// answers 409 the dialog REPLACES its count with the one the refusal carries and
// asks again. That is the case the card's "from the 409 body" clause is really
// protecting: a number that went stale at the moment it matters, because someone
// was put on the role between the open and the confirm. Both intents hold, and
// nothing is destroyed unasked.
//
// This is `workflowsService.deleteStatus`' shipped shape one domain over
// (`StatusInUseError` + `ReassignModal` in `WorkflowEditor.tsx`), reused rather
// than re-invented.
//
// ⚠️ A ROLE IN USE CANNOT VANISH UNDER THE PEOPLE HOLDING IT. That is the whole
// point of the flow: a role that disappears either silently promotes its holders
// or silently strips them, and both are discovered by the person who can no
// longer do their job. The destination is REQUIRED whenever the count is > 0,
// and the server does the move and the removal in one transaction.

export function RoleDeleteControl({
  projectKey,
  role,
  roles,
}: {
  projectKey: string;
  /** The custom role being deleted. */
  role: RoleDTO;
  /** Every role in the project — the destinations are these minus this one. */
  roles: RoleDTO[];
}) {
  const t = useTranslations('settings.rolesPage');
  const tCatalog = useTranslations();
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  // `null` = closed. `{ count }` = open, carrying what the refusal said.
  const [prompt, setPrompt] = useState<{ count: number } | null>(null);
  const [destination, setDestination] = useState('');

  const destinations = roles.filter((candidate) => candidate.key !== role.key);

  function label(candidate: RoleDTO): string {
    return candidate.labelKey ? tCatalog(candidate.labelKey) : (candidate.name ?? candidate.key);
  }

  /** `reassignTo` omitted on the probe; present on the confirm. */
  function requestDelete(reassignTo?: string) {
    startTransition(async () => {
      const query = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
      const res = await fetch(`/api/projects/${projectKey}/roles/${role.key}${query}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        toast({ variant: 'success', title: t('toast.deleted', { name: label(role) }) });
        setPrompt(null);
        // The role list is a SERVER-rendered surface, so the shipped settings
        // routing is a push + refresh — the destination's member count is read
        // again on the server rather than patched in the client.
        router.push('/settings/project/roles');
        router.refresh();
        return;
      }

      const body = (await res.json().catch(() => ({}))) as { code?: string; count?: number };

      // The in-use refusal is not an error to report — it is the question being
      // asked. Open the dialog on it.
      if (body.code === 'ROLE_IN_USE') {
        setDestination('');
        setPrompt({ count: body.count ?? 0 });
        return;
      }

      // Anything else on the CONFIRM leaves the dialog open, so the admin can
      // see what they were doing and try again — the screen never silently
      // no-ops.
      toast({
        variant: 'error',
        title:
          body.code === 'INVALID_ROLE_REASSIGN_TARGET'
            ? t('error.badDestination')
            : res.status === 403 || res.status === 404
              ? t('error.noLongerAllowed')
              : t('error.generic'),
      });
      if (res.status === 404) {
        // The role is already gone — the list is the honest place to be.
        router.push('/settings/project/roles');
        router.refresh();
      }
    });
  }

  function open() {
    setDestination('');
    setPrompt({ count: role.memberCount });
  }

  const needsDestination = (prompt?.count ?? 0) > 0;
  const canConfirm = !isPending && (!needsDestination || destination !== '');

  return (
    <>
      <Button
        variant="ghost"
        onClick={open}
        disabled={isPending}
        aria-label={t('deleteRole', { name: label(role) })}
        data-testid="delete-role"
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
      </Button>

      {prompt ? (
        <Modal
          open
          // ⚠️ `alertdialog`, not `dialog` — the shipped affordance for a
          // DESTRUCTIVE confirm (the 2.8.4 delete confirm uses it), so assistive
          // tech treats this as an alert that interrupts and announces its
          // description rather than an ordinary panel.
          role="alertdialog"
          // Radix restores focus to whatever held it before the dialog opened —
          // the `Delete` control the admin pressed. Calling `.focus()` here as
          // well FIGHTS that restoration rather than helping it, which is how
          // focus ended up on `<body>`.
          onOpenChange={(next) => {
            if (!next) setPrompt(null);
          }}
        >
          <h2 className="text-(--el-text) font-serif text-xl font-semibold">
            {t('deleteDialog.title', { name: label(role) })}
          </h2>

          {/* The load-bearing sentence — `--el-text`, not muted. */}
          <p
            className="text-(--el-text) mt-2 font-sans text-sm"
            data-testid="delete-affected-count"
          >
            {needsDestination
              ? t.rich('deleteDialog.affected', {
                  count: prompt.count,
                  b: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                })
              : // Plain `t()`, not `t.rich()`: this string carries no markup in
                // either catalogue, so a chunk renderer here would be a function
                // nothing can ever call — and one that would quietly go on
                // looking correct if a `<b>` were later added to only one locale.
                t('deleteDialog.noneAffected')}
          </p>
          <p className="text-(--el-text-secondary) mt-2 font-sans text-[13px] leading-relaxed">
            {t('deleteDialog.lede')}
          </p>

          {needsDestination ? (
            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-(--el-text-secondary) font-sans text-[12.5px] font-medium">
                {t('deleteDialog.moveTo', { count: prompt.count })}
              </span>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                disabled={isPending}
                aria-label={t('deleteDialog.moveTo', { count: prompt.count })}
                data-testid="delete-destination"
                className="border-(--el-input-border) bg-(--el-card) text-(--el-text) h-(--height-input) rounded-(--radius-input) border px-(--spacing-input-x) font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <option value="" disabled>
                  {t('deleteDialog.choosePlaceholder')}
                </option>
                {destinations.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {label(candidate)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <Modal.Footer>
            <Button variant="ghost" onClick={() => setPrompt(null)} disabled={isPending}>
              {tc('cancel')}
            </Button>
            <Button
              variant="danger"
              loading={isPending}
              disabled={!canConfirm}
              data-testid="delete-confirm"
              onClick={() => requestDelete(needsDestination ? destination : undefined)}
            >
              {t('deleteDialog.confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
