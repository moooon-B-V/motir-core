import type {
  PlanNarrationDto,
  PlanNarrationReadDto,
  PlanNarrationSessionDto,
} from '@/lib/dto/plans';
import type { PlanReviewDto } from '@/lib/dto/planReview';

/**
 * THE PLANNER'S NARRATION, grouped (Story MOTIR-8060 · MOTIR-8064).
 *
 * Pure and I/O-free: which session group each stored sentence belongs to, the
 * groups' order, and which group is live. `PlanNarration` renders from it and
 * never re-sorts. The authority for every rule is
 * `design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat panel"
 * (MOTIR-8061) and its delta mock `plan-change-run-live--narration.mock.html`.
 *
 * ⚠️ ATTRIBUTION COMES FROM STRUCTURE. A sentence lands only in the group of its
 * own `sessionKey`; there is no second list of messages that could drift from
 * the list of groups.
 */

/** One session's group: its stored step words (or `null` for a sentence whose
 *  session has no step-words row), its sentences in `seq` order, and whether it
 *  still holds an in-flight step on a `generating` plan. */
export interface NarrationGroup {
  sessionKey: string;
  session: PlanNarrationSessionDto | null;
  messages: PlanNarrationDto[];
  live: boolean;
}

/** Every sentence in `lists`, one per `seq`, in ascending `seq`. A later list
 *  wins a duplicate, so a fresh window replaces a kept copy of the same row. */
export function mergeNarrationEntries(
  ...lists: ReadonlyArray<readonly PlanNarrationDto[]>
): PlanNarrationDto[] {
  const bySeq = new Map<number, PlanNarrationDto>();
  for (const list of lists) for (const entry of list) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Group the narration per session:
 *
 *  - one group per `sessions` row, in `sessions` order (`firstReportedAt`, then
 *    id — the read's own order), including a session with no sentence at all;
 *  - a sentence whose `sessionKey` has no row gets a HEADLESS group
 *    (`session: null`), placed before the headed groups in the order of its first
 *    sentence — never an invented head;
 *  - `live` only for a session in `liveSessionKeys`. It decides the live ink and
 *    the finished mark, never the head's words.
 */
export function groupNarration(
  read: Pick<PlanNarrationReadDto, 'sessions' | 'entries'>,
  liveSessionKeys: Iterable<string>,
): NarrationGroup[] {
  const live = new Set(liveSessionKeys);
  const headed = new Map<string, NarrationGroup>();
  for (const session of read.sessions) {
    if (headed.has(session.sessionKey)) continue;
    headed.set(session.sessionKey, {
      sessionKey: session.sessionKey,
      session,
      messages: [],
      live: live.has(session.sessionKey),
    });
  }
  const headless = new Map<string, NarrationGroup>();
  for (const entry of mergeNarrationEntries(read.entries)) {
    let group = headed.get(entry.sessionKey) ?? headless.get(entry.sessionKey);
    if (!group) {
      group = { sessionKey: entry.sessionKey, session: null, messages: [], live: false };
      headless.set(entry.sessionKey, group);
    }
    group.messages.push(entry);
  }
  return [...headless.values(), ...headed.values()];
}

/** The session keys holding an in-flight step — live only while the plan is
 *  `generating`; every other session is finished. */
export function liveNarrationSessions(review: PlanReviewDto): string[] {
  if (review.status !== 'generating') return [];
  return (review.inFlightSteps ?? []).map((step) => step.sessionKey);
}

/** How many sentences come before the earliest one in hand. `seq` is gapless
 *  from 1, so it is that sentence's `seq − 1`. */
export function narrationEarlierCount(entries: readonly PlanNarrationDto[]): number {
  return entries.length === 0 ? 0 : entries[0]!.seq - 1;
}

/** A group head as the one live region sees it: its line, already in words. */
export interface NarrationHeadLine {
  sessionKey: string;
  line: string;
  live: boolean;
}

/**
 * What a change of heads announces (MOTIR-8061 § Screen readers), or null: a
 * head's line when its group first appears or its step words change, and the
 * finished form when a live session ends. Never a narration sentence. With
 * several changes in one read, the last one in group order is said.
 */
export function nextHeadAnnouncement(
  prev: readonly NarrationHeadLine[],
  next: readonly NarrationHeadLine[],
): { line: string; finished: boolean } | null {
  const before = new Map(prev.map((head) => [head.sessionKey, head]));
  let said: { line: string; finished: boolean } | null = null;
  for (const head of next) {
    const was = before.get(head.sessionKey);
    if (!was || was.line !== head.line) said = { line: head.line, finished: !head.live };
    else if (was.live && !head.live) said = { line: head.line, finished: true };
  }
  return said;
}
