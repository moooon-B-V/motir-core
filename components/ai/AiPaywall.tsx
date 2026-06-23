'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Pause, Sparkles, Lock, ArrowUp } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useAiAccess } from '@/lib/hooks/useAiAccess';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { cn } from '@/lib/utils/cn';

// The AI-boundary paywall / upgrade prompt (Subtask 8.1.8, design/billing panel
// 7). The in-product upsell shown when an org can't use AI — at the AI entry
// points (chat composer / plan / Draft-with-AI). Three states, matching the mock:
//   (a) out_of_credits  — a PAID org exhausted its allotment → "Planning is
//       paused", an active Upgrade CTA + Buy-top-up (owner).
//   (b) tier-gate       — a free org that never bought AI → "AI is a paid
//       feature", a See-plans CTA (owner).
//   (c) member          — a non-owner can't buy → "ask an owner", never a dead CTA.
// Every surface composes the shipped Card/Button primitives + `--el-*` colour and
// element-shape tokens (no Tier-0); cloud-only (the access read is `applicable:
// false` off-cloud, so nothing renders).

/** The stable typed code an out-of-credits SSE terminal `error` frame carries
 *  (lib/ai/errors.ts MotirAiOutOfCreditsError). Consumers branch on it to flip a
 *  generic stream error into the paywall. */
export const AI_OUT_OF_CREDITS_CODE = 'MOTIR_AI_OUT_OF_CREDITS';

/** The org-settings billing/plans surface the upgrade CTAs navigate to (8.1.7
 *  owns the destination; this is the route contract the design names). */
export const BILLING_PLANS_PATH = '/settings/organization/billing';

export type AiPaywallReason = 'out_of_credits' | 'tier_gate';
export type AiPaywallVariant = 'owner' | 'member';

export interface ResolvedAiPaywall {
  reason: AiPaywallReason;
  variant: AiPaywallVariant;
  organizationName: string | null;
  tierName: string | null;
  tierAllotment: number | null;
  renewsAt: string | null;
}

/**
 * Decide whether and how to show the paywall. Pure (unit-tested) so the policy
 * is verifiable without rendering:
 *   - `triggered` = an AI call just returned out_of_credits (the reactive path).
 *   - `proactive` = the entitlement read shows the org already out of usable
 *     credits on cloud (shown before the user tries).
 * Either fires the paywall. The variant (owner vs member) and reason (paid org
 * out of credits vs never-bought tier-gate) come from the access read; with no
 * usable access context (a reactive trigger outside any resolvable org) it falls
 * back to the generic owner out-of-credits prompt.
 */
export function resolveAiPaywall(
  access: AiAccessDTO | null,
  triggeredOutOfCredits: boolean,
): ResolvedAiPaywall | null {
  const applicable = access?.applicable === true;
  const proactive = applicable && access!.balance <= 0;
  if (!triggeredOutOfCredits && !proactive) return null;

  if (applicable) {
    return {
      reason: access!.hasPaidAiPlan ? 'out_of_credits' : 'tier_gate',
      variant: access!.canManageBilling ? 'owner' : 'member',
      organizationName: access!.organizationName,
      tierName: access!.tierName,
      tierAllotment: access!.tierAllotment,
      renewsAt: access!.renewsAt,
    };
  }
  // Reactive trigger with no resolvable org context (rare): a generic owner
  // out-of-credits prompt — never leave a real refusal unexplained.
  return {
    reason: 'out_of_credits',
    variant: 'owner',
    organizationName: null,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
  };
}

export interface AiPaywallProps {
  /**
   * The entitlement context. Pass it when the host already read it (avoids a
   * second fetch); omit to let the paywall read it itself (the inline
   * Draft-with-AI use, where the host has no access prop).
   */
  access?: AiAccessDTO | null;
  /** Set when an AI call just returned out_of_credits — forces the reactive paywall. */
  triggeredOutOfCredits?: boolean;
  /** Dismiss affordance (tier-gate "Maybe later"); omit to hide it. */
  onDismiss?: () => void;
  className?: string;
}

export function AiPaywall({
  access: accessProp,
  triggeredOutOfCredits = false,
  onDismiss,
  className,
}: AiPaywallProps) {
  // Self-fetch only when the host didn't supply access (prop `undefined`). A host
  // that passes `null` explicitly opts out of the extra fetch.
  const selfFetch = accessProp === undefined;
  const self = useAiAccess();
  const access = selfFetch ? self.access : accessProp;

  const resolved = resolveAiPaywall(access ?? null, triggeredOutOfCredits);
  if (!resolved) return null;

  return <AiPaywallCard resolved={resolved} onDismiss={onDismiss} className={className} />;
}

