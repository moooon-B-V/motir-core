import { redirect } from 'next/navigation';
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
        headline={`Join ${result.workspaceName}`}
        subhead={`${result.inviterName} invited you to collaborate.`}
      >
        <AcceptInviteButton token={token} />
      </AuthShell>
    </InviteCard>
  );
}

function ExpiredState() {
  return (
    <InviteCard>
      <AuthShell
        headline="This invite has expired"
        subhead="Invites are valid for 7 days. Ask the inviter for a new link if you'd still like to join."
      >
        <a href="/dashboard">
          <Button variant="secondary" className="w-full">
            Back to dashboard
          </Button>
        </a>
      </AuthShell>
    </InviteCard>
  );
}

function UsedState() {
  return (
    <InviteCard>
      <AuthShell
        headline="This invite has already been used"
        subhead="If you joined from another email, sign in with that account."
      >
        <a href="/sign-in">
          <Button variant="secondary" className="w-full">
            Back to sign in
          </Button>
        </a>
      </AuthShell>
    </InviteCard>
  );
}

function WrongEmailState({
  invitedEmail,
  currentEmail,
}: {
  invitedEmail: string;
  currentEmail: string;
}) {
  return (
    <InviteCard>
      <AuthShell
        headline="Sign in with the invited email"
        subhead={`This invite is for ${invitedEmail}. You're signed in as ${currentEmail}. Sign in with the invited email to accept, or ask the inviter to re-send to your address.`}
      >
        <div className="flex flex-col gap-3">
          <a href={`/sign-in?email=${encodeURIComponent(invitedEmail)}`}>
            <Button variant="primary" className="w-full">
              Sign in with {invitedEmail}
            </Button>
          </a>
          <a href="/dashboard">
            <Button variant="secondary" className="w-full">
              Back to dashboard
            </Button>
          </a>
        </div>
      </AuthShell>
    </InviteCard>
  );
}
