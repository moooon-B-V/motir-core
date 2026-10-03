'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Eye } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { StaffSessionDTO } from '@/lib/dto/platformImpersonation';

/**
 * The STAFF SESSION BAR — design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-03, Panel 5 (Story 10.3 · MOTIR-749).
 *
 * Rides ABOVE the tenant's own TopNav on every page of a staff "View as"
 * session (the `(authed)` layout mounts it first in `AppLayout`'s banner slot).
 * It is NOT dismissible — the safety property is that the operator can never
 * mistake the customer's live app for their own — and it is `role="status"`.
 *
 *   · read-only: `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`
 *     (high-visibility, not alarming);
 *   · full access: `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`
 *     (writes are real).
 *
 * **Exit session** is a plain form POST to `/api/staff-session/exit` — not a
 * Server Action, because a read-only session refuses Server Actions on tenant
 * pages at the session chokepoint, and leaving must always work. It ends the
 * session (audited `user.impersonation_end`, `endedBy: operator`), clears the
 * cookie and lands on the ended page.
 *
 * When the time-box runs out while the page is open, the bar sends the browser
 * through `/api/staff-session/clear` — the gate already refuses the session from
 * that instant; this only spares the operator a click that would fail.
 */
export interface StaffSessionBarProps {
  session: StaffSessionDTO;
}

/** Nothing to subscribe to: the label only differs between server and client. */
const noSubscription = () => () => {};

/**
 * "14:32" in the viewer's own clock — or the UTC time on the server and during
 * hydration, which cannot know the viewer's zone (`useSyncExternalStore`'s
 * server snapshot, so hydration never mismatches).
 */
function useEndsAt(expiresAt: string): string {
  return useSyncExternalStore(
    noSubscription,
    () =>
      new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(expiresAt),
      ),
    () => `${new Date(expiresAt).toISOString().slice(11, 16)} UTC`,
  );
}

export function StaffSessionBar({ session }: StaffSessionBarProps) {
  const t = useTranslations('platformAdmin.imp');
  const time = useEndsAt(session.expiresAt);
  const readOnly = session.mode === 'read_only';

  useEffect(() => {
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    // setTimeout's ceiling is ~24.8 days; a session is at most an hour.
    const timer = window.setTimeout(
      () => window.location.assign('/api/staff-session/clear'),
      Math.max(0, remaining) + 1_000,
    );
    return () => window.clearTimeout(timer);
  }, [session.expiresAt]);

  const values = {
    name: session.targetName,
    email: session.targetEmail,
    org: session.organizationName,
    time,
    b: (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>,
  };

  return (
    <div
      role="status"
      data-staff-session={session.mode}
      className={`flex flex-wrap items-center justify-center gap-3 border-b border-(--el-border) px-4 py-2 text-center font-sans text-sm text-(--el-text-strong) ${
        readOnly ? 'bg-(--el-tint-yellow)' : 'bg-(--el-tint-rose)'
      }`}
    >
      {readOnly ? (
        <Eye aria-hidden className="h-4 w-4 shrink-0 text-(--el-warning)" />
      ) : (
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-(--el-danger)" />
      )}
      <span className="min-w-0">
        {readOnly ? t.rich('bar.readOnly', values) : t.rich('bar.full', values)}
      </span>
      <form action="/api/staff-session/exit" method="post" className="shrink-0">
        <Button type="submit" variant="secondary" size="sm">
          {t('bar.exit')}
        </Button>
      </form>
    </div>
  );
}
