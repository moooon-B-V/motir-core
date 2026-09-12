'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

// The ACCEPTANCE-VIDEO gate switch (Story MOTIR-4925 · Subtask MOTIR-5170), built
// to `design/projects/approvals.mock.html` panels 1 (ON) and 2 (OFF) and their
// legend. A pure client consumer of `PATCH /api/projects/[key]/approval-gates` —
// the settings-page fetch idiom this area already uses (EstimationSettingsEditor,
// BoardConfigEditor), NOT a server action.
//
// ⚠️ THE STATE LINE CARRIES A NAME **AND** A CONSEQUENCE, and that is the design's
// point rather than a flourish: "On" alone does not tell a reader what their
// project just started doing. The org-tier card this replaces showed only the
// name, which is why somebody had to read the ADR to find out what the switch did.
//
// ⚠️ INK. Title `--el-text`; description and state gloss `--el-text-secondary` —
// NEVER `--el-text-muted`, which measures 4.12–4.34:1 on `--el-surface` /
// `--el-muted` / `--el-surface-soft` and fails AA on every surface this card can
// land on. The control it replaces used `--el-text-muted` for its description
// (`AcceptanceVideoCard.tsx`), which is one of the three defects the design found
// by rendering that card rather than reading it.
//
// SCOPE: this card ships the two states an admin of an entitled organisation sees.
// `Unavailable` (no paid AI plan) and read-only are MOTIR-5171's, and the reason
// they are not merely "the rest of the states" is that each carries a shipped
// defect of its own.

export interface AcceptanceVideoGateCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
}

export function AcceptanceVideoGateCard({
  projectKey,
  initialEnabled,
}: AcceptanceVideoGateCardProps) {
  const t = useTranslations('approvals.acceptanceVideo');
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();

  function toggle(next: boolean) {
    // Optimistic, then reconciled from the response — the same shape the sibling
    // editors use. On failure the value is put BACK rather than left hopeful: a
    // switch that shows a state the server refused is the worst of the three
    // possible outcomes, because nothing later contradicts it.
    const previous = enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/approval-gates`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ acceptanceVideoEnabled: next }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
        const settings = (await res.json()) as { acceptanceVideoEnabled: boolean };
        setEnabled(settings.acceptanceVideoEnabled);
        toast({ variant: 'success', title: t('saved') });
      } catch {
        setEnabled(previous);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  return (
    <Card
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="text-(--el-text-secondary) font-sans text-sm">{t('desc')}</p>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-sm font-medium text-(--el-text)">
            {enabled ? t('on') : t('off')}
          </span>
          <span className="text-(--el-text-secondary) font-sans text-xs">
            {enabled ? t('onWhat') : t('offWhat')}
          </span>
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
