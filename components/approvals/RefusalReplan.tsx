'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { isPlainPrimaryClick } from '@/lib/hooks/useOpenPlanningWorkspace';
import {
  isPickSeedGate,
  isRefusalSeedGate,
  type RefusalSeedGateFacts,
} from '@/lib/planning/refusalSeed';
import { fetchPlanningSeed } from '@/lib/planning/planningSeedClient';
import { useOpenRefusalReplan } from './useOpenRefusalReplan';

// A REFUSAL ASKS, THEN HANDS OFF (Story MOTIR-6068 · Subtask MOTIR-6211; ADR
// `approval-gates.md` §10f and the three §10h rows). Built to
// `design/work-items/approval-control--replan-door.mock.html` (panel 0 — the ask; panels
// 1–5 — the door) and `design/ai-chat/planning-workspace--refusal-seed.mock.html` sheet 1
// (the hand-off), with their sections in the two areas' design notes.
//
// TWO FACES, ONE PLACE. After Request changes on a `decision_approval`, an Overturn on a
// `decision_confirmation` or None of these on a `decision_choice`, the decided record keeps
// a door back to the seeded planner — **Re-plan with AI** — on its own line at the foot of
// the record band. Right after the person who pressed the refusal sees it commit, the same
// place ASKS first (the design gate's amendment of 2026-09-25: *"Let the user confirm he
// wants to go to motir AI to replan the work item."*). Nothing opens until they say yes.
//
// ⚠️ THE ASK IS TRANSIENT CLIENT STATE, held by the PRESS SITE (the approval overlay, or the
// Development frame's own decide) and handed down as `asking`. It is never stored, so a
// reload, another viewer or a later visit sees only the door — and pressing the door later
// IS the yes: there is no second ask.
//
// ⚠️ NO `ApprovalGateDTO` IN THIS FILE. `tests/approval-gate-one-language.test.ts` holds
// every `.tsx` that handles one to rendering the shared frame; this module is a SLOT the
// kind frames fill, never a gate surface of its own, so it takes the gate's facts only.

/** What a kind frame is handed to offer the planner from its decided record. */
export interface RefusalReplanProps {
  /**
   * `WorkItemPlanEntrance`'s own condition for drawing a planning door on the card — the
   * reader may plan (`work_item:edit`) and the card is not archived. False: no door and
   * no ask, and nothing explains the absence (design panel 3: absent means absent).
   */
  canReplan: boolean;
  /** This reader has just pressed the refusal HERE: ask before anything opens. */
  asking?: boolean;
  /** The ask was answered — yes or Not now. The press site forgets it. */
  onAskDone?: () => void;
}

/** The facts the slot reads off the decided gate. */
export type RefusalReplanGateFacts = RefusalSeedGateFacts & {
  decisionSource: 'ui' | 'api' | 'mcp' | 'github' | null;
};

/**
 * Should a press that just RECORDED `gate` ask to re-plan? Only a refusal of the three
 * kinds (`isRefusalSeedGate`, the one predicate the seed read and the session stamp also
 * answer), and never one synced out of GitHub — that was not pressed in Motir at all.
 */
export function asksToReplanAfterPress(gate: RefusalReplanGateFacts): boolean {
  return isRefusalSeedGate(gate) && gate.decisionSource !== 'github';
}

/** The PICK's sibling (story MOTIR-6069 · MOTIR-6436): a Choose pressed in Motir,
 *  with its stamp, ASKS to plan the follow-up. A GitHub-decided gate asks nothing. */
export function asksToPlanAfterPress(
  gate: RefusalReplanGateFacts & { chosenOption: unknown },
): boolean {
  return isPickSeedGate(gate) && gate.decisionSource !== 'github';
}

/** What a press site asks after: a refusal's re-plan OR a pick's follow-up plan. */
export function asksAfterPress(gate: RefusalReplanGateFacts & { chosenOption: unknown }): boolean {
  return asksToReplanAfterPress(gate) || asksToPlanAfterPress(gate);
}

/** Whether the seeded door and ask speak for a refusal (`replan`) or a pick (`plan`). */
export type SeedDoorIntent = 'plan' | 'replan';

