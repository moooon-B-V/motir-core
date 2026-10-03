import { getTranslations } from 'next-intl/server';
import { Ban, CircleCheck, CircleHelp, CircleMinus, Coins, TriangleAlert } from 'lucide-react';
import { Pill, type PillProps } from '@/components/ui/Pill';
import type { FleetVerdict } from '@/lib/dto/platformFleetMonitor';

/**
 * ONE VERDICT CHIP per `FleetVerdict` value (MOTIR-7319 · design MOTIR-7314,
 * `platform-admin/design-notes.md` § _The verdict chips_).
 *
 * ⚠️ A TOTAL MAP. `Record<FleetVerdict, …>` makes a new member of the closed
 * union a compile error here rather than a chip that silently falls through to
 * nothing — the same guard the alert job's fingerprint relies on.
 *
 * WORD + GLYPH on every chip; colour is the third signal. The three mismatches
 * share the danger role and differ by word and glyph (the colour says "this org
 * needs a look", the word says why). `balance_unknown` and `not_charged` are
 * NEUTRAL — never counted, never railed. The chip's `title` is the meaning.
 */
export const FLEET_VERDICT_CHIP: Record<
  FleetVerdict,
  { icon: typeof Ban; pill: Pick<PillProps, 'severity' | 'tone'> }
> = {
  ok: { icon: CircleCheck, pill: { severity: 'success' } },
  running_not_debited: { icon: TriangleAlert, pill: { severity: 'danger' } },
  debited_nothing_running: { icon: Coins, pill: { severity: 'danger' } },
  exhausted_still_running: { icon: Ban, pill: { severity: 'danger' } },
  balance_unknown: { icon: CircleHelp, pill: { tone: 'neutral' } },
  not_charged: { icon: CircleMinus, pill: { tone: 'neutral' } },
};

export async function FleetVerdictChip({ verdict }: { verdict: FleetVerdict }) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const { icon: Icon, pill } = FLEET_VERDICT_CHIP[verdict];
  return (
    <Pill {...pill} data-verdict={verdict} title={t(`verdictHint.${verdict}`)}>
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      {t(`verdict.${verdict}`)}
    </Pill>
  );
}
