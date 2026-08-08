import { normalizeServerUrl } from './config/userConfig.js';
import type { PlanProposal, PlanSession, PlanTurn, PlanWithItems, PlanOutcome } from './client.js';

// The PURE layer behind `motir plan` (Story 7.9 · Subtask 7.9.9 · MOTIR-887):
// argument shaping, the interactive loop's input grammar, the watch decision,
// and every renderer. No I/O, no MCP, no stdout — the same split `autoLoop.ts`
// has from `commands/auto.ts`, so the conversation's behaviour is unit-testable
// without a terminal.
//
// ── The model this layer serves ─────────────────────────────────────────────
// Planning in Motir is a persisted, resumable, multi-turn CONVERSATION, not a
// one-shot prompt: a `PlanChangeSession` (one per project per anchor set) plus
// ordered turns that ACCUMULATE until they are submitted as ONE accumulated
// intent (Story 7.30 · MOTIR-1728, reached over MCP by MOTIR-1832). The CLI is a
// CLIENT of that thread and never the owner of a parallel one — it addresses the
// thread by SCOPE (project, or project + anchor keys), which is why every
// renderer here takes a server-returned session rather than any locally
// accumulated state. A turn typed in the terminal is on the same row the web
// panel renders, and quitting can therefore never lose one.
//
// ── The gate every renderer in this file holds ──────────────────────────────
// A submit produces a Plan of PROPOSALS. `approvePlan` — in Motir, not here — is
// the only path from a proposal to a `work_item` row, and an `add`'s
// `workItemKey` stays null until then. So nothing here may render "created N
// items"; {@link PROPOSALS_NOT_WORK_ITEMS} is printed with every proposal tree
// and is the same wording the `get_plan` / `expand_item` tools carry.

/** `PROD-7` / `motir-1832` — a work-item identifier, the anchor form. */
export const WORK_ITEM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** How long a non-detached submit waits for the planner before giving up. */
export const WATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** How often the watch asks `get_plan_status` while the plan is generating. */
export const WATCH_POLL_MS = 3_000;

/** The statement that must accompany every rendered proposal set. */
export const PROPOSALS_NOT_WORK_ITEMS =
  'These are PROPOSALS, not work items. Nothing above exists in the tree yet — ' +
  'approving the plan in Motir is the only thing that creates one.';

// ── argument shaping ────────────────────────────────────────────────────────

export interface PlanArgs {
  /** The anchor set, uppercased and deduped. Empty = the project-wide thread. */
  targetKeys: string[];
  /** The one-shot turn body, or null for the interactive conversation. */
  text: string | null;
}

/**
 * Split `motir plan [KEY...] [text...]` into an anchor set and a one-shot body.
 *
 * LEADING arguments that look like work-item identifiers are anchors; everything
 * from the first non-key onward is the turn body, joined back with spaces (so an
 * unquoted sentence works as well as a quoted one). The discriminator is the KEY
 * SHAPE rather than a flag because that is how every other Motir surface
 * addresses an item, and a planning turn that happens to be exactly `PROD-7` and
 * nothing else is not a sentence anyone types.
 *
 * The anchor SET is the thread's identity, so order and duplicates are
 * irrelevant — the server canonicalizes them. They are deduped here anyway, so
 * the terminal's own label matches the thread it opened.
 */
export function parsePlanArgs(args: string[]): PlanArgs {
  const targetKeys: string[] = [];
  let index = 0;
  while (index < args.length && WORK_ITEM_KEY.test(args[index]!.trim())) {
    const key = args[index]!.trim().toUpperCase();
    if (!targetKeys.includes(key)) targetKeys.push(key);
    index += 1;
  }
  const text = args.slice(index).join(' ').trim();
  return { targetKeys, text: text.length > 0 ? text : null };
}

// ── the interactive loop's input grammar ────────────────────────────────────

