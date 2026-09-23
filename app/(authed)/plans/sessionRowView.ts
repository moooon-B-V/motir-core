import { getFormatter } from 'next-intl/server';

import type { PlanSessionRowDto } from '@/lib/dto/planSessions';

import type { SessionRowView } from './_components/types';

// Server-side view-model builder for the Plans SESSION list (MOTIR-6025). Shared
// by the page's first render AND the load-more action, so a streamed page renders
// identically to the first. It adds the one thing the row needs that the DTO does
// not carry — a relative time formatted on the server — and settles the title.

export async function buildSessionRowViews(
  sessions: PlanSessionRowDto[],
): Promise<SessionRowView[]> {
  const format = await getFormatter();
  return sessions.map((session) => ({
    id: session.id,
    origin: session.origin,
    // What was asked; a session opened without a turn (an agent's, a
    // generation's, a backfilled one) is known by its latest plan instead
    // (§19.2, MOTIR-6025 AC 1).
    title: session.firstTurn ?? session.latestPlan?.title ?? '',
    targetKeys: session.targetKeys,
    activeLabel: format.relativeTime(new Date(session.lastActivityAt)),
    startedByName: session.startedBy?.name ?? null,
    latestPlan: session.latestPlan
      ? { id: session.latestPlan.id, status: session.latestPlan.status }
      : null,
    planCount: session.planCount,
  }));
}
