'use client';

import { useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  CreditCard,
  ExternalLink,
  Eye,
  Info,
  Layers,
  Mail,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type { OrganizationRole } from '@prisma/client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { OrgMemberDTO, OrgMemberPageDTO } from '@/lib/dto/organizations';
import type { SeatSummaryDTO } from '@/lib/dto/billing';
import { annualSaving, formatRenewal, proratedAddCharge, seatTotal } from './seatFigures';

// The org-settings billing page the seat affordances link to (Story 8.1.7).
const BILLING_PATH = '/settings/organization/billing';
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
  /** The in-context seat/billing state (Story 8.1.14). `null` → NO seat UI: a
   *  self-host build, a free org, or a non-owner/admin — the page is unchanged. */
  seat: SeatSummaryDTO | null;
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
  seat,
}: OrgMembersClientProps) {
  const t = useTranslations('orgAdmin');
  const { toast } = useToast();

  const [page, setPage] = useState<OrgMemberPageDTO>(initialPage);
  const [pageIndex, setPageIndex] = useState(0);
  // cursorStack[i] = the `cursor` query used to fetch page i (null for page 0).
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [inviteOpen, setInviteOpen] = useState(false);
  // The unix-seconds timestamp captured WHEN invite opens (in the click handler,
  // not render — Date.now is impure in render) — the basis for the prorated
  // add-charge estimate. 0 until first open (the modal isn't shown then).
  const [inviteNow, setInviteNow] = useState(0);

  function openInvite() {
    setInviteNow(Math.floor(Date.now() / 1000));
    setInviteOpen(true);
  }

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
            <Button variant="primary" leftIcon={<Mail className="h-4 w-4" />} onClick={openInvite}>
              {t('states.emptyAction')}
            </Button>
          }
        />
        <InviteModal
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          orgId={orgId}
          orgName={orgName}
          seat={seat}
          seats={page.total}
          now={inviteNow}
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
    <>
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
              onClick={openInvite}
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
        {seat ? <SeatSummaryBand seat={seat} seats={page.total} /> : null}

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
                orgName={orgName}
                member={m}
                isSelf={m.userId === currentUserId}
                seat={seat}
                seatCount={page.total}
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
          seat={seat}
          seats={page.total}
          now={inviteNow}
          onInvited={(email) => {
            toast({ variant: 'success', title: t('inviteModal.sent', { email }) });
            setInviteOpen(false);
            reloadFirst();
          }}
        />
      </Card>

      {seat && seat.status === 'active' ? (
        // The no-pay-wall reassurance (design panel 1) — inviting always works;
        // the notes only disclose the cost. Sky info tint, --el-text-strong (AA).
        <div className="bg-(--el-tint-sky) text-(--el-text-strong) flex items-start gap-2 rounded-(--radius-card) px-3.5 py-3 font-sans text-xs leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">{t('seat.noPayWallTitle')}</span> {t('seat.noPayWall')}
          </span>
        </div>
      ) : null}
    </>
  );
}

