import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { Suspense, type ReactNode } from 'react';
import { AuthShell } from '@/app/(auth)/_components/AuthShell';
import { Button } from '@/components/ui/Button';
import { AcceptInviteButton } from './AcceptInviteButton';

// Centered card frame mirroring app/(auth)/layout.tsx — the invite-accept
// surface composes the same card-wrapped grammar as the auth pages. It
// renders inside the (authed) layout's <main>, so the top-nav is present
// above it (per the Story AC: TopNav on every authed route); the card
// keeps the focused single-action feel from the mockup.
function InviteCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center px-2 py-6">
      <div className="w-full max-w-[28rem]">
        <div className="rounded-(--radius-card) bg-(--el-page-bg) px-6 py-10 shadow-(--shadow-elevated) sm:px-10">
          {children}
        </div>
      </div>
    </div>
  );
}

// Invite-acceptance landing — server component under (authed), so proxy.ts
// gates it (an unauthenticated invitee is bounced to /sign-in with the
// invite URL preserved in ?next=, then returns here after auth). Renders
// the workspace + inviter and a single Accept button, or one of three
// full-screen error states matching the 1.2.1 mockups.

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * The PENDING FRAME (MOTIR-3447 · `design/workspaces/invite-arrival.mock.html`).
 *
 * This is the ONE surface of MOTIR-3440's twenty-four whose verdict is *a frame
 * of its own*, and it earns that on two facts. It can paint no character of its
 * own copy before `inspectInvite` returns — the headline names the workspace and
 * the subhead names the inviter, and three of the four bodies replace both
 * outright. And it is the only surface in the story reached by a HARD navigation
 * from outside the app, from a link in a mail client, so the shell's window-1
 * pending mark cannot speak for it either: there is no mounted shell to mark.
 *
 * ⚠️ IT CANNOT MISPREDICT, which is what makes a frame honest here rather than a
 * guess. All four bodies render the same chrome — `InviteCard` wrapping
 * `AuthShell`, a headline, a subhead, one full-width control — so the
 * placeholder stands in for a shape that is already settled and only the words
 * differ. It draws the SHORTEST honest shape, so every settle grows the card
 * downward rather than shrinking it under the reader's cursor.
 *
 * The boxes are the drawn ones: `h-11 sm:h-15` tracks `AuthShell`'s
 * `text-4xl sm:text-5xl leading-tight` headline (45px / 60px), the two bars are
 * its `text-base` subhead lines, and the control takes `--height-btn-md` as a
 * TOKEN so it flips with the style axis exactly as the real button does.
 */
function InviteFrame() {
  return (
    <InviteCard>
      <div className="animate-pulse" aria-busy="true">
        <section className="flex flex-col gap-8">
          <header className="flex flex-col gap-3">
            <div className="bg-(--el-muted) h-11 w-3/4 rounded-(--radius-control) sm:h-15" />
            <div className="flex flex-col gap-1.5">
              <div className="bg-(--el-muted) h-4 w-full rounded-(--radius-control)" />
              <div className="bg-(--el-muted) h-4 w-2/3 rounded-(--radius-control)" />
            </div>
          </header>
          <div className="bg-(--el-muted) h-(--height-btn-md) w-full rounded-(--radius-btn)" />
        </section>
      </div>
    </InviteCard>
  );
}

/**
 * Everything the invite READ decides — which is every one of the four bodies.
 *
 * ⚠️ `inspectInvite` is NOT a gate, and that distinction is the whole reason a
 * frame is possible on this page. A gate is a read that decides the HTTP STATUS;
 * this route answers 200 whatever the token turns out to be — expired, used,
 * wrong-account and valid are four BODIES, not four statuses, and the route
 * calls `notFound()` nowhere. So the read may sit below a boundary without
 * touching a status, and `motir-core/CLAUDE.md` § *A `loading.tsx` may NOT sit
 * above a route that decides existence* is not engaged.
 *
 * The session redirect stays ABOVE, in the page: that one really does decide the
 * response, and an unauthenticated visitor must be bounced rather than framed.
 */
async function InviteOutcome({
  token,
  sessionEmail,
  currentEmail,
}: {
  token: string;
  sessionEmail: string;
  currentEmail: string;
}) {
  const t = await getTranslations('auth');
  const result = await workspaceInvitesService.inspectInvite(token);

  if (result.status === 'expired') return <ExpiredState />;
  if (result.status === 'used') return <UsedState />;

  // status === 'valid' — but the signed-in email may not match the invite.
  if (sessionEmail !== result.email) {
    return <WrongEmailState invitedEmail={result.email} currentEmail={currentEmail} />;
  }

  return (
    <InviteCard>
      <AuthShell
        headline={t('joinWorkspace', { workspaceName: result.workspaceName })}
        subhead={t('invitedToCollaborate', { inviterName: result.inviterName })}
      >
        <AcceptInviteButton token={token} />
      </AuthShell>
    </InviteCard>
  );
}

export default async function InviteAcceptPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { token } = await searchParams;
  if (!token) {
    return <UsedState />;
  }

  // MOTIR-3447 — the invite read moves BELOW a boundary, so the card's chrome is
  // on screen while the token is resolved. Every terminal outcome is unchanged
  // and still rendered by `InviteOutcome`; what changed is that the reader sees
  // the card's shape first instead of an empty content area, on the one surface
  // in this story reached cold from an email.
  return (
    <Suspense fallback={<InviteFrame />}>
      <InviteOutcome
        token={token}
        sessionEmail={session.user.email.trim().toLowerCase()}
        currentEmail={session.user.email}
      />
    </Suspense>
  );
}

async function ExpiredState() {
  const t = await getTranslations('auth');
  return (
    <InviteCard>
      <AuthShell headline={t('inviteExpired')} subhead={t('inviteExpiredSubhead')}>
        <Link href="/dashboard">
          <Button variant="secondary" className="w-full">
            {t('backToDashboard')}
          </Button>
        </Link>
      </AuthShell>
    </InviteCard>
  );
}

async function UsedState() {
  const t = await getTranslations('auth');
  return (
    <InviteCard>
      <AuthShell headline={t('inviteUsed')} subhead={t('inviteUsedSubhead')}>
        <a href="/sign-in">
          <Button variant="secondary" className="w-full">
            {t('backToSignIn')}
          </Button>
        </a>
      </AuthShell>
    </InviteCard>
  );
}

async function WrongEmailState({
  invitedEmail,
  currentEmail,
}: {
  invitedEmail: string;
  currentEmail: string;
}) {
  const t = await getTranslations('auth');
  return (
    <InviteCard>
      <AuthShell
        headline={t('signInWithInvitedEmail')}
        subhead={t('wrongEmailSubhead', { invitedEmail, currentEmail })}
      >
        <div className="flex flex-col gap-3">
          <a href={`/sign-in?email=${encodeURIComponent(invitedEmail)}`}>
            <Button variant="primary" className="w-full">
              {t('signInWith', { invitedEmail })}
            </Button>
          </a>
          <Link href="/dashboard">
            <Button variant="secondary" className="w-full">
              {t('backToDashboard')}
            </Button>
          </Link>
        </div>
      </AuthShell>
    </InviteCard>
  );
}