/** The door's face — `WorkItemPlanEntrance`'s RE-PLAN face, class for class (design
 *  § *The door is the Re-plan entrance's own face*). */
const DOOR_FACE =
  'inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-btn-x-sm) font-sans text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 border-(--el-border-strong) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)';

/** A pick opens NEW work, so its door is `WorkItemPlanEntrance`'s accent-outlined PLAN
 *  face (design MOTIR-6432), never the subdued Re-plan face above. */
const PLAN_DOOR_FACE =
  'inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-btn-x-sm) font-sans text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 border-(--el-accent) text-(--el-accent-on-surface) hover:bg-(--el-tint-lavender)';

/**
 * **Re-plan with AI** — a real `<Link>` whose `href` is the seeded planner's address, so a
 * ⌘-click opens it in a new tab; a plain click is one address replace through
 * {@link useOpenRefusalReplan}. ONE label in every case: the overlay it opens resumes the
 * reader's recent seeded session by itself (design panel 4).
 */
export function RefusalReplanDoor({
  gateId,
  itemKey,
  focusOnMount = false,
  intent = 'replan',
}: {
  gateId: string;
  itemKey: string;
  /** Not now just replaced the ask with this door: it takes focus (design 0f). */
  focusOnMount?: boolean;
  /** `plan` — a pick's *Plan with AI* door (MOTIR-6436). */
  intent?: SeedDoorIntent;
}) {
  const plan = intent === 'plan';
  const t = useTranslations(plan ? 'approvalGate.planDoor' : 'approvalGate.replanDoor');
  const { hrefFor, open } = useOpenRefusalReplan();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <Link
      ref={ref}
      href={hrefFor(gateId)}
      // Names the work item and contains the visible text (WCAG 2.5.3), as the entrance's
      // `replanAria` does.
      aria-label={t('aria', { item: itemKey })}
      data-testid={plan ? 'pick-plan-door' : 'refusal-replan-door'}
      data-depth="key"
      data-mode={plan ? 'plan' : 'replan'}
      onClick={(event) => {
        if (!isPlainPrimaryClick(event)) return;
        event.preventDefault();
        open(gateId);
      }}
      className={plan ? PLAN_DOOR_FACE : DOOR_FACE}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      {t('label')}
    </Link>
  );
}

/**
 * THE ASK (design panel 0) — the shipped confirm band's grammar (`ApprovalGateControl`'s
 * `confirming` phase: *an inline band over the verbs, never a modal*): a title, two
 * consequence lines, **Not now** (ghost) and **Re-plan with AI** (primary).
 *
 * Focus lands on **Re-plan with AI**, so Enter is yes. **Esc is Not now** — and it must
 * stop there: the approval overlay is a Radix dialog, and Radix listens for Escape in the
 * CAPTURE phase on the document, before any handler on this band would run. So the ask
 * listens one step earlier, in the capture phase on the WINDOW, and stops the event there
 * whenever it comes from inside the band. The overlay stays open on the decided record.
 */
