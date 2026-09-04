import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isCloud } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { isTenantDomainConfigured, tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import {
  publicSubdomainService,
  roleMayManageAddress,
} from '@/lib/services/publicSubdomainService';
import { customDomainService } from '@/lib/services/customDomainService';
import { workspacesService } from '@/lib/services/workspacesService';
import { guardSettingsPage } from '../_guard';
import { publicProjectPath, publicSiteOrigin } from '@/lib/publicProjects/urls';

import { PublicSubdomainCard } from './_components/PublicSubdomainCard';
import { CustomDomainsSection } from './_components/CustomDomainsSection';

// THE PUBLIC ADDRESS ROOM (Story MOTIR-3878 · MOTIR-4221) — where a workspace
// claims its subdomain and, once MOTIR-4229 lands, a project connects a domain
// the customer owns. Drawn by MOTIR-4211:
// `design/projects/public-address.mock.html` panels 0, 1, 2, 8, 9 +
// `design/projects/design-notes.md` § *Public address*.
//
// ── FOUR GATES, IN THIS ORDER ─────────────────────────────────────────────
//
// The first three are the Public page room's (MOTIR-4243), followed class for
// class because they are the same three questions in the same order:
//
// 1. `isCloud()` → `notFound()`. Public addresses are a CLOUD capability (ADR
//    §11): off-cloud the feature is ABSENT, not hidden, so the honest answer is
//    that there is no door. It runs FIRST — ahead of the session read — because
//    a capability this build does not have must not open a session to say so.
// 2. The session, then the active project.
// 3. THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
//    protection: the rail row is gone for a non-admin and this page is still one
//    typed URL away. The key comes from the registry entry `public-address` and
//    is never re-declared here.
//
// 4. ⚠️ AND A FOURTH THIS ROOM HAS THAT ITS NEIGHBOUR DOES NOT — the base
//    domain. A deployment that is cloud but has no `MOTIR_PUBLIC_TENANT_DOMAIN`
//    can serve every other public surface and cannot offer a subdomain, because
//    there is nothing to put one under. That is an OPERATOR state, not the
//    customer's, so it renders an explanation rather than a 404: a 404 here
//    would tell an admin the room does not exist when it does, and they would
//    go looking for the feature instead of for the variable.
//
// ── WHY `canManage` IS A WORKSPACE ROLE AND NOT THE RAIL'S KEY ────────────
//
// The rail row is gated on `project:manage_access` (the key this room's writes
// assert through `customDomainService`). The SUBDOMAIN's writes are gated on a
// different axis — the WORKSPACE role, owner or admin, which is what
// `publicSubdomainService` asserts, because ADR §3 makes a subdomain a property
// of the workspace rather than of one project. A project admin who is a
// workspace member therefore holds the door key and not the write key, and the
// pane renders every address with its controls ABSENT (design panel 8).
// `roleMayManageAddress` is the service's own predicate, asked rather than
// restated — a second `['owner','admin']` here would be a copy of a
// security-shaped rule whose drift shows up as controls that appear and refuse.
export default async function ProjectPublicAddressPage() {
  // Off-cloud (self-hosted GPL build): public addresses do not exist.
  if (!isCloud()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('project.empty.title')} description={t('project.empty.description')} />
      </div>
    );
  }

  const refused = await guardSettingsPage('public-address', ctx);
  if (refused) return refused;

  const header = (
    <header className="flex flex-col gap-1">
      <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
        {t('publicAddress.title')}
      </h1>
      <p className="font-sans text-sm text-(--el-text-muted)">
        {t.rich('publicAddress.subtitle', {
          projectName: ctx.project.name,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
    </header>
  );

  // Gate 4 — the operator state. See the note above for why this is not a 404.
  if (!isTenantDomainConfigured()) {
    return (
      <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
        {header}
        <EmptyState
          title={t('publicAddress.unavailable.title')}
          description={t('publicAddress.unavailable.description')}
        />
      </div>
    );
  }

  const [subdomain, membership, addresses] = await Promise.all([
    publicSubdomainService.getForWorkspace(ctx.workspaceId, ctx.userId),
    workspacesService.findMembership(ctx.userId, ctx.workspaceId),
    customDomainService.list({ key: ctx.project.identifier, actorUserId: ctx.userId, ctx }),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      {header}
      <PublicSubdomainCard
        workspaceId={ctx.workspaceId}
        baseDomain={tenantBaseDomain()}
        projectIdentifier={ctx.project.identifier}
        // ⚠️ RESOLVED HERE, NOT IN THE CARD. `MOTIR_PUBLIC_SITE_URL` is server
        // configuration, and the release confirm's last sentence tells a
        // customer where their projects go once nothing is claimed (ADR §7's
        // default-primary table, first row). A client component guessing the
        // origin would print a different address than the one the product
        // actually emits, on the one sentence whose whole job is that address.
        // The scheme is stripped because this is read, not followed.
        publicSiteHost={publicSiteOrigin().replace(/^https?:\/\//, '')}
        fallbackAddress={`${publicSiteOrigin().replace(/^https?:\/\//, '')}${publicProjectPath(
          ctx.project.identifier,
        )}`}
        subdomain={subdomain}
        canManage={membership ? roleMayManageAddress(membership.role) : false}
      />
      {/* MOTIR-4229's half. ⚠️ `canManage` IS `true` BY CONSTRUCTION HERE and is
          passed anyway: the destination guard above already refused anyone
          without `project:manage_access`, which is the key every one of the
          section's writes asserts — so on THIS page the two cannot disagree. The
          prop exists so the section does not inherit its host's gate by
          assumption. This is a DIFFERENT axis from the subdomain card's, whose
          writes are gated on the workspace role. */}
      <CustomDomainsSection projectKey={ctx.project.identifier} canManage addresses={addresses} />
    </div>
  );
}
