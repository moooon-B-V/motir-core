'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Mail } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { removeMemberAction } from '../actions';

export interface MembersCardProps {
  workspaceId: string;
  workspaceName: string;
  members: WorkspaceMemberDTO[];
  currentUserId: string;
}

export function MembersCard({
  workspaceId,
  workspaceName,
  members,
  currentUserId,
}: MembersCardProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <Card
      id="members"
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-sans text-base font-semibold text-foreground">Members</h2>
            {/* A member count is metadata, not an "info" severity state — the
                neutral tone is both the right semantics and AA-contrast-safe
                (the colored `info` tone fails WCAG AA on its tint; finding #35). */}
            <Pill tone="neutral">
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </Pill>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Mail className="h-4 w-4" />}
            onClick={() => setInviteOpen(true)}
          >
            Invite
          </Button>
        </div>
      }
    >
      <ul role="list" className="flex flex-col">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            isSelf={m.userId === currentUserId}
            onRemoved={() => router.refresh()}
          />
        ))}
      </ul>

      <InviteModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        onSent={(email) => {
          toast({ variant: 'success', title: `Invite sent to ${email}` });
          setInviteOpen(false);
        }}
      />
    </Card>
  );
}

function MemberRow({
  member,
  isSelf,
  onRemoved,
}: {
  member: WorkspaceMemberDTO;
  isSelf: boolean;
  onRemoved: () => void;
}) {
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const initial = (member.name || member.email).charAt(0).toUpperCase();

  function handleRemove() {
    startTransition(async () => {
      const result = await removeMemberAction(member.userId);
      if (result.ok) {
        toast({ variant: 'success', title: `Removed ${member.name}` });
        onRemoved();
      } else {
        toast({ variant: 'error', title: 'Could not remove member', description: result.error });
      }
    });
  }

  return (
    <li className="border-(--color-hairline-soft) flex items-center gap-3 border-b py-3 last:border-b-0">
      <span className="bg-foreground text-background inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-sans text-sm font-medium text-foreground">
          {member.name}
          {isSelf ? <span className="text-muted-foreground font-normal"> (you)</span> : null}
        </p>
        <p className="text-muted-foreground truncate font-sans text-xs">{member.email}</p>
      </div>
      {/* A role is a category label, not an "info" severity — neutral tone
          (AA-contrast-safe; see finding #35). */}
      <Pill tone="neutral">{member.role}</Pill>
      {isSelf ? null : (
        <Button variant="ghost" size="sm" onClick={handleRemove} loading={isPending}>
          Remove
        </Button>
      )}
    </li>
  );
}

function InviteModal({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  function reset() {
    setEmail('');
    setError(undefined);
  }

  function handleSend() {
    const value = email.trim();
    if (!value) return;
    setError(undefined);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/invites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: value }),
        });
        if (res.ok) {
          onSent(value);
          reset();
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        setError(messageForInviteError(res.status, data.code, value));
      } catch {
        setError('Something went wrong. Please try again.');
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={`Invite to ${workspaceName}`}
      description="They'll get an email with a one-time link. Links expire in 7 days."
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <Input
          label="Email address"
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={isPending} disabled={!email.trim()}>
            Send invite
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function messageForInviteError(status: number, code: string | undefined, email: string): string {
  if (status === 422 || code === 'ALREADY_MEMBER') {
    return `${email} is already a member of this workspace.`;
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return "You've already sent 3 invites to this address in the last hour. Please wait before trying again.";
  }
  if (status === 400 || code === 'INVALID_EMAIL') {
    return 'Enter a valid email address.';
  }
  return 'Could not send the invite. Please try again.';
}
