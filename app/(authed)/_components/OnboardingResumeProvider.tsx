'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchPreplanState } from '@/lib/onboarding/preplanClient';
import { isPreplanInProgress } from '@/lib/onboarding/resumeVisibility';

// OnboardingResumeProvider — the ONE client island behind the labeled "Resume
// onboarding" re-entry door (MOTIR-1533; design MOTIR-1548). It resolves the
// "does the active project have an in-progress onboarding?" signal ONCE and
// shares it via context, so both consumers — the SidebarNav rail row and the ⌘K
// AppCommandPalette action — read the same boolean without each firing its own
// `/api/ai/pre-plan` request.
//
// The expensive half (the pre-plan session read) is deliberately a client fetch
// rather than a layout-level server read: the alternative would add a motir-ai
// round-trip to EVERY authed page's server render. So the (authed) layout
// resolves only the cheap server gate (`resumeGateEnabled` — AI configured, an
// active project, `onboardingRanAt == null`) and passes it as `enabled`; the
// provider fetches the session state only when that gate is open, and stays
// silent (never fetches) otherwise. `isMotirAiConfigured()` is `server-only`, so
// the config half MUST arrive as this prop — it cannot be read here.

const OnboardingResumeContext = createContext<boolean>(false);

/** Whether to show the "Resume onboarding" door — true only when the active
 *  project has a live, un-finished onboarding session. */
export function useOnboardingResume(): boolean {
  return useContext(OnboardingResumeContext);
}

export interface OnboardingResumeProviderProps {
  /**
   * The server-cheap gate (`resumeGateEnabled`), resolved in the (authed)
   * layout. When false the provider never fetches and the door stays hidden.
   */
  enabled: boolean;
  children: ReactNode;
}

export function OnboardingResumeProvider({ enabled, children }: OnboardingResumeProviderProps) {
  const [inProgress, setInProgress] = useState(false);

  useEffect(() => {
    // Gate closed → don't fetch. No setState needed here: the provided value
    // below is `enabled && inProgress`, so a stale `inProgress` from a previous
    // project is already masked to false while the gate is closed (and this
    // avoids a synchronous setState in the effect body).
    if (!enabled) return;
    // Race-safe single read (mirrors useDiscoveryChat's guarded hydrate): a
    // per-effect AbortController + an `active` flag so a resolved response from a
    // superseded/unmounted effect never sets state. A failed / aborted fetch
    // resolves to null → not in progress.
    const controller = new AbortController();
    let active = true;
    void fetchPreplanState(controller.signal)
      .then((state) => {
        if (active) setInProgress(isPreplanInProgress(state));
      })
      .catch(() => {
        if (active) setInProgress(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled]);

  return (
    <OnboardingResumeContext.Provider value={enabled && inProgress}>
      {children}
    </OnboardingResumeContext.Provider>
  );
}
