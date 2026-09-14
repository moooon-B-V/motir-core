'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { buttonVariants } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';

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
// (the org-tier `AcceptanceVideoCard.tsx`, deleted by MOTIR-5172), which is one of the three defects the design found
// by rendering that card rather than reading it.
//
// ⚠️ THREE STATES, AND THE ENTITLEMENT DECIDES THE NAME AND THE SWITCH TOGETHER
// (panel 3 · MOTIR-5171). With no paid AI plan the state is `Unavailable` and the
// switch is off and disabled, WHATEVER the stored flag says. The org-tier card
// computed its label from the flag alone and its switch from `flag && hasPlan`, so
// with no plan it printed "On" beside a switch that was off. Here both read ONE
// derived `state`, so no pair of (stored flag × entitlement) can make them disagree.
// The stored flag is still kept, untouched: buying a plan restores what was chosen.
//
// There is NO read-only state: the room is manage-only
// (`design/projects/design-notes.md` § ⭐ Approvals §6, 2026-09-13), so every actor
// who renders this card may change it. MOTIR-5278's `canManage` prop and its
// disabled branch were reverted by MOTIR-5394.

export interface AcceptanceVideoGateCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
  /**
   * The organisation may publish acceptance video at all — read by the page off
   * `acceptanceVideoEligibilityService`'s DTO. This card computes no entitlement.
   */
  entitled: boolean;
}

type GateState = 'on' | 'off' | 'unavailable';

export function AcceptanceVideoGateCard({
  projectKey,
  initialEnabled,
  entitled,
}: AcceptanceVideoGateCardProps) {
  const t = useTranslations('approvals.acceptanceVideo');
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();
  const state: GateState = !entitled ? 'unavailable' : enabled ? 'on' : 'off';

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
      // THE DEEP-LINK TARGET (MOTIR-5172). The acceptance panel's "Go to settings" /
      // "View settings" links land on `#acceptance-video`; the org-tier card this
      // replaces carried that id, and a link whose anchor names nothing lands at
      // the top of the room looking like it worked.
      id="acceptance-video"
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="text-(--el-text-secondary) font-sans text-sm">{t('desc')}</p>
        </div>
      }
      footer={
        state === 'unavailable' ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('orgPlanNote')}
            </span>
            <Link
              href={BILLING_PLANS_PATH}
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
            >
              {t('upgrade')}
            </Link>
          </div>
        ) : undefined
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-sm font-medium text-(--el-text)">{t(state)}</span>
          <span className="text-(--el-text-secondary) font-sans text-xs">{t(`${state}What`)}</span>
        </span>
        <Switch
          checked={state === 'on'}
          onCheckedChange={toggle}
          disabled={state === 'unavailable' || isPending}
          aria-label={t('title')}
        />
      </div>
    </Card>
  );
}
