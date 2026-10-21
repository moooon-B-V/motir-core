import type { useTranslations } from 'next-intl';
import type { DispatchRunCardDto } from '@/lib/dto/dispatchRuns';
import { DISPOSITION_TONE, skipReasonMessage, type RunTone } from '@/lib/runs/timeline';

// THE ONE RESOLUTION OF A LEG'S TONE + WORDS (MOTIR-9074).
//
// The canvas badge and the List row both say what became of a run's work item, and
// two copies of "a skipped leg shows its reason, a manual one names who it waits
// on" is how the two surfaces end up wording the same leg differently. The tone is
// `DISPOSITION_TONE`'s (total over the enum); the skip reason is
// `skipReasonMessage`'s, which resolves a MANUAL leg from its gate (MOTIR-7477).

export interface RunLegLabel {
  tone: RunTone;
  label: string;
}

type Translate = ReturnType<typeof useTranslations>;

export function runLegLabel(
  t: Translate,
  leg: Pick<DispatchRunCardDto, 'disposition' | 'skipReason' | 'manualGate'>,
): RunLegLabel {
  const skip =
    leg.disposition === 'skipped' && leg.skipReason !== null
      ? skipReasonMessage({ skipReason: leg.skipReason, manualGate: leg.manualGate })
      : null;
  const label = skip ? t(skip.key, skip.values) : t(`disposition.${leg.disposition}`);
  return { tone: DISPOSITION_TONE[leg.disposition], label };
}
