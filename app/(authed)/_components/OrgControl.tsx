'use client';

import { useState, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { afterContextSwitchTarget } from '@/lib/navigation/afterContextSwitch';
import {
  Check,
  ChevronDown,
  Coins,
  CreditCard,
  Plus,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import { orgCan } from '@/lib/organizations/capabilities';
import { createOrganizationAction, switchOrganizationAction } from '../_actions';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';

export interface OrgControlActiveOrg {
  id: string;
  name: string;
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
  /**
   * Whether the active org has ≥2 workspaces (`isWorkspaceTierRevealed`, the
   * shell's one reveal verdict). It decides whether an org MEMBER keeps the
   * `Settings` row: below the reveal it is their only door to the folded-in
   * workspace sections (Leave workspace among them); above it the org page has
   * nothing of theirs and answers 404 (MOTIR-6312 · panel 3a / 3b).
   */
  workspaceTierRevealed: boolean;
}

// The organization control in the app shell (Story 6.10.5, design/org-admin
// panel 1). The ORG is ALWAYS the top-left anchor (progressive disclosure: the
// org is permanent chrome — an OPC is just an org of one). It is a menu button,
// not only a switcher: the menu carries Settings · Members · Usage & cost ·
// Billing & plans (cloud only, Story 8.1.7) · New workspace, then — only when the
// account is in ≥2 orgs — a "Switch organization" section. The WORKSPACE switcher
// (rendered alongside by the shell only at ≥2 workspaces) is a separate control.
export function OrgControl({
  activeOrg,
  orgs,
  cloudBilling,
  workspaceTierRevealed,
}: OrgControlProps) {
  const t = useTranslations('orgAdmin');
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // No org resolved (a not-yet-provisioned account) — render nothing; the
  // workspace switcher / create path still covers the cold-start case.
  if (!activeOrg) return null;

  const multiOrg = orgs.length >= 2;

  // WHAT THIS ROLE MAY DO AT THE ORG decides which rows exist (MOTIR-6312 ·
  // `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 3). A
  // row a role cannot use is ABSENT, never disabled (MOTIR-2462): each org-tier
  // row opened a page that refused a Member, and `New workspace` a create the
  // server refuses them (MOTIR-6309). The answers come from the ONE capability
  // table (`lib/organizations/capabilities.ts`), read off the role the layout
  // already hands this control — no second fetch.
  const canManageOrg = orgCan(activeOrg.role, 'manageOrgSettings');
  const canManageWorkspaces = orgCan(activeOrg.role, 'manageWorkspaces');
  // A Member keeps `Settings` only BELOW the reveal, where it is the door to the
  // folded-in workspace sections (3a). Above it the page 404s for them (3d).
  const showSettings = canManageOrg || !workspaceTierRevealed;
  const hasOrgRows = showSettings || canManageOrg || canManageWorkspaces;

  // 3b · a Member, 2+ workspaces, ONE org: the menu would hold nothing — no org
  // page to open and no org to switch to — so the name is a plain LABEL, not a
  // button with a chevron over an empty popover.
  if (!hasOrgRows && !multiOrg) {
    return (
      <span className="flex min-w-0 shrink-3 items-center px-(--spacing-control-x) font-sans text-sm text-(--el-text)">
        <span className="min-w-0 max-w-[20ch] truncate font-serif">{activeOrg.name}</span>
      </span>
    );
  }

  function handleSwitchOrg(orgId: string) {
    if (orgId === activeOrg!.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await switchOrganizationAction(orgId);
      setOpen(false);
      // Switching org re-points the active workspace + project (the 8.8.28
      // cascade), so the current URL may be scoped to the OLD org and client
      // islands won't re-seed on a bare refresh (MOTIR-1312). Land on the
      // signed-in landing — abandoning the stale deep URL + remounting islands
      // — and only refresh in place when already there. The destination is the
      // helper's to decide, not this file's (MOTIR-5132).
      const target = afterContextSwitchTarget(pathname);
      if (target) router.push(target);
      else router.refresh();
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
            // An ANCESTOR tier of the bar's context path, so it truncates — and it
            // yields width before the project does (MOTIR-4897 ·
            // design/shell/design-notes.md § *The context path's truncation
            // budget*). Without `min-w-0` a flex child cannot go below its content,
            // which here is the whole capped name: at `xl` the row overflowed and
            // pushed the project tier under the right cluster. The chevron's span
            // is `aria-hidden` and keeps its minimum.
            className="min-w-0 shrink-3 [&>span:not([aria-hidden])]:min-w-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              {/* No mark. An organization carries none — there is no way to give
                  it one, so any mark here would be generated from the name
                  (`docs/decisions/entity-marks.md` §2).
                  The NAME is therefore always rendered: it used to be
                  `hidden xl:inline`, which was only survivable while the mark
                  stood in for it between `md` and `xl`. Removing the mark without
                  this would leave a ghost button holding a chevron. Measured at
                  +2px vs the old mark form at 768px, 0 overflow at every band
                  (MOTIR-2674, `design/shell/design-notes.md` § *The ladder*).
                  font-serif: the org name is a header IDENTITY label — it wears
                  the headline role so the `data-type` axis re-types the header
                  chrome too (see ProjectSwitcher). */}
              <span className="min-w-0 max-w-[20ch] truncate font-serif">{activeOrg.name}</span>
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={288} className="py-1">
          {hasOrgRows ? (
            <ul role="list" className="px-1">
              {showSettings ? (
                <li>
                  <MenuLink href="/settings/organization" onNavigate={() => setOpen(false)}>
                    <Settings className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                    {t('menu.settings')}
                  </MenuLink>
                </li>
              ) : null}
              {canManageOrg ? (
                <>
                  <li>
                    {/* Security — the org's require-2FA policy (Story MOTIR-1215 ·
                  MOTIR-3646, design/org-admin/security-policy panel 1). Directly
                  under Settings, where the design puts it: it is a
                  settings-shaped destination, and keeping it above Members holds
                  the two account-level concerns together. A route with no door
                  is not shipped. */}
                    <MenuLink
                      href="/settings/organization/security"
                      onNavigate={() => setOpen(false)}
                    >
                      <ShieldCheck className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                      {t('menu.security')}
                    </MenuLink>
                  </li>
                  <li>
                    <MenuLink
                      href="/settings/organization/members"
                      onNavigate={() => setOpen(false)}
                    >
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
                      <MenuLink
                        href="/settings/organization/billing"
                        onNavigate={() => setOpen(false)}
                      >
                        <CreditCard className="text-(--el-text-muted) h-4 w-4" aria-hidden />
                        {t('menu.billing')}
                      </MenuLink>
                    </li>
                  ) : null}
                </>
              ) : null}
              {canManageWorkspaces ? (
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
              ) : null}
            </ul>
          ) : null}

          {multiOrg ? (
            <>
              {hasOrgRows ? <div className="my-1 h-px bg-(--el-border)" /> : null}
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

      {canManageWorkspaces ? (
        <CreateWorkspaceDialog
          open={createWsOpen}
          onOpenChange={setCreateWsOpen}
          onCreated={() => router.refresh()}
        />
      ) : null}
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

/**
 * A refusal the action RETURNED rather than threw — a business rule saying no,
 * carrying the message the reader should see (MOTIR-5130). Resolving to
 * anything else, `undefined` included, is a success.
 */
type NameModalFailure = { error: string };

// A minimal name-only create modal, for "Create organization". ("New workspace"
// moved to the shared `CreateWorkspaceDialog`, which the org settings page's
// Workspaces card opens too — MOTIR-6312.) (The richer create-workspace dialog — copy-source picker,
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
  run: (name: string) => Promise<NameModalFailure | void>;
  onDone: () => void;
  /** Called with the refusal's own message when `run` RETURNS one, and with
   *  nothing when it THROWS (a genuine fault has no message worth showing). */
  onError?: (message?: string) => void;
}) {
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      try {
        const failure = await run(value);
        if (failure) {
          // A REFUSAL is not a fault and not a success: nothing was created, so
          // the modal stays open with the name intact while the message
          // explains why — the reader can rename or cancel rather than watch
          // the dialog vanish with no account of itself.
          onError?.(failure.error);
          return;
        }
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