function AiPaywallCard({
  resolved,
  onDismiss,
  className,
}: {
  resolved: ResolvedAiPaywall;
  onDismiss?: () => void;
  className?: string;
}) {
  const t = useTranslations('billing');
  const org = resolved.organizationName ?? t('paywall.fallbackOrg');

  if (resolved.variant === 'member') {
    return (
      <PaywallShell
        className={className}
        icon={<Lock className="h-6 w-6" aria-hidden />}
        iconTint="lavender"
        title={t('paywall.member.title')}
        body={t('paywall.member.body', { org })}
        actions={
          // Presentational guidance, not a navigation CTA: a plain member cannot
          // buy, and the org-members surface is admin-gated, so this states the
          // action to take (ask a human) without a link that would 403.
          <Button type="button" size="md" variant="secondary" disabled>
            {t('paywall.member.askOwner')}
          </Button>
        }
      />
    );
  }

  if (resolved.reason === 'tier_gate') {
    return (
      <PaywallShell
        className={className}
        icon={<Sparkles className="h-6 w-6" aria-hidden />}
        iconTint="lavender"
        title={t('paywall.tierGate.title')}
        body={t('paywall.tierGate.body', { org })}
        actions={
          <>
            <Link
              href={BILLING_PLANS_PATH}
              className={buttonVariants({ variant: 'primary', size: 'md' })}
            >
              {t('paywall.tierGate.seePlans')}
            </Link>
            {onDismiss ? (
              <Button type="button" size="md" variant="ghost" onClick={onDismiss}>
                {t('paywall.tierGate.maybeLater')}
              </Button>
            ) : null}
          </>
        }
      />
    );
  }

  // out_of_credits — owner. NAME the limit when the tier is known (AC1).
  const body =
    resolved.tierName && resolved.tierAllotment !== null
      ? t('paywall.outOfCredits.bodyNamed', {
          org,
          tier: resolved.tierName,
          allotment: resolved.tierAllotment,
        })
      : t('paywall.outOfCredits.body', { org });

  return (
    <PaywallShell
      className={className}
      icon={<Pause className="h-6 w-6" aria-hidden />}
      iconTint="yellow"
      title={t('paywall.outOfCredits.title')}
      body={body}
      actions={
        <>
          <Link
            href={BILLING_PLANS_PATH}
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
            {t('paywall.outOfCredits.upgrade')}
          </Link>
          <Link
            href={BILLING_PLANS_PATH}
            className={buttonVariants({ variant: 'secondary', size: 'md' })}
          >
            {t('paywall.outOfCredits.topUp')}
          </Link>
        </>
      }
      note={
        resolved.renewsAt
          ? t('paywall.outOfCredits.renewNote', { date: formatRenewDate(resolved.renewsAt) })
          : t('paywall.outOfCredits.renewNoteUndated')
      }
    />
  );
}

// The shared `.state` block from the mock: a centred Card with a tinted icon
// chip, serif title, muted body, an actions row, and an optional quiet note.
const ICON_TINT: Record<'yellow' | 'lavender', string> = {
  yellow: 'bg-(--el-tint-yellow) text-(--el-warning)',
  lavender: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
};

function PaywallShell({
  icon,
  iconTint,
  title,
  body,
  actions,
  note,
  className,
}: {
  icon: ReactNode;
  iconTint: 'yellow' | 'lavender';
  title: string;
  body: string;
  actions: ReactNode;
  note?: string;
  className?: string;
}) {
  return (
    <Card role="status" className={cn('flex flex-col items-center text-center', className)}>
      <span
        className={cn(
          'mb-(--spacing-md) inline-flex h-12 w-12 items-center justify-center rounded-(--radius-control)',
          ICON_TINT[iconTint],
        )}
      >
        {icon}
      </span>
      <h2 className="font-serif text-xl text-(--el-text)">{title}</h2>
      <p className="text-(--el-text-muted) mt-(--spacing-sm) max-w-prose font-sans text-sm">
        {body}
      </p>
      <div className="mt-(--spacing-md) flex flex-wrap items-center justify-center gap-2">
        {actions}
      </div>
      {note ? (
        <p className="text-(--el-text-faint) mt-(--spacing-sm) font-sans text-xs">{note}</p>
      ) : null}
    </Card>
  );
}

// Locale-agnostic, absolute (not relative) date — formatted on the client only
// (this card renders post-mount on an error / blocked state), so no SSR/hydration
// skew. Falls back to the raw ISO string if it can't parse.
function formatRenewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
