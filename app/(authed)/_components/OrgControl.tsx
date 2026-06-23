'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Coins, CreditCard, Plus, Settings, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import {
  createOrganizationAction,
  createWorkspaceAction,
  switchOrganizationAction,
} from '../_actions';

export interface OrgControlActiveOrg {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface OrgControlProps {
  activeOrg: OrgControlActiveOrg | null;
  /** Every org the signed-in user belongs to — the switch-org list shows only when ≥2. */
  orgs: OrganizationDTO[];
  /** True on a Motir cloud build (`MOTIR_CLOUD`) — gates the "Billing & plans"
   *  menu row (Story 8.1.7, design/billing panel 1). Off-cloud the commercial
   *  surface does not exist, so the row is hidden entirely (ADR §6). */
  cloudBilling: boolean;
}

// The organization control in the app shell (Story 6.10.5, design/org-admin
// panel 1). The ORG is ALWAYS the top-left anchor (progressive disclosure: the
// org is permanent chrome — an OPC is just an org of one). It is a menu button,
// not only a switcher: the menu carries Settings · Members · Usage & cost ·
// Billing & plans (cloud only, Story 8.1.7) · New workspace, then — only when the
// account is in ≥2 orgs — a "Switch organization" section. The WORKSPACE switcher
// (rendered alongside by the shell only at ≥2 workspaces) is a separate control.
export function OrgControl({ activeOrg, orgs, cloudBilling }: OrgControlProps) {
  const t = useTranslations('orgAdmin');
  const ts = useTranslations('shell');
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // No org resolved (a not-yet-provisioned account) — render nothing; the
  // workspace switcher / create path still covers the cold-start case.
  if (!activeOrg) return null;

  const multiOrg = orgs.length >= 2;

  function handleSwitchOrg(orgId: string) {
    if (orgId === activeOrg!.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await switchOrganizationAction(orgId);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="md"
            rightIcon={<ChevronDown className="h-4 w-4" />}
            aria-label={t('menu.ariaLabel')}
          >
            <span className="flex items-center gap-2">
              <OrgAvatar name={activeOrg.name} />
              {/* font-serif: the org name is a header IDENTITY label — it wears the
                  headline role so the `data-type` axis re-types the header chrome
                  too (see ProjectSwitcher). */}
              <span className="max-w-[20ch] truncate font-serif">{activeOrg.name}</span>
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={288} className="py-1">
          <ul role="list" className="px-1">
            <li>
              <MenuLink href="/settings/organization" onNavigate={() => setOpen(false)}>
                <Settings className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                {t('menu.settings')}
              </MenuLink>
            </li>
            <li>
              <MenuLink href="/settings/organization/members" onNavigate={() => setOpen(false)}>
                <Users className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                {t('menu.members')}
              </MenuLink>
            </li>
            <li>
              {/* Usage & cost — the org cost dashboard (7.2.11, design ai-usage
                  panel 1). The usage half of the "Billing & usage" promise; the
                  billing/checkout half stays "Coming soon" (Epic 8). */}
              <MenuLink href="/settings/organization/usage" onNavigate={() => setOpen(false)}>
                <Coins className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                {t('menu.usage')}
              </MenuLink>
            </li>
            {cloudBilling ? (
              <li>
                {/* Billing & plans — the org's commercial home (Story 8.1.7,
                    design/billing panel 1). The row the ai-usage design left as a
                    passive "Coming soon" is now ACTIVE. Cloud-only (ADR §6): on a
                    self-hosted build it is hidden entirely (no billing surface). */}
                <MenuLink href="/settings/organization/billing" onNavigate={() => setOpen(false)}>
                  <CreditCard className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                  {t('menu.billing')}
                </MenuLink>
              </li>
            ) : null}
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCreateWsOpen(true);
                }}
                className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
              >
                <Plus className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                <span className="flex-1">{t('menu.newWorkspace')}</span>
              </button>
            </li>
          </ul>

          {multiOrg ? (
            <>
              <div className="my-1 h-px bg-(--el-border)" />
              <div className="px-3 pb-1 pt-2">
                <span className="text-(--el-text-secondary) font-mono text-xs uppercase tracking-wider">
                  {t('menu.switchOrg')}
                </span>
              </div>
              <ul role="list" className="px-1">
                {orgs.map((org) => {
                  const isActive = org.id === activeOrg.id;
                  return (
                    <li key={org.id}>
                      <button
                        type="button"
                        onClick={() => handleSwitchOrg(org.id)}
                        disabled={isPending}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left',
                          'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none',
                          'disabled:pointer-events-none disabled:opacity-50',
                          isActive && 'bg-(--el-surface)',
                        )}
                      >
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                          {isActive ? (
                            <Check className="h-4 w-4" style={{ color: 'var(--el-accent)' }} />
                          ) : null}
                        </span>
                        <OrgAvatar name={org.name} />
                        <span
                          className={cn(
                            'flex-1 truncate font-sans text-sm text-(--el-text)',
                            isActive && 'font-semibold',
                          )}
                        >
                          {org.name}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="px-1 pb-1 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setCreateOrgOpen(true);
                  }}
                  className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
                >
                  <Plus className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                  {t('menu.createOrg')}
                </button>
              </div>
            </>
          ) : null}
        </Popover.Content>
      </Popover>

      <NameModal
        open={createWsOpen}
        onOpenChange={setCreateWsOpen}
        title={t('menu.newWorkspace')}
        label={ts('workspaceSwitcher.nameLabel')}
        submitLabel={t('menu.newWorkspace')}
        run={(name) => createWorkspaceAction(name)}
        onDone={() => router.refresh()}
      />
      <NameModal
        open={createOrgOpen}
        onOpenChange={setCreateOrgOpen}
        title={t('menu.createOrg')}
        label={t('settings.nameLabel')}
        submitLabel={t('menu.createOrg')}
        run={(name) => createOrganizationAction(name).then(() => undefined)}
        onDone={() => router.refresh()}
        onError={() => toast({ variant: 'error', title: t('settings.saveError') })}
      />
    </>
  );
}

// A small square initial chip for an organization — distinct from the round
// USER avatar. `--radius-control`, lavender tint, charcoal text (AA-safe).
function OrgAvatar({ name }: { name: string }) {
  const initial = (name || '?').charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="bg-(--el-tint-lavender) text-(--el-text-strong) inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-control) font-sans text-[0.625rem] font-semibold"
    >
      {initial}
    </span>
  );
}

function MenuLink({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onNavigate}
      className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
    >
      {children}
    </a>
  );
}

// A minimal name-only create modal shared by "New workspace" and "Create
// organization". (The richer create-workspace dialog — copy-source picker,
// tier-2 reveal — is gated on the 6.10.9 copy-on-create backend; design
// create-workspace.mock.html.)
function NameModal({
  open,
  onOpenChange,
  title,
  label,
  submitLabel,
  run,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  submitLabel: string;
  run: (name: string) => Promise<unknown>;
  onDone: () => void;
  onError?: () => void;
}) {
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      try {
        await run(value);
        setName('');
        onOpenChange(false);
        onDone();
      } catch {
        onError?.();
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setName('');
        onOpenChange(o);
      }}
      title={title}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label={label} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" type="submit" loading={isPending} disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