export function RefusalReplanAsk({
  gateId,
  itemKey,
  sectioned,
  onAnswered,
  onNotNow,
  intent = 'replan',
}: {
  gateId: string;
  itemKey: string;
  /** The frame's `section` form — the band is a hairline divider in the host card. */
  sectioned: boolean;
  /** Yes was pressed — the press site forgets the ask as the planner opens. */
  onAnswered: () => void;
  onNotNow: () => void;
  /** `plan` — a pick's ask (MOTIR-6436): the planner STARTS on yes, nothing to send. */
  intent?: SeedDoorIntent;
}) {
  const plan = intent === 'plan';
  const t = useTranslations('approvalGate.replanAsk');
  const tp = useTranslations('approvalGate.planAsk');
  // WHERE the pick's planner opens is resolved on the SERVER (MOTIR-6433's anchor):
  // the ask renders what the seed read returns rather than guessing from the tree.
  // Until it answers, the line waits; a failure leaves it out rather than guess.
  const [anchor, setAnchor] = useState<{ key: string | null } | null>(null);
  useEffect(() => {
    if (!plan) return;
    const controller = new AbortController();
    fetchPlanningSeed(gateId, controller.signal)
      .then((seed) => {
        if (!controller.signal.aborted && seed) setAnchor({ key: seed.anchorKey });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [plan, gateId]);
  const { open } = useOpenRefusalReplan();
  const tHandoff = useTranslations('planningWorkspace.handoff');
  const titleId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  // The latest decline, read by the window listener without re-subscribing it.
  const notNowRef = useRef(onNotNow);
  useEffect(() => {
    notNowRef.current = onNotNow;
  });

  useEffect(() => {
    yesRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (!(target instanceof Node) || !groupRef.current?.contains(target)) return;
      event.stopPropagation();
      event.preventDefault();
      notNowRef.current();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  return (
    <div
      ref={groupRef}
      role="group"
      aria-labelledby={titleId}
      data-testid={plan ? 'pick-plan-ask' : 'refusal-replan-ask'}
      className={cn(
        sectioned && 'mt-3',
        'border-t border-(--el-border-soft) bg-(--el-surface-soft) px-4 py-3',
      )}
    >
      <p id={titleId} className="text-[13px] font-semibold text-(--el-text)">
        {plan ? tp('title') : t('title', { key: itemKey })}
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-(--el-text-secondary)">
        {plan ? (
          <>
            {anchor ? (
              <li>{anchor.key ? tp('opens', { key: anchor.key }) : tp('opensProject')}</li>
            ) : null}
            <li>{tp('nothingToSend')}</li>
          </>
        ) : (
          <>
            <li>{t('opens', { key: itemKey })}</li>
            <li>{t('unsent')}</li>
          </>
        )}
      </ul>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onNotNow}>
          {tHandoff('notNow')}
        </Button>
        <Button
          ref={yesRef}
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            onAnswered();
            open(gateId);
          }}
          leftIcon={<Sparkles className="size-3.5 shrink-0" aria-hidden />}
        >
          {plan ? tp('yes') : t('yes')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The two slots a kind frame fills from one decided gate: the DOOR (its `recordDetail`
 * line) or, while this reader's ask is open, the ASK (the band after the record strip, in
 * the door's place). Both null for any gate that does not offer the planner — any other
 * kind, any other state, or a reader for whom `WorkItemPlanEntrance` would not render.
 */
export function useRefusalReplanSlots({
  gate,
  itemKey,
  replan,
  sectioned,
}: {
  gate: RefusalSeedGateFacts & { id: string; chosenOption?: unknown };
  itemKey: string;
  replan: RefusalReplanProps | undefined;
  sectioned: boolean;
}): { door: ReactNode; ask: ReactNode } {
  // ⚠️ NO NAVIGATION HOOK HERE: every decided frame calls this, and only the door and the
  // ask — mounted when the planner is actually offered — read the address.
  // Not now moves focus to the door that replaces the ask (design 0f) — and only then:
  // an ordinary render of a decided record never steals focus.
  const [focusDoor, setFocusDoor] = useState(false);
  // A refusal re-plans; a PICK plans its follow-up (MOTIR-6436) through the same
  // slots, with its own words and door face.
  const intent: SeedDoorIntent | null = isRefusalSeedGate(gate)
    ? 'replan'
    : isPickSeedGate({ ...gate, chosenOption: gate.chosenOption ?? null })
      ? 'plan'
      : null;
  if (!replan?.canReplan || intent === null) return { door: null, ask: null };
  if (replan.asking) {
    return {
      door: null,
      ask: (
        <RefusalReplanAsk
          gateId={gate.id}
          itemKey={itemKey}
          sectioned={sectioned}
          intent={intent}
          onAnswered={() => replan.onAskDone?.()}
          onNotNow={() => {
            setFocusDoor(true);
            replan.onAskDone?.();
          }}
        />
      ),
    };
  }
  return {
    door: (
      <span className="flex basis-full items-center gap-2">
        <RefusalReplanDoor
          gateId={gate.id}
          itemKey={itemKey}
          focusOnMount={focusDoor}
          intent={intent}
        />
      </span>
    ),
    ask: null,
  };
}
