// The "M" universal AI callout — its ACTION REGISTRY (MOTIR-1812 / Story 7.24;
// design @ `design/ai-chat/design-notes.md` §"The 'M' universal AI callout" +
// `ai-callout-menu.mock.html`).
//
// The floating orb (`components/planning/PlanWithAIFab.tsx`) opens a small
// anchored menu — "the home of all AI" — and this module is that menu's pure
// core: it maps the callout's originating context to the ORDERED list of
// actions the menu renders. Framework-free (no React, no `server-only`), a
// sibling of `lib/planning/launcher.ts`, so it runs identically in the menu
// component and in unit tests.
//
// ⭐ EVERY ROW OPENS THE SAME SURFACE (Yue, 2026-08-01). Motir has exactly one
// AI conversation surface — the `PlanningWorkspace` at `/planning`
// (MOTIR-1729) — and every action here resolves to the SAME context-derived
// href via the shipped `planningWorkspaceHref()`. The callout is not a mode
// picker and not a router: it is a CAPABILITY LIST, an answer to "what can I
// ask this thing?". The row the user picks does not narrow what the
// conversation can be about, because the topic is chosen — and re-chosen —
// inside the thread. So: one href, shared by every row; a row is a LABEL, not
// a route.
//
// ⭐ AN ACTION WHOSE CAPABILITY HAS NOT LANDED IS SIMPLY NOT REGISTERED — never
// a dimmed / disabled / "Coming soon" row (the forbidden variant in the
// design's panel 3). A dead row is a promise the product cannot keep, it costs
// a tab stop and a screen-reader announcement, and it makes the interim state
// feel broken rather than young. So the menu ships with ONE row today, and
// "Ask about this project" (MOTIR-1343) / "Help with a task" (MOTIR-1344) each
// arrive as a SINGLE ENTRY below plus their two `shell.aiCallout.*` message
// keys — no change to `AiCalloutMenu` or to the orb.

import { planningWorkspaceHref, type PlanningLaunchContext } from './launcher';

/**
 * The icon a row's tile carries. A NAME, not a component, so this module stays
 * framework-free; `AiCalloutMenu` maps the name to its lucide glyph through an
 * exhaustive record. The three names the design reserves are all mapped
 * already, so adding either future action needs no component change.
 */
export type AiCalloutIcon = 'sparkles' | 'message-circle-question' | 'wrench';

/**
 * One row of the callout menu. `titleKey` / `descriptionKey` are resolved
 * against the `shell` i18n namespace (`useTranslations('shell')`), the same
 * namespace that holds the orb's own label.
 */
export interface AiCalloutAction {
  /** Stable id — the row's test hook and React key. */
  id: string;
  icon: AiCalloutIcon;
  titleKey: string;
  descriptionKey: string;
  /** Where the row goes. The SAME href for every action — see the note above. */
  href: string;
}

/**
 * The callout's own name, in the `shell` namespace. It is the ORB's accessible
 * name ("Motir AI") and the menu's header; shared from here so the trigger and
 * the panel can never drift apart. "Plan with AI" no longer names the orb — it
 * names the row inside the menu.
 */
export const AI_CALLOUT_NAME_KEY = 'aiCallout.name';

/**
 * The ordered actions the callout offers from `context`. Order is the design's:
 * the first action is the PRIMARY one (the menu marks it by its filled icon
 * tile AND its position), the rest follow as their capabilities land.
 */
export function aiCalloutActions(context: PlanningLaunchContext): AiCalloutAction[] {
  // One destination, resolved once: every row is a door to the one workspace.
  const href = planningWorkspaceHref(context);

  return [
    {
      id: 'plan',
      icon: 'sparkles',
      titleKey: 'aiCallout.actions.plan.title',
      descriptionKey: 'aiCallout.actions.plan.description',
      href,
    },
    // MOTIR-1343 — { id: 'ask', icon: 'message-circle-question', … href }
    // MOTIR-1344 — { id: 'help', icon: 'wrench', … href }
  ];
}