/** What one line typed at the conversation prompt means. */
export type PlanInput =
  /** Send the accumulated intent as one job. */
  | { kind: 'submit' }
  /** Leave — the thread (and every turn on it) stays server-side. */
  | { kind: 'exit' }
  /** Print the in-loop command list. */
  | { kind: 'help' }
  /** An empty line: re-prompt, append nothing. */
  | { kind: 'none' }
  /** A `/word` that is not a command — refuse rather than append it as prose. */
  | { kind: 'unknown'; input: string }
  /** Ordinary text: one more turn on the thread. */
  | { kind: 'turn'; body: string };

/**
 * Classify one line of input. `null` is END OF INPUT (Ctrl-D or a closed pipe)
 * and reads as `/exit`: the turns are already server-side, so the honest
 * response to a closed stream is to leave the thread intact, never to submit
 * something the user did not ask to send.
 *
 * An unrecognized slash word is REFUSED rather than appended. Silently turning a
 * mistyped `/sumbit` into a planning turn would put a command in the intent that
 * gets sent to the planner — the one input mistake with a cost.
 */
export function classifyInput(line: string | null): PlanInput {
  if (line === null) return { kind: 'exit' };
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'none' };
  if (!trimmed.startsWith('/')) return { kind: 'turn', body: trimmed };
  const word = trimmed.slice(1).toLowerCase();
  if (word === 'submit' || word === 'send') return { kind: 'submit' };
  if (word === 'exit' || word === 'quit') return { kind: 'exit' };
  if (word === 'help' || word === '?') return { kind: 'help' };
  return { kind: 'unknown', input: trimmed };
}

/** The in-loop command list (`/help`, and the banner shown on entry). */
export function loopCommands(): string {
  return [
    '  Type what you want changed about the plan; press Enter to add it as a turn.',
    '  Turns ACCUMULATE — nothing reaches the planner until you submit.',
    '',
    '  /submit   send every turn on this thread as ONE change',
    '  /exit     leave; the thread and its turns stay saved',
    '  /help     this list',
  ].join('\n');
}

// ── URLs ────────────────────────────────────────────────────────────────────

/** Where a project that has never been planned starts: the web onboarding
 *  interview. Built from the link's server — no hardcoded host. */
export function onboardingUrl(serverUrl: string): string {
  return `${normalizeServerUrl(serverUrl)}/onboarding`;
}

// ── the thread ──────────────────────────────────────────────────────────────

/** How a thread names itself: the project, or the items it is anchored at. */
export function scopeLabel(targetKeys: string[]): string {
  return targetKeys.length > 0 ? `anchored at ${targetKeys.join(', ')}` : 'project-wide';
}

/** What the planner is called on screen — the rail's own `Motir AI` label. */
const PLANNER = 'Motir AI';

/**
 * How the terminal names the author of one turn.
 *
 * THREE authors, not two (MOTIR-2397). The planner writes real turns on this
 * thread — a findings report on every planning turn, and the one Gate-2
 * clarifying question (MOTIR-2222) — so labelling everything that is not a
 * submission marker as `you` put the user's name on the planner's words in the
 * one CLI surface that is a conversation.
 *
 * The two sub-labels are the terminal's carry of `MOTIR-2225`'s design, not a
 * second design: `asking` is the label slot that design fills on a question
 * bubble, and `answer` is the label it gives the user turn that replied.
 */
export function turnMarker(turn: PlanTurn): string {
  if (turn.role === 'system') return `submitted → job ${turn.jobId ?? '?'}`;
  if (turn.role === 'assistant') return turn.question === null ? PLANNER : `${PLANNER} · asking`;
  return turn.isAnswer ? 'you · answer' : 'you';
}

/** One turn, ordinal-prefixed, with continuation lines aligned under the body.
 *  Full text — never truncated: this is the user's own intent, and a resumed
 *  thread that shows an excerpt reads as if something was lost. */
export function renderTurn(turn: PlanTurn, ordinal: number): string {
  const head = `  ${String(ordinal).padStart(2)}. [${turnMarker(turn)}] `;
  const indent = ' '.repeat(head.length);
  const [first = '', ...rest] = turn.body.split('\n');
  return [head + first, ...rest.map((line) => indent + line)].join('\n');
}

