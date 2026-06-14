'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';
import type { OrganizationRole } from '@prisma/client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { OrgMemberDTO, OrgMemberPageDTO } from '@/lib/dto/organizations';
// `ORG_ROSTER_PAGE_SIZE` lives in a non-'use client' module (../rosterPageSize)
// so the server component (page.tsx) can import the numeric value directly — a
// value imported FROM this client module into a server component becomes a
// client reference, not the number, and crashes the roster query (a non-numeric
// `take`).
import { ORG_ROSTER_PAGE_SIZE } from '../rosterPageSize';

const ORG_ROLES: OrganizationRole[] = [
  ORGANIZATION_ROLE.owner,
  ORGANIZATION_ROLE.admin,
  ORGANIZATION_ROLE.member,
];

export interface OrgMembersClientProps {
  orgId: string;
  orgName: string;
  currentUserId: string;
  initialPage: OrgMemberPageDTO;
}

// The cross-workspace member roster (design/org-admin panel 3) — PAGINATED (the
// at-scale rule, finding #57): a page at a time via the org members API, never
// load-all. Role-change + remove are inline edits that update local state on a
// success response (the no-whole-tree-refresh rule — a success IS the
// confirmation). Invite (by email) refetches page 1.
export function OrgMembersClient({
  orgId,
  orgName,
  currentUserId,
  initialPage,
}: OrgMembersClientProps) {
  const t = useTranslations('orgAdmin');
  const { toast } = useToast();

  const [page, setPage] = useState<OrgMemberPageDTO>(initialPage);
  const [pageIndex, setPageIndex] = useState(0);
  // cursorStack[i] = the `cursor` query used to fetch page i (null for page 0).
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [inviteOpen, setInviteOpen] = useState(false);

  const pageCount = Math.max(1, Math.ceil(page.total / ORG_ROSTER_PAGE_SIZE));
  const from = page.members.length === 0 ? 0 : pageIndex * ORG_ROSTER_PAGE_SIZE + 1;
  const to = pageIndex * ORG_ROSTER_PAGE_SIZE + page.members.length;

  async function fetchPage(cursor: string | null, nextIndex: number): Promise<void> {
    setStatus('loading');
    try {
      const params = new URLSearchParams({ limit: String(ORG_ROSTER_PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/organizations/${orgId}/members?${params.toString()}`);
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = (await res.json()) as OrgMemberPageDTO;
      setPage(data);
      setPageIndex(nextIndex);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  function goNext() {
    if (!page.nextCursor) return;
    const nextIndex = pageIndex + 1;
    setCursorStack((stack) => {
      const copy = stack.slice(0, nextIndex);
      copy[nextIndex] = page.nextCursor;
      return copy;
    });
    void fetchPage(page.nextCursor, nextIndex);
  }

  function goPrev() {
    if (pageIndex === 0) return;
    const prevIndex = pageIndex - 1;
    void fetchPage(cursorStack[prevIndex] ?? null, prevIndex);
  }

  function reloadCurrent() {
    void fetchPage(cursorStack[pageIndex] ?? null, pageIndex);
  }

  function reloadFirst() {
    setCursorStack([null]);
    void fetchPage(null, 0);
  }

  // Local-state update after an inline mutation (no whole-tree refresh).
  function applyRoleChange(userId: string, role: OrganizationRole) {
    setPage((p) => ({
      ...p,
      members: p.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
    }));
  }

  function applyRemoval(userId: string) {
    setPage((p) => ({
      ...p,
      members: p.members.filter((m) => m.userId !== userId),
      total: Math.max(0, p.total - 1),
    }));
  }

  // Single-member org → the first-run empty state (design panel 5a), instead of
  // a one-row roster.
  if (page.total <= 1 && pageIndex === 0 && status !== 'error') {
    return (
      <>
        <EmptyState
          title={t('states.emptyTitle')}
          description={t('states.emptyDescription', { org: orgName })}
          action={
            <Button
              variant="primary"
              leftIcon={<Mail className="h-4 w-4" />}
              onClick={() => setInviteOpen(true)}
            >
              {t('states.emptyAction')}
            </Button>
          }
        />
        <InviteModal
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          orgId={orgId}
          orgName={orgName}
          onInvited={(email) => {
            toast({ variant: 'success', title: t('inviteModal.sent', { email }) });
            setInviteOpen(false);
            reloadFirst();
          }}
        />
      </>
    );
  }

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('members.people')}
            </h2>
            <Pill tone="neutral">{t('members.count', { count: page.total })}</Pill>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Mail className="h-4 w-4" />}
            onClick={() => setInviteOpen(true)}
          >
            {t('members.invite')}
          </Button>
        </div>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-(--el-text-muted) font-sans text-xs" aria-live="polite">
            {t('members.pager', { from, to, total: page.total })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={goPrev}
              disabled={pageIndex === 0 || status === 'loading'}
            >
              {t('members.prev')}
            </Button>
            <span className="text-(--el-text-muted) font-sans text-xs">
              {t('members.page', { n: pageIndex + 1, m: pageCount })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              disabled={!page.nextCursor || status === 'loading'}
            >
              {t('members.next')}
            </Button>
          </div>
        </div>
      }
    >
      {status === 'error' ? (
        <ErrorState
          title={t('states.errorTitle')}
          description={t('states.errorDescription')}
          retry={reloadCurrent}
        />
      ) : status === 'loading' ? (
        <ul role="list" className="flex flex-col" aria-busy="true" aria-live="polite">
          {Array.from({ length: Math.min(page.members.length || 4, ORG_ROSTER_PAGE_SIZE) }).map(
            (_, i) => (
              <MemberRowSkeleton key={i} />
            ),
          )}
        </ul>
      ) : (
        <ul role="list" className="flex flex-col">
          {page.members.map((m) => (
            <MemberRow
              key={m.userId}
              orgId={orgId}
              member={m}
              isSelf={m.userId === currentUserId}
              onRoleChanged={applyRoleChange}
              onRemoved={applyRemoval}
            />
          ))}
        </ul>
      )}

      <InviteModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        orgId={orgId}
        orgName={orgName}
        onInvited={(email) => {
          toast({ variant: 'success', title: t('inviteModal.sent', { email }) });
          setInviteOpen(false);
          reloadFirst();
        }}
      />
    </Card>
  );
}

const MAX_WORKSPACE_CHIPS = 2;

function MemberRow({
  orgId,
  member,
  isSelf,
  onRoleChanged,
  onRemoved,
}: {
  orgId: string;
  member: OrgMemberDTO;
  isSelf: boolean;
  onRoleChanged: (userId: string, role: OrganizationRole) => void;
  onRemoved: (userId: string) => void;
}) {
  const t = useTranslations('orgAdmin');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const initial = (member.name || member.email).charAt(0).toUpperCase();

  const roleOptions: ComboboxOption<OrganizationRole>[] = ORG_ROLES.map((r) => ({
    value: r,
    label: t(`roles.${r}`),
  }));

  const shownWorkspaces = member.workspaces.slice(0, MAX_WORKSPACE_CHIPS);
  const overflow = member.workspaces.length - shownWorkspaces.length;

  function handleRoleChange(role: OrganizationRole) {
    if (role === member.role) return;
    const previous = member.role;
    onRoleChanged(member.userId, role); // optimistic
    startTransition(async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/members/${member.userId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role }),
        });
        if (res.ok) {
          toast({ variant: 'success', title: t('members.roleChanged') });
          return;
        }
        onRoleChanged(member.userId, previous as OrganizationRole); // revert
        toast({ variant: 'error', title: t('members.roleChangeError') });
      } catch {
        onRoleChanged(member.userId, previous as OrganizationRole);
        toast({ variant: 'error', title: t('members.roleChangeError') });
      }
    });
  }

  function handleRemove() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/members/${member.userId}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          toast({ variant: 'success', title: t('members.removed', { name: member.name }) });
          onRemoved(member.userId);
          return;
        }
        toast({ variant: 'error', title: t('members.removeError') });
      } catch {
        toast({ variant: 'error', title: t('members.removeError') });
      }
    });
  }

  return (
    <li className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0">
      <span className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-sans text-sm font-medium text-(--el-text)">
          {member.name}
          {isSelf ? (
            <span className="text-(--el-text-muted) font-normal">{t('members.you')}</span>
          ) : null}
        </p>
        <p className="text-(--el-text-muted) truncate font-sans text-xs">{member.email}</p>
      </div>
      <div className="hidden items-center gap-1 sm:flex">
        {member.workspaces.length === 0 ? (
          <span className="text-(--el-text-faint) font-sans text-xs">
            {t('members.noWorkspaces')}
          </span>
        ) : (
          <>
            {shownWorkspaces.map((w) => (
              <Pill
                key={w.id}
                className="bg-(--el-tint-peach) text-(--el-text-strong) max-w-[12ch] truncate border-transparent"
              >
                {w.name}
              </Pill>
            ))}
            {overflow > 0 ? (
              <Pill tone="neutral">{t('members.moreWorkspaces', { count: overflow })}</Pill>
            ) : null}
          </>
        )}
      </div>
      {isSelf ? (
        <Pill orgRole={member.role as 'owner' | 'admin' | 'member'}>
          {t(`roles.${member.role}`)}
        </Pill>
      ) : (
        <div className="w-32 shrink-0">
          <Combobox<OrganizationRole>
            label={t('members.roleLabel', { name: member.name })}
            options={roleOptions}
            value={member.role as OrganizationRole}
            onChange={handleRoleChange}
            disabled={isPending}
          />
        </div>
      )}
      {isSelf ? null : (
        <Button variant="ghost" size="sm" onClick={handleRemove} loading={isPending}>
          {t('members.remove')}
        </Button>
      )}
    </li>
  );
}

function MemberRowSkeleton() {
  return (
    <li className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0">
      <span className="bg-(--el-muted) h-8 w-8 shrink-0 animate-pulse rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="bg-(--el-muted) h-3 w-32 animate-pulse rounded-(--radius-control)" />
        <span className="bg-(--el-muted) h-2.5 w-44 animate-pulse rounded-(--radius-control)" />
      </div>
      <span className="bg-(--el-muted) h-6 w-20 animate-pulse rounded-(--radius-badge)" />
    </li>
  );
}

function InviteModal({
  open,
  onOpenChange,
  orgId,
  orgName,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgName: string;
  onInvited: (email: string) => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>(ORGANIZATION_ROLE.member);
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  const roleOptions: ComboboxOption<OrganizationRole>[] = ORG_ROLES.map((r) => ({
    value: r,
    label: t(`roles.${r}`),
    secondary: t(`roles.${r}Desc`),
  }));

  function reset() {
    setEmail('');
    setRole(ORGANIZATION_ROLE.member);
    setError(undefined);
  }

  function handleSend() {
    const value = email.trim();
    if (!value) return;
    setError(undefined);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/members`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: value, role }),
        });
        if (res.ok) {
          onInvited(value);
          reset();
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        setError(messageForInviteError(t, res.status, data.code, value));
      } catch {
        setError(t('inviteModal.errorGeneric'));
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
      title={t('inviteModal.title', { org: orgName })}
      description={t('inviteModal.description')}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="flex flex-col gap-4"
      >
        <Input
          label={t('inviteModal.emailLabel')}
          type="email"
          placeholder={t('inviteModal.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
          autoFocus
        />
        <div className="flex flex-col gap-1">
          <span className="text-(--el-text-secondary) font-sans text-sm font-medium">
            {t('inviteModal.roleLabel')}
          </span>
          <Combobox<OrganizationRole>
            label={t('inviteModal.roleLabel')}
            options={roleOptions}
            value={role}
            onChange={setRole}
          />
          <p className="text-(--el-text-muted) font-sans text-xs">{t('roleHelp.gatingNote')}</p>
        </div>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={isPending} disabled={!email.trim()}>
            {t('inviteModal.send')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function messageForInviteError(
  t: (key: string, values?: Record<string, string>) => string,
  status: number,
  code: string | undefined,
  email: string,
): string {
  if (status === 422 || code === 'ORG_INVITEE_NOT_FOUND') {
    return t('inviteModal.errorNotFound', { email });
  }
  if (status === 409 || code === 'ALREADY_ORG_MEMBER') {
    return t('inviteModal.errorAlready', { email });
  }
  return t('inviteModal.errorGeneric');
}
