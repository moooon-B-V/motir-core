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
// AI conversation surface — the `PlanningWorkspace`, an OVERLAY on the page you
// are already on since MOTIR-4725 — and every action here carries the SAME href.
// ⚠️ THE HREF IS NOW PASSED IN rather than resolved here (MOTIR-4730): it
// depends on the CURRENT address, which only a component can read
// (`useOpenPlanningWorkspace`), and this module is deliberately framework-free.
// The property that mattered is untouched — one href, shared by every row — it
// is simply computed one level up. The callout is not a mode
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
//
// "Debug with Motir AI" (MOTIR-7050) is the third row and has no gate of its
// own: the orb is mounted only where `showPlanWithAi` holds (Motir AI
// configured, an active project, `ai:plan`), which is exactly who may send a
// debug turn — so it is never dimmed and never absent on its own.

/**
 * The icon a row's tile carries. A NAME, not a component, so this module stays
 * framework-free; `AiCalloutMenu` maps the name to its lucide glyph through an
 * exhaustive record. The three names the design reserves are all mapped
 * already, so adding either future action needs no component change.
 */
export type AiCalloutIcon = 'sparkles' | 'message-circle-question' | 'bug' | 'wrench';

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
  /**
   * TEXT the row puts in the composer, UNSENT (MOTIR-7050) — a `shell` key, or
   * absent for a row that opens the surface as it is. It is a pre-fill and never
   * a send, and never a mode: the href stays the one every row shares, the words
   * are Motir's own template for the person to finish, and what the turn turns
   * out to be is still the server's reading of what they send
   * (`conversation-turn-intent.md` §5, AMENDMENT 1 · A1.3).
   */
  prefillKey?: string;
}

/**
 * The callout's own name, in the `shell` namespace. It is the ORB's accessible
 * name ("Motir AI") and the menu's header; shared from here so the trigger and
 * the panel can never drift apart. "Plan with AI" no longer names the orb — it
 * names the row inside the menu.
 */
export const AI_CALLOUT_NAME_KEY = 'aiCallout.name';

/**
 * The ordered actions the callout offers. Order is the design's: the first
 * action is the PRIMARY one (the menu marks it by its filled icon tile AND its
 * position), the rest follow as their capabilities land.
 *
 * `href` is the one destination every row shares — the overlay address for the
 * page the callout is open on, resolved by the caller
 * (`useOpenPlanningWorkspace`) because it depends on the current URL.
 */
export function aiCalloutActions(href: string): AiCalloutAction[] {
  return [
    {
      id: 'plan',
      icon: 'sparkles',
      titleKey: 'aiCallout.actions.plan.title',
      descriptionKey: 'aiCallout.actions.plan.description',
      href,
    },
    {
      id: 'ask',
      icon: 'message-circle-question',
      titleKey: 'aiCallout.actions.ask.title',
      descriptionKey: 'aiCallout.actions.ask.description',
      // The SAME `href`, deliberately. A question and a plan change are two
      // intents of one conversation, and the intent is resolved per TURN by the
      // server — so this row advertises a capability, it does not choose one.
      href,
    },
    {
      id: 'debug',
      icon: 'bug',
      titleKey: 'aiCallout.actions.debug.title',
      descriptionKey: 'aiCallout.actions.debug.description',
      // The SAME `href` again (MOTIR-7050). The row's one difference is the
      // two-line template it leaves in the composer — "what happens / what should
      // happen instead" — which the person fills in and sends themselves. It
      // sends nothing: the report widget's accept is the only seeded SEND (A1.3).
      prefillKey: 'aiCallout.actions.debug.prefill',
      href,
    },
    // MOTIR-1344 — { id: 'help', icon: 'wrench', … href } takes position 4.
  ];
}
