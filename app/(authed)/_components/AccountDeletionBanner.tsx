import { getLocale, getTranslations } from 'next-intl/server';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { AccountDeletionBannerBar } from './AccountDeletionBannerBar';

// THE APP-WIDE DELETION BANNER — `design/settings/account-data.mock.html`
// PANEL 5's top bar, and the SECOND of design DECISION 4's two cancel doors
// (Story 8.4 · Subtask MOTIR-3704).
//
// ── IT IS THE LOAD-BEARING HALF, NOT A POLISH ITEM ──────────────────────────
// The product already holds the doctrine this rests on:
// `docs/decisions/code-graph-index-fleet.md` §14.3 gives a workspace
// hard-delete NO grace period, and states why — *"a grace period the user
// cannot reach is not a grace period"*. An account deletion is the mirror case:
// the reader's own credentials survive the window, so signing in IS a surface to
// undo into, and the window is real. **But a window is only reachable if the
// reader can FIND it.** Somebody who changes their mind on day nine opens the
// app; they do not think to navigate to Settings › Data & privacy. Without this
// banner the 30-day window exists only in the database.
//
// ── MOUNTED ONCE, IN THE SHELL ──────────────────────────────────────────────
// In `app/(authed)/layout.tsx`, above the top nav, from ONE server read — not
// per page. "On every page" is a property of the layout, and asking each route
// to remember to render it would make the guarantee a convention.
//
// ── THE PAGE-STATE ROUTE, AND WHY THIS ONE ──────────────────────────────────
// A SERVER-RENDERED SHELL SLOT (CLAUDE.md's page-state contract, route 2), NOT
// a client island seeded at mount. The card that specifies this surface names
// the exact failure to avoid: *"a cancel that leaves a stale 'your account will
// be deleted' banner on screen"*. An island seeded from `useState(initialProps)`
// is unreachable by `router.refresh()` — its initializer runs once — so the
// pane's cancel would repaint the pane and leave this bar standing. Server-
// rendered, one `router.refresh()` from either door re-runs THIS read and the
// bar goes.
//
// Its own button additionally removes the bar OPTIMISTICALLY (route 3's local
// remove, legitimate because that mutation fires from inside the island itself)
// — that is a latency affordance on top of the route above, not the mechanism.
// `AccountDeletionBannerBar` carries the split.
//
// ⚠️ THE READ IS CHEAP AND IT IS ON EVERY AUTHED REQUEST. `findOpenDeletion` is
// one indexed lookup on `account_deletion_request` by `user_id`, inside the
// bound transaction its RLS policy requires — and it runs in the layout's
// existing parallel read wave rather than serially in front of it.

export interface AccountDeletionBannerProps {
  userId: string;
}

export async function AccountDeletionBanner({ userId }: AccountDeletionBannerProps) {
  const request = await accountDeletionService.findOpenDeletion(userId);
  if (!request) return null;

  const [t, locale] = await Promise.all([
    getTranslations('settings.account.data'),
    getLocale() as Promise<Locale>,
  ]);

  return (
    <AccountDeletionBannerBar
      // From the ROW, never recomputed: somebody who scheduled on Monday is told
      // Monday's deadline on Thursday, and the literal `30` appears nowhere.
      message={t('banner.scheduled', { date: formatDate(request.erasureDueAt, locale) })}
      cancelLabel={t('banner.cancel')}
    />
  );
}