// ── the thread that is WAITING on you (MOTIR-2397, design states B / C / E) ──
// Ported from the shipped `lib/planning/planChangeThread.ts`, which the web rail
// reads, so the two surfaces of ONE thread cannot disagree about whether it is
// waiting. The CLI is a published package and cannot import the app's `lib/`, so
// this is a deliberate port rather than a shared module; keep the two in step.

/**
 * The question the thread is currently waiting on, or null when it is not
 * waiting.
 *
 * AWAITING IS DERIVED, never remembered by the client: the thread is waiting
 * exactly when THE LAST PLANNER TURN IS A QUESTION WITH NO USER TURN AFTER IT.
 * Scanning from the END makes both closing conditions fall out of one pass — the
 * first `user` turn seen means whatever question preceded it is already disposed
 * of (answered or superseded), and the first `assistant` turn seen is the latest
 * planner turn, which is a question only if it carries one. A `system` marker is
 * provenance, not conversation, and neither opens nor closes the state.
 *
 * Deriving it is what makes a RESUMED terminal thread come back to the identical
 * state hours later: the transcript it reads has not changed.
 */
export function pendingQuestion(turns: readonly PlanTurn[]): PlanTurn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.role === 'user') return null;
    if (turn.role === 'assistant') return turn.question === null ? null : turn;
  }
  return null;
}

/** How a question that is no longer pending was DISPOSED of. */
export type QuestionDisposition = 'answered' | 'superseded';

/**
 * The disposition marker owed BENEATH the turn at `index`, or null.
 *
 * Owed by the USER turn that closed a question — not by the question itself —
 * because that is the moment the thread changed direction. `answered` when the
 * user replied to it; `superseded` when they changed the subject and the planner
 * carried on with the original request. The distinction is RECORDED at send time
 * (`isAnswer`), never inferred from the words.
 */
export function dispositionMarkerFor(
  turns: readonly PlanTurn[],
  index: number,
): QuestionDisposition | null {
  const turn = turns[index];
  if (!turn || turn.role !== 'user') return null;
  if (!pendingQuestion(turns.slice(0, index))) return null;
  return turn.isAnswer ? 'answered' : 'superseded';
}

/** The disposition's own line, in the design's wording. A superseded question is
 *  MARKED, never dropped: the reader has to be able to see later WHY a plan
 *  rests on an assumption they never confirmed. */
function renderDisposition(disposition: QuestionDisposition): string {
  return disposition === 'answered'
    ? '      ↳ Answered — planning resumed.'
    : `      ↳ Not answered — ${PLANNER} carried on with what you asked.`;
}

/**
 * The block that says the thread is BLOCKED ON YOU, or null when it is not.
 *
 * The terminal's form of the design's answer bar. That bar carries the state on
 * three cues, none of them colour, and all three survive the translation: a WORD
 * (*Waiting for your answer*), a GLYPH (`[?]`, standing in for the question
 * icon), and a POSITION — the bar sits against the input, and this block is the
 * last thing printed before the prompt is offered.
 *
 * The third line is the terminal's carry of the two affordances the web changes
 * and a CLI has no equivalent of (the composer's *Answer Motir AI…* placeholder
 * and the Send button relabelled *Answer*): the loop is unchanged, so an answer
 * is an ordinary turn, and saying so is what stops a question from reading as
 * narration nobody replies to.
 */
export function renderAwaiting(turns: readonly PlanTurn[]): string | null {
  const asking = pendingQuestion(turns);
  if (!asking) return null;
  return [
    '  [?] Waiting for your answer',
    ...(asking.question ?? '').split('\n').map((line) => `      ${line}`),
    '      Type your answer as the next turn; nothing is sent until /submit.',
  ].join('\n');
}

/**
 * The whole thread as a transcript, headline first.
 *
 * A RESUMED thread must not look like nothing happened (the acceptance
 * contract), so this always states the turn count and the last submission, and
 * prints every existing turn before the prompt is offered.
 */
