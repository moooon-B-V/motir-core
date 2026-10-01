import type { AgentsBillingDTO } from '@/lib/dto/billing';

// Pure view-model math for the Agents billing line (MOTIR-6920;
// `design/billing/design-notes.md` "Delta 2026-09-29 — the Agents line",
// `docs/decisions/agent-instance-storage.md` §6). Kept in a non-'use client'
// module — the `ciFigures.ts` / `searchFigures.ts` precedent — so every state is
// unit-testable without mounting the panel.
//
// Like Search, the line has NO METER (agents have no pool to divide by) and NO
// PAUSED STATE (storage is never refused for balance, §2). The only derived
// number is the total, machine + storage.

/** The drawn states of the line (design-notes delta, panels 2–3). */
export type AgentLineVariant =
  /** A paid AI plan: the figure band, zero or not — shown, never hidden. */
  | 'figures'
  /** No paid AI plan and nothing charged: the one sentence, no figures. */
  | 'no_plan'
  /** No paid AI plan but agents still charged (the plan lapsed): band + note. */
  | 'no_plan_with_charges'
  /** The boundary reported no agent blocks: an em-dash per figure, never `0`. */
  | 'unavailable';

export interface AgentLineFigures {
  variant: AgentLineVariant;
  /** `null` when unavailable. */
  machine: number | null;
  storage: number | null;
  total: number | null;
  /** True when this month's figures are all zero — selects the zero sentence. */
  nothingCharged: boolean;
  /** Whether to show the "Agents need a paid AI plan" note. */
  showNoPlanNote: boolean;
  /** Whether the figure band renders at all. */
  showFigures: boolean;
}

export function agentLineFigures(agents: AgentsBillingDTO): AgentLineFigures {
  // ⚠️ `null` is UNAVAILABLE and is checked FIRST, so it never falls through
  // into the zero branch. "We could not fetch this" and "you spent nothing" are
  // opposite messages.
  if (agents.spend === null) {
    return {
      variant: 'unavailable',
      machine: null,
      storage: null,
      total: null,
      nothingCharged: false,
      // The plan is known even when the figures are not.
      showNoPlanNote: !agents.hasPaidAiPlan,
      showFigures: true,
    };
  }

  const { machineMonthSpend: machine, storageMonthSpend: storage } = agents.spend;
  const total = machine + storage;
  const nothingCharged = total === 0;

  if (!agents.hasPaidAiPlan) {
    // A lapsed plan with agents still existing is state (d): their charges are
    // real, so they show — with the note beneath them.
    if (!nothingCharged) {
      return {
        variant: 'no_plan_with_charges',
        machine,
        storage,
        total,
        nothingCharged,
        showNoPlanNote: true,
        showFigures: true,
      };
    }
    return {
      variant: 'no_plan',
      machine,
      storage,
      total,
      nothingCharged,
      showNoPlanNote: true,
      showFigures: false,
    };
  }

  return {
    variant: 'figures',
    machine,
    storage,
    total,
    nothingCharged,
    showNoPlanNote: false,
    showFigures: true,
  };
}
