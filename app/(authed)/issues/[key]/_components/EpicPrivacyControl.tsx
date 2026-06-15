'use client';

import { useCallback, useId, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Shield, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';

// The project-admin "Make this epic private" control (Story 6.14 · Subtask
// 6.14.7), per design/epic-privacy panel 4 + 6c. Renders in the epic detail
// rail for an EPIC-kind item only. A project admin flips the
// `publicChildrenHidden` flag via the shipped `Switch`; a non-admin member
// sees it READ-ONLY (disabled) — never hidden — so the state stays legible to
// everyone with access (design invariant #4).
//
// The toggle is optimistic and reconciles from the PATCH response — no
// router.refresh (the inline-edit "success response is the confirmation"
// rule): the flag's only on-page surface is this cell, and its public-read
// effect is enforced server-side (6.14.4), so there is nothing else to refresh.
// Overlapping toggles are seq-guarded so a stale response can't clobber the
// newest optimistic state.
export function EpicPrivacyControl({
  workItemId,
  initialHidden,
  canManageProject,
}: {
  workItemId: string;
  /** The authoritative `publicChildrenHidden` flag the toggle seeds from. */
  initialHidden: boolean;
  /** Project admin (or workspace owner/admin) — gates the toggle vs. read-only. */
  canManageProject: boolean;
}) {
  const t = useTranslations('issueViews');
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [hidden, setHidden] = useState(initialHidden);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  // Drops the reconcile of a superseded toggle (overlapping flips resolve out
  // of order — mirrors WatchControl's `toggleSeq` guard).
  const seq = useRef(0);
  const labelId = useId();

  const toggle = useCallback(
    (next: boolean) => {
      const mySeq = ++seq.current;
      setHidden(next); // optimistic
      setError(false);
      setPending(true);
      startTransition(async () => {
        try {
          const res = await fetch(
            `/api/work-items/${encodeURIComponent(workItemId)}/epic-privacy`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ publicChildrenHidden: next }),
            },
          );
          if (!res.ok) throw new Error(String(res.status));
          const item = (await res.json()) as { publicChildrenHidden: boolean };
          if (mySeq !== seq.current) return;
          // Reconcile from the response — the success IS the confirmation.
          setHidden(item.publicChildrenHidden);
        } catch {
          if (mySeq !== seq.current) return;
          setHidden(!next); // revert
          setError(true);
          toast({
            variant: 'error',
            title: t('epicPrivacyErrorTitle'),
            description: t('epicPrivacyError'),
          });
        } finally {
          if (mySeq === seq.current) setPending(false);
        }
      });
    },
    [workItemId, t, toast],
  );

  return (
    <Card aria-labelledby={labelId}>
      <div className="flex items-start gap-2.5">
        <Shield
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            hidden ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-muted)',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span id={labelId} className="font-sans text-sm font-medium text-(--el-text)">
              {t('epicPrivacyLabel')}
            </span>
            <span className="flex items-center gap-2">
              {pending ? (
                <Spinner size="sm" className="text-(--el-text-muted)" aria-hidden />
              ) : null}
              <Switch
                checked={hidden}
                onCheckedChange={toggle}
                disabled={!canManageProject || pending}
                aria-labelledby={labelId}
              />
            </span>
          </div>

          <p className="mt-1 font-sans text-[13px] leading-[1.45] text-(--el-text-secondary)">
            {t('epicPrivacyDescription')}
          </p>

          {hidden ? (
            <p className="mt-2 flex items-start gap-1.5 font-sans text-xs leading-[1.45] text-(--el-text-muted)">
              <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('epicPrivacyOnHelper')}
            </p>
          ) : null}

          {!canManageProject ? (
            <p className="mt-2 font-sans text-xs leading-[1.45] text-(--el-text-muted)">
              {t('epicPrivacyAdminOnly')}
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-2 flex items-start gap-1.5 font-sans text-xs leading-[1.45] text-(--el-danger)"
            >
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('epicPrivacyError')}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
