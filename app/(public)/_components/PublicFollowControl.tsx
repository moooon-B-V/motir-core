'use client';

import { useCallback, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, Rss, Send, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { PublicFollowStateDto } from '@/lib/dto/publicProjects';

// The Follow button + subscribe popover (Story 8.9 · Subtask 8.9.5 · design
// `public-changelog.mock.html` Panels C and D).
//
// ── THE THREE TIERS ARE THREE AFFORDANCES ───────────────────────────────────
// One "Subscribe" control would collapse a real distinction (ADR §1). Signed in,
// the popover offers the account follow's digest checkbox and the feed; signed
// out, it offers the email field FIRST, the account route second, and the feed.
// The email field leads because the visitor arrived from a link and has no
// account — demanding one before they may hear about the thing they just decided
// they were interested in inverts the funnel this page exists to feed.
//
// ── PAGE-STATE CONTRACT ─────────────────────────────────────────────────────
// The Follow button is the EDITED CELL, so its success response IS the
// confirmation and the optimistic value stays. There is deliberately NO
// `router.refresh()` here: the refresh would re-read the server and cause the
// visible revert the inline-edit rule describes. Nothing else on the page reads
// the follow state, so there is no second surface to reconcile — and the
// follower count comes back in the same response, so it moves with the button
// rather than going stale beside it.

export function PublicFollowControl({
  identifier,
  initialState,
  signedIn,
  feedUrl,
}: {
  identifier: string;
  initialState: PublicFollowStateDto;
  signedIn: boolean;
  feedUrl: string;
}) {
  const t = useTranslations('publicProjects');
  const [state, setState] = useState(initialState);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards an out-of-order reconcile: two rapid toggles resolve in whatever
  // order the network returns them, and an older response must not clobber the
  // newer state (the seq-ref pattern the shipped WatchControl uses).
  const seq = useRef(0);

  const toggleFollow = useCallback(
    async (next: boolean, digestOptIn?: boolean) => {
      const mine = ++seq.current;
      setPending(true);
      setFailed(false);
      // Optimistic: the button flips now. The response reconciles the COUNT,
      // which we cannot know locally.
      setState((prev) => ({
        ...prev,
        following: next,
        digestOptIn: next ? (digestOptIn ?? prev.digestOptIn) : false,
      }));
      try {
        const res = await fetch(`/api/public/p/${encodeURIComponent(identifier)}/follow`, {
          method: next ? 'POST' : 'DELETE',
          ...(next && digestOptIn !== undefined
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ digestOptIn }),
              }
            : {}),
        });
        if (!res.ok) throw new Error(`follow failed: ${res.status}`);
        const fresh = (await res.json()) as PublicFollowStateDto;
        if (mine === seq.current) setState(fresh);
      } catch {
        if (mine === seq.current) {
          setFailed(true);
          // Roll the optimistic value back — leaving "Following" on screen when
          // nothing was written is the one outcome worse than an error.
          setState((prev) => ({ ...prev, following: !next }));
        }
      } finally {
        if (mine === seq.current) setPending(false);
      }
    },
    [identifier],
  );

  const submitEmail = useCallback(async () => {
    setEmailError(null);
    setFailed(false);
    setPending(true);
    try {
      const res = await fetch(`/api/public/p/${encodeURIComponent(identifier)}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.status === 422) {
        setEmailError(t('emailInvalid'));
        return;
      }
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
      // 202 — and the SAME 202 whatever the truth was, so this screen cannot
      // report whether the address was already subscribed (the enumeration rule).
      setSentTo(email);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, [email, identifier, t]);

  const copyFeed = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard a browser refuses is not an error worth a banner — the URL
      // is on screen and selectable.
    }
  }, [feedUrl]);

  const followLabel = state.following ? (hovering ? t('unfollow') : t('following')) : t('follow');

  return (
    <div className="flex items-center gap-2.5">
      {state.followerCount > 0 ? (
        <span className="text-[12.5px] text-(--el-text-secondary)">
          {t('followerCount', { count: state.followerCount })}
        </span>
      ) : null}

      {signedIn ? (
        <Button
          variant={state.following ? 'primary' : 'secondary'}
          size="sm"
          disabled={pending}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onFocus={() => setHovering(true)}
          onBlur={() => setHovering(false)}
          onClick={() => void toggleFollow(!state.following)}
        >
          {state.following ? (
            hovering ? (
              <X className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <CheckCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )
          ) : (
            <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          {followLabel}
        </Button>
      ) : (
        // Signed out, Follow does NOT bounce to a sign-in page — it opens the
        // same popover as Subscribe, with the email field focused (design D2).
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t('follow')}
        </Button>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="sm">
            <Rss className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('subscribe')}
          </Button>
        </Popover.Trigger>
        <Popover.Content align="end" width={320} className="p-0">
          <div className="border-b border-(--el-border-soft) p-3.5">
            <p className="text-[13.5px] font-bold text-(--el-text)">{t('subscribeTitle')}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-(--el-text-secondary)">
              {t('subscribeLede', { project: identifier })}
            </p>
          </div>

          {sentTo ? (
            // D3 — NOT a success state: the follow is not live until the link is
            // used, so the copy says exactly that rather than implying it worked.
            <div className="flex flex-col items-center gap-2 p-5 text-center">
              <Send className="h-5 w-5 text-(--el-text-secondary)" aria-hidden />
              <p className="text-[13.5px] font-semibold text-(--el-text)">
                {t('confirmSentTitle')}
              </p>
              <p className="text-[12px] leading-relaxed text-(--el-text-secondary)">
                {t('confirmSentBody', { email: sentTo })}
              </p>
            </div>
          ) : (
            <>
              {signedIn ? (
                <div className="border-b border-(--el-border-soft) p-3.5">
                  <SectionLabel className="mb-2">{t('tierAccount')}</SectionLabel>
                  {state.following ? (
                    <p className="flex items-start gap-2 text-[13px] text-(--el-text)">
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 flex-none text-(--el-success)"
                        aria-hidden
                      />
                      {t('followingAs')}
                    </p>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      disabled={pending}
                      onClick={() => void toggleFollow(true)}
                    >
                      <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('follow')}
                    </Button>
                  )}
                  {state.following && state.digestAvailable ? (
                    <>
                      <label className="mt-2.5 flex items-start gap-2.5 text-[13px] text-(--el-text)">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-(--el-accent)"
                          checked={state.digestOptIn}
                          disabled={pending}
                          onChange={(e) => void toggleFollow(true, e.target.checked)}
                        />
                        {t('digestOptIn')}
                      </label>
                      <p className="mt-1 ml-6 text-[11.5px] leading-relaxed text-(--el-text-secondary)">
                        {t('digestHint')}
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}

              {/* E4 — where no email backend is configured the email tiers are
                  ABSENT, not disabled: a greyed-out control would advertise a
                  capability the operator cannot switch on from this page. */}
              {!signedIn && state.digestAvailable ? (
                <div className="border-b border-(--el-border-soft) p-3.5">
                  <SectionLabel className="mb-2">{t('tierEmail')}</SectionLabel>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      autoFocus
                      value={email}
                      placeholder={t('emailPlaceholder')}
                      onChange={(e) => setEmail(e.target.value)}
                      aria-label={t('tierEmail')}
                      aria-invalid={emailError ? true : undefined}
                    />
                    <Button
                      size="sm"
                      disabled={pending || email.length === 0}
                      onClick={submitEmail}
                    >
                      {t('subscribe')}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-(--el-text-secondary)">
                    {emailError ?? t('emailHint')}
                  </p>
                </div>
              ) : null}

              {!signedIn ? (
                <div className="border-b border-(--el-border-soft) p-3.5">
                  <SectionLabel className="mb-2">{t('tierAccountSignedOut')}</SectionLabel>
                  {/* ⚠️ `next`, NOT `callbackURL`. `app/(auth)/sign-in/page.tsx`
                      reads `searchParams.next` and hands it to
                      `resolvePostAuthDestination`, the one owner of "where does
                      a reader go next" — a `callbackURL` param is simply
                      ignored there, and the visitor would land on `/home`
                      having lost the project they were following.

                      The design (D2) prefers the shipped in-place sign-in modal
                      here. `PublicAuthDialog` renders its OWN two trigger
                      buttons, so reusing it inside this popover needs a trigger
                      prop it does not have — a refactor of a shipped component,
                      which is not this card's. The top bar offers that modal on
                      the same page; this is the route back to the changelog for
                      somebody who takes the popover's path instead. */}
                  <a
                    className="block"
                    href={`/sign-in?next=${encodeURIComponent(`/p/${identifier}/changelog`)}`}
                  >
                    <Button variant="secondary" size="sm" className="w-full">
                      <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('signInAndFollow')}
                    </Button>
                  </a>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-(--el-text-secondary)">
                    {t('signInHint')}
                  </p>
                </div>
              ) : null}

              {/* The ANONYMOUS tier — no row, no account, and we never learn
                  that anybody subscribed. */}
              <div className="p-3.5">
                <SectionLabel className="mb-2">{t('tierFeed')}</SectionLabel>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate rounded-(--radius-input) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-input-x) py-(--spacing-input-y) font-mono text-[11.5px] text-(--el-text-secondary)">
                    {feedUrl}
                  </span>
                  <Button variant="secondary" size="sm" onClick={copyFeed}>
                    {copied ? t('copiedFeed') : t('copyFeed')}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-(--el-text-secondary)">
                  {t('feedHint')}
                </p>
              </div>
            </>
          )}

          {failed ? (
            <p role="alert" className="px-3.5 pb-3.5 text-[12px] text-(--el-danger-text)">
              {t('followFailed')}
            </p>
          ) : null}
        </Popover.Content>
      </Popover>
    </div>
  );
}
