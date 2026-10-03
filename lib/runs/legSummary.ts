import type { useTranslations } from 'next-intl';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

// A RUN'S OUTCOME IN ONE LINE — "9 of 11 done · 1 skipped" (Story MOTIR-1789 ·
// MOTIR-3923, lifted by MOTIR-5363).
//
// Read off the COUNTS a run-list row already carries, never off its legs. It used
// to live inside the runs index; the item page's scope block (design MOTIR-5402
// panels 1–2) renders the same row, and two copies of this sentence are how one
// run comes to be described two ways. Directive-free, so both client islands
// import it without either becoming the other's dependency.

/**
 * "9 of 11 done · 1 waiting on you · 1 skipped" — the run's outcome in one cell. A
 * run that took NO work items says so: zero is a real answer (a scoped run whose
 * every member was skipped), not an error.
 *
 * ⚠️ THE WAITING LEGS COME OUT OF *SKIPPED* (MOTIR-7477, `design/runs/design-notes.md`
 * § _Waiting on you_) and sit right after *done*, because they are the one segment
 * that asks something of a person: *{n} waiting on you* (an awaiting gate routed to
 * the reader), then *{n} waiting on others*, each omitted at zero. A leg whose gate
 * was marked done stays *skipped* — the run did not do it.
 */
export function legSummary(
  run: Pick<DispatchRunListItemDto, 'cardCount' | 'legs' | 'waiting'>,
  t: ReturnType<typeof useTranslations>,
): string {
  if (run.cardCount === 0) return t('tookNone');
  const done = run.legs.implemented + run.legs.integrated;
  const waitingYou = run.waiting?.you ?? 0;
  const waitingOthers = run.waiting?.others ?? 0;
  const skipped = Math.max(run.legs.skipped - waitingYou - waitingOthers, 0);
  const parts = [t('summaryDone', { done, total: run.cardCount })];
  if (waitingYou > 0) parts.push(t('summaryWaitingYou', { n: waitingYou }));
  if (waitingOthers > 0) parts.push(t('summaryWaitingOthers', { n: waitingOthers }));
  if (skipped > 0) parts.push(t('summarySkipped', { n: skipped }));
  if (run.legs.failed > 0) parts.push(t('summaryFailed', { n: run.legs.failed }));
  if (run.legs.not_reached > 0) parts.push(t('summaryNotReached', { n: run.legs.not_reached }));
  if (run.legs.replanned > 0) parts.push(t('summaryReplanned', { n: run.legs.replanned }));
  return parts.join(' · ');
}
