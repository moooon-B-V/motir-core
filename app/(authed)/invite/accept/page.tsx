import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { type ReactNode } from 'react';
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

export default async function InviteAcceptPage({ searchParams }: PageProps) {
  const t = await getTranslations('auth');
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { token } = await searchParams;
  if (!token) {
    return <UsedState />;
  }

  const result = await workspaceInvitesService.inspectInvite(token);

  if (result.status === 'expired') return <ExpiredState />;
  if (result.status === 'used') return <UsedState />;

  // status === 'valid' — but the signed-in email may not match the invite.
  const sessionEmail = session.user.email.trim().toLowerCase();
  if (sessionEmail !== result.email) {
    return <WrongEmailState invitedEmail={result.email} currentEmail={session.user.email} />;
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
