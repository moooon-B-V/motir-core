'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AccountSecurityPanes } from '../../../(authed)/settings/account/_components/AccountSecurityPanes';
import type { ComponentProps } from 'react';

// The enrolment surface, WIRED TO THE GATE (Story MOTIR-1215 · Subtask MOTIR-3648).
//
// ⚠️ WHAT THIS FIXES, AND WHY THE SCREEN IS BROKEN WITHOUT IT. `/two-factor-required`
// is a Server Component: it asks `resolveRequirement` once, at render. The panes
// it mounts are a client island that deliberately does not `router.refresh()`
// (`AccountSecurityPanes`' own header — a refresh cannot reach a `useState`
// initializer, and on the account pane it would cause the revert
// `inline-edit-no-tree-refresh` records). Put those two facts together and a
// person on this screen enrols SUCCESSFULLY and nothing happens: the island
// updates, the server verdict does not, and they are left on a held screen with
// no way forward — the exact dead end `design/auth/design-notes.md`'s panel 6
// ("Satisfied — the return to the route they actually asked for") exists to
// prevent, and the thing the story's own verification recipe step 3 asks for.
//
// So this island subscribes to the ONE transition that matters and refreshes the
// route on it. The server then re-asks, sees a compliant person, and renders the
// satisfied panel with its Continue.
//
// ⚠️ A REFRESH, NOT A PUSH. Sending the browser straight to the destination here
// would take the person away the instant a credential lands — before they can
// save the recovery codes the panes offer, and before they see that it worked.
// The asset draws a screen with a Continue on it; the person leaves when they
// say so.
export function HeldEnrolment(
  props: Omit<ComponentProps<typeof AccountSecurityPanes>, 'onSecondFactorChange'>,
) {
  const router = useRouter();

  const onSecondFactorChange = useCallback(
    (hasSecondFactor: boolean) => {
      // Only the arrival. Losing a factor while ON this screen would already be
      // held state, and re-rendering the same held screen is noise.
      if (hasSecondFactor) router.refresh();
    },
    [router],
  );

  return <AccountSecurityPanes {...props} onSecondFactorChange={onSecondFactorChange} />;
}