export function renderThread(session: PlanSession): string {
  const resumed = session.turnCount > 0;
  const lines = [
    `${resumed ? 'Resumed' : 'Opened'} the planning conversation (${scopeLabel(
      session.targetKeys,
    )}) — ${session.turnCount} turn${session.turnCount === 1 ? '' : 's'}.`,
    session.lastSubmittedAt
      ? `Last submitted ${session.lastSubmittedAt}${
          session.lastJobId ? ` as job ${session.lastJobId}` : ''
        }.`
      : 'Never submitted — nothing has been sent to the planner yet.',
  ];
  if (session.turns.length > 0) {
    lines.push('');
    session.turns.forEach((turn, i) => {
      lines.push(renderTurn(turn, i + 1));
      // The question's disposition rides under the turn that CLOSED it, which is
      // where the design draws it and where the transcript actually changed
      // direction.
      const disposition = dispositionMarkerFor(session.turns, i);
      if (disposition) lines.push(renderDisposition(disposition));
    });
  }
  // LAST, so it sits against the prompt: the terminal's form of a bar pinned to
  // the composer. A resumed thread that is blocked on the user must say so, or
  // the question reads as narration and the plan silently never comes.
  const awaiting = renderAwaiting(session.turns);
  if (awaiting) lines.push('', awaiting);
  return lines.join('\n');
}

// ── the watch ───────────────────────────────────────────────────────────────

/** What the watch should do with one `get_plan_status` reading. */
export type WatchVerdict =
  /** Still generating and the job is alive — poll again. */
  | { kind: 'pending' }
  /** The plan left `generating` — read its proposals. */
  | { kind: 'ready' }
  /** The job died, or motir-ai could not be asked. Carries the server's own
   *  code + message, verbatim. */
  | { kind: 'failed'; code: string; message: string; reachable: boolean };

/**
 * Decide the watch's next move from one outcome reading.
 *
 * The FAILED case is why this watch cannot simply poll the plan's status: a
 * failed job leaves its plan sitting at `generating` FOREVER (the
 * `PlanOutcomeDto` contract), so a status-only loop would spin until the
 * timeout on a job that is already dead. `job.reachable === false` is the
 * separate "we could not ask motir-ai" case, which is equally terminal for a
 * bounded watch and is reported as such rather than as a job failure.
 */
export function watchVerdict(outcome: PlanOutcome): WatchVerdict {
  if (outcome.status !== 'generating') return { kind: 'ready' };
  const job = outcome.job;
  if (!job) return { kind: 'pending' };
  if (!job.reachable) {
    return {
      kind: 'failed',
      reachable: false,
      code: job.failure?.code ?? 'AI_UNREACHABLE',
      message: job.failure?.message ?? 'motir-ai could not be reached.',
    };
  }
  if (job.status === 'failed' || job.status === 'canceled') {
    return {
      kind: 'failed',
      reachable: true,
      code: job.failure?.code ?? `JOB_${job.status.toUpperCase()}`,
      message: job.failure?.message ?? `The planning job ${job.status}.`,
    };
  }
  return { kind: 'pending' };
}

// ── the proposals ───────────────────────────────────────────────────────────

/** The intra-plan temp-ref prefix (`lib/plans/refs.ts`): a `parentRef` pointing
 *  at another `add` in the SAME plan, rather than at a real work item. */
const TEMP_REF_PREFIX = 'planItem:';

/** The op markers the plan review surface uses. */
const OP_MARKER = { add: '+', modify: '~', remove: '-' } as const;

