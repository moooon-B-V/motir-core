'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

// The DESIGN-APPROVAL switch (Story MOTIR-693 · MOTIR-702), built to
// `design/projects/approvals--design-gate.mock.html` panels 1 (on) and 2 (off), in
// its sibling `AcceptanceVideoGateCard`'s grammar: a title + description header, then
// the state NAME and its one-line CONSEQUENCE beside the `Switch`. A pure client
// consumer of `PATCH /api/projects/[key]/approval-gates` (`designApprovalGate`,
// MOTIR-697).
//
// ⚠️ NO ENTITLEMENT FOOTER: this switch needs no plan, so it has two states, not three.
//
// ⚠️ NO READ-ONLY STATE, per the design (and against the card's first wording): the
// Approvals room is manage-only (`design/projects/design-notes.md` § ⭐ Approvals §6,
// 2026-09-13), so every actor who renders this card may change it.
//
// ⚠️ INK: title `--el-text`; description and consequence `--el-text-secondary`, never
// `--el-text-muted` (it fails AA on every surface this card can land on).

export interface DesignApprovalGateCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
}

export function DesignApprovalGateCard({
  projectKey,
  initialEnabled,
}: DesignApprovalGateCardProps) {
  const t = useTranslations('approvals.designApproval');
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();
  const state = enabled ? 'on' : 'off';

  function toggle(next: boolean) {
    // Optimistic, then reconciled from the response; on failure the value is put
    // BACK, because a switch showing a state the server refused is contradicted by
    // nothing later.
    const previous = enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/approval-gates`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ designApprovalGate: next }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
        const settings = (await res.json()) as { designApprovalGate: boolean };
        setEnabled(settings.designApprovalGate);
        toast({ variant: 'success', title: t('saved') });
      } catch {
        setEnabled(previous);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  return (
    <Card
      // The deep-link target the system-approved record links to (the design's
      // `design-result--system-approved.mock.html` panel 1).
      id="design-approval"
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="text-(--el-text-secondary) font-sans text-sm">{t('desc')}</p>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-sm font-medium text-(--el-text)">{t(state)}</span>
          <span className="text-(--el-text-secondary) font-sans text-xs">{t(`${state}What`)}</span>
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={isPending}
          aria-label={t('title')}
        />
      </div>
    </Card>
  );
}