// ── Seat-summary band (design/org-admin members-billing, panels 1/5/6) ───────
// In-context seat/billing summary at the top of the People card body, for a
// SCALED org. Mirrors the shipped billing seat-line grammar (mint glyph chip at
// --radius-control, --el-text-strong on tint, finding #35). Owner → "Manage
// seats" link; admin → read-only "View only" + lock note. past_due → yellow
// dunning band with an "Update payment" CTA (owner). Seats = the membership
// count, so the band recomputes as members are added/removed (page-state-after-
// mutation: the band reads the same client state the optimistic add/remove edits).
function SeatSummaryBand({ seat, seats }: { seat: SeatSummaryDTO; seats: number }) {
  const t = useTranslations('orgAdmin');
  const pastDue = seat.status === 'past_due';
  const period = t('seat.period', { cadence: seat.cadence });
  const total = seatTotal(seat, seats);
  const saving = annualSaving(seat, seats);

  return (
    <div
      className={`border-(--el-border-soft) mb-3 flex flex-wrap items-center gap-3.5 rounded-(--radius-card) border px-3.5 py-3 ${
        pastDue ? 'bg-(--el-tint-yellow) border-transparent' : 'bg-(--el-surface-soft)'
      }`}
    >
      <span
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) ${
          pastDue
            ? 'bg-(--el-page-bg) text-(--el-warning)'
            : 'bg-(--el-tint-lavender) text-(--el-text-strong)'
        }`}
      >
        {pastDue ? (
          <AlertTriangle className="h-4 w-4" aria-hidden />
        ) : (
          <Layers className="h-4 w-4" aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-semibold text-(--el-text) tabular-nums">
            {t('seat.count', { n: seats })}
            <span className="text-(--el-text-muted) font-normal">
              {' · '}
              {t('seat.price', { total, period })}
            </span>
          </span>
          {pastDue ? (
            <Pill className="bg-(--el-tint-yellow) text-(--el-text-strong) border-transparent">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {t('seat.pastDue')}
            </Pill>
          ) : (
            <Pill severity="success">
              <Check className="h-3 w-3" aria-hidden />
              {t('seat.scaled')}
            </Pill>
          )}
          {!pastDue && seat.cadence === 'annual' && saving > 0 ? (
            <span className="text-(--el-text-muted) font-sans text-xs">
              {t('seat.annualSaving', { save: saving })}
            </span>
          ) : null}
          {!seat.canManageBilling && !pastDue ? (
            <Pill tone="neutral">
              <Eye className="h-3 w-3" aria-hidden />
              {t('seat.viewOnly')}
            </Pill>
          ) : null}
        </div>

        <p className="text-(--el-text-muted) mt-1 font-sans text-xs leading-relaxed">
          {pastDue
            ? t('seat.pastDueNote')
            : seat.canManageBilling
              ? t('seat.follows', { rate: seat.perSeatUsd, period })
              : t('seat.viewOnlyNote')}
        </p>
      </div>

      {seat.canManageBilling ? (
        <div className="shrink-0">
          {pastDue ? (
            <Link
              href={BILLING_PATH}
              className="bg-(--el-accent) text-(--el-accent-text) inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) px-(--spacing-btn-x-sm) font-sans text-xs font-medium"
            >
              <CreditCard className="h-3.5 w-3.5" aria-hidden />
              {t('seat.updatePayment')}
            </Link>
          ) : (
            <Link
              href={BILLING_PATH}
              className="text-(--el-link) inline-flex items-center gap-1.5 font-sans text-xs font-medium"
            >
              {t('seat.manage')}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

const MAX_WORKSPACE_CHIPS = 2;

function MemberRow({
  orgId,
  orgName,
  member,
  isSelf,
  seat,
  seatCount,
  onRoleChanged,
  onRemoved,
}: {
  orgId: string;
  orgName: string;
  member: OrgMemberDTO;
  isSelf: boolean;
  seat: SeatSummaryDTO | null;
  seatCount: number;
  onRoleChanged: (userId: string, role: OrganizationRole) => void;
  onRemoved: (userId: string) => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      {isSelf ? null : seat ? (
        // Scaled org: removing a member frees a seat (adjusts the bill), so the
        // one-click remove gains a confirm popover disclosing the prorated
        // credit (design panel 3). Portaled, so the People card's overflow can't
        // clip it (the portal-popover-in-overflow rule).
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Popover.Trigger asChild>
            <Button variant="ghost" size="sm" loading={isPending}>
              {t('members.remove')}
            </Button>
          </Popover.Trigger>
          <Popover.Content align="end" width={280} className="p-3.5">
            <h3 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('seat.removeTitle', { name: member.name, org: orgName })}
            </h3>
            <p className="text-(--el-text-secondary) mt-2 flex items-start gap-2 font-sans text-xs leading-relaxed">
              <UserMinus
                className="text-(--el-text-muted) mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              <span>
                {t('seat.removeCredit', {
                  from: seatCount,
                  to: Math.max(0, seatCount - 1),
                  next: seatTotal(seat, Math.max(0, seatCount - 1)),
                  period: t('seat.period', { cadence: seat.cadence }),
                })}
              </span>
            </p>
            <p className="text-(--el-text-secondary) mt-2 flex items-start gap-2 font-sans text-xs leading-relaxed">
              <Info className="text-(--el-text-muted) mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t('seat.removeAccess', { org: orgName })}</span>
            </p>
            <div className="mt-3.5 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
                {tc('cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={isPending}
                onClick={() => {
                  setConfirmOpen(false);
                  handleRemove();
                }}
              >
                {t('members.remove')}
              </Button>
            </div>
          </Popover.Content>
        </Popover>
      ) : (
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
  seat,
  seats,
  now,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgName: string;
  seat: SeatSummaryDTO | null;
  seats: number;
  /** Unix seconds captured when the modal opened — the prorated-charge basis. */
  now: number;
  onInvited: (email: string) => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const locale = useLocale();
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

        {seat ? (
          // The prorated-charge cost note (scaled org only, design panel 2).
          // "Charged now" reflects 8.1.12's Stripe `always_invoice`. No pay-wall —
          // Send always works; this only discloses the cost.
          <div className="bg-(--el-tint-mint) flex items-start gap-3 rounded-(--radius-card) px-3.5 py-3">
            <span className="bg-(--el-page-bg) text-(--el-accent) inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control)">
              <UserPlus className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-(--el-text-secondary) font-sans text-xs leading-relaxed">
                <span className="font-semibold text-(--el-text-strong)">{t('seat.addTitle')} </span>
                {t('seat.addCharge', {
                  charge: now > 0 ? proratedAddCharge(seat, now) : seat.perSeatUsd,
                  renewal: formatRenewal(seat.currentPeriodEnd, locale),
                  cur: seatTotal(seat, seats),
                  next: seatTotal(seat, seats + 1),
                  n: seats + 1,
                  period: t('seat.period', { cadence: seat.cadence }),
                })}
              </p>
              <p className="text-(--el-text-muted) mt-1.5 font-sans text-xs leading-relaxed">
                {t('seat.addSub')}
              </p>
            </div>
          </div>
        ) : null}

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