/** ` (3 pts · 40m)` — the leaf sizing a proposal carries, when it carries any. */
function sizing(points: number | null | undefined, minutes: number | null | undefined): string {
  const parts: string[] = [];
  if (points != null) parts.push(`${points} pts`);
  if (minutes != null) parts.push(`${minutes}m`);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** ` · blocked_by: <ref>` — the proposed dependency edges, verbatim (a real
 *  work-item id or an intra-plan temp-ref). */
function blockers(refs: string[] | undefined): string {
  return refs && refs.length > 0 ? ` · blocked_by: ${refs.join(', ')}` : '';
}

/** One proposal as a single line: the op, what it targets, and its sizing. */
export function describeProposal(item: PlanProposal): string {
  const marker = OP_MARKER[item.op] ?? '?';
  if (item.op === 'add') {
    const fields = item.proposedFields;
    const kind = fields?.kind ?? 'task';
    const type = fields?.type ? `/${fields.type}` : '';
    return (
      `${marker} [${kind}${type}] ${fields?.title ?? '(untitled)'}` +
      sizing(fields?.storyPoints, fields?.estimateMinutes) +
      blockers(item.blockedByRefs)
    );
  }
  const target = item.workItemKey ?? '(no target)';
  if (item.op === 'remove') return `${marker} remove ${target}`;
  const changed = Object.keys(item.patch ?? {}).filter(
    (key) => (item.patch as Record<string, unknown>)[key] !== undefined,
  );
  return (
    `${marker} modify ${target}` +
    (changed.length > 0 ? ` — ${changed.join(', ')}` : '') +
    blockers(item.blockedByRefs)
  );
}

/**
 * The proposals as an indented tree, mirroring the server's own nesting rule
 * (`lib/mcp/tools/getPlan.ts`) so the terminal and Motir agree on the shape.
 *
 * Nesting follows `parentRef`, but ONLY its intra-plan temp-ref form: a
 * `parentRef` naming a REAL work item places the proposal under something that
 * already exists OUTSIDE this plan, so it renders at the top level, where a
 * reader expects a new branch hanging off the live tree. `modify` / `remove`
 * carry no `parentRef` and sit at the top level for the same reason.
 */
export function renderProposalTree(items: PlanProposal[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenOf = new Map<string, PlanProposal[]>();
  const roots: PlanProposal[] = [];
  for (const item of items) {
    const ref = item.parentRef;
    const parentId =
      ref && ref.startsWith(TEMP_REF_PREFIX) ? ref.slice(TEMP_REF_PREFIX.length) : null;
    if (parentId != null && byId.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(item);
      else childrenOf.set(parentId, [item]);
    } else {
      roots.push(item);
    }
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (item: PlanProposal, depth: number): void => {
    // Defensive: a temp-ref CYCLE has no root and would otherwise recurse
    // forever. The server rejects one at the boundary, so this is a backstop.
    if (seen.has(item.id)) return;
    seen.add(item.id);
    lines.push(`${'  '.repeat(depth + 1)}${describeProposal(item)}`);
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Anything a cycle kept out of the root set is still the caller's data — print
  // it rather than silently dropping proposals from a list the reader trusts.
  for (const item of items) walk(item, 0);
  return lines;
}

/**
 * The whole plan as the terminal shows it: the plan's own line, its proposal
 * tree, and the PROPOSALS-NOT-WORK-ITEMS statement — which is not decoration.
 * These lines read exactly like work items (titles, kinds, sizing) and are not
 * work items, and the failure mode this guards against is a client reporting
 * work it never created.
 */
export function renderPlan(plan: PlanWithItems): string {
  const lines = [
    `Plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal${
      plan.itemCount === 1 ? '' : 's'
    }.`,
  ];
  if (plan.title) lines.push(`Title: ${plan.title}`);
  if (plan.summary) lines.push(`Summary: ${plan.summary}`);
  lines.push('');
  if (plan.items.length === 0) {
    lines.push(
      plan.status === 'generating'
        ? 'No proposals have arrived yet — the planner is still generating this plan.'
        : 'This plan bundles no proposals.',
    );
  } else {
    lines.push(
      'Proposals (indented under their proposed parent):',
      ...renderProposalTree(plan.items),
    );
  }
  lines.push('', PROPOSALS_NOT_WORK_ITEMS);
  return lines.join('\n');
}

/** What to do next, after a plan has been shown: refine, or go approve. */
export function nextStepHint(reviewUrl: string | null, anchored: string[]): string {
  const resume = anchored.length > 0 ? `motir plan ${anchored.join(' ')}` : 'motir plan';
  return [
    'Next:',
    `  • refine  — \`${resume}\` adds another turn to the same conversation`,
    `  • approve — ${reviewUrl ?? 'open the plan in Motir'}`,
  ].join('\n');
}
