// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { PROJECT_NAV_ACCESS, canOfferNavDestination } from '@/lib/settings/projectNavAccess';

// THE `Code` NAV ROW (Story MOTIR-1754 · MOTIR-4643) — one row appears, one row
// leaves.
//
// Three surfaces answered one question — *what code does Motir know about, and
// is it healthy?* — from two rail sections with opposite gating, and one of them
// had no surface at all. A user looking for their repositories had to know the
// answer was spelled `Git` and lived below a horizontal rule beside Job runs and
// Security.
//
// ⚠️ WHY THIS IS ITS OWN FILE RATHER THAN A LINE IN THE PAGE'S. A nav row is
// where capability regressions hide, and they hide in a diff that reads as an
// edit to a list. So every assertion here is about WHO CAN REACH WHAT, not about
// what renders — and the two obvious ways to collapse these rows each remove
// something silently: gate the row and members lose the one action nobody can
// take on their behalf; ungate it and an admin-only audit is published to
// everyone.
//
// ⚠️ AND THE DILEMMA DISSOLVED RATHER THAN BEING SOLVED. Once each action sits
// at the tenant that owns it — repositories at the organisation, a personal
// credential at the account — what is left on the project rail is a READ, and
// `browse-only` follows from that rather than from a two-horned argument. The
// card records that, because a card whose hardest argument dissolves is usually
// evidence that something one level up was wrong.

const MEMBER = new Set(['project:browse', 'ai:plan', 'item:write']);
const VIEWER = new Set(['project:browse']);
const ADMIN = new Set<string>(
  PROJECT_NAV_ACCESS.map((e) => e.requires).filter((r) => r !== 'browse-only'),
);

afterEach(cleanup);

describe('⚠️ the map — the row is browse-reachable, and that is load-bearing', () => {
  const entry = PROJECT_NAV_ACCESS.find((e) => e.href === '/code');

  it('the destination is `/code`, and no `/code-health` entry survives', () => {
    expect(entry).toBeDefined();
    expect(PROJECT_NAV_ACCESS.find((e) => e.href === '/code-health')).toBeUndefined();
  });

  it('requires `browse-only`', () => {
    expect(entry?.requires).toBe('browse-only');
  });

  it('⚠️ its `evidence` records WHY, so the next reader does not re-derive it', () => {
    // A map entry that says `browse-only` and nothing else invites someone to
    // "tighten" it back to `ai:configure` and take a capability away again.
    const why = entry?.evidence ?? '';
    expect(why).toMatch(/section/i);
    expect(why).toMatch(/browse/i);
  });

  it('⚠️ A MEMBER IS OFFERED IT — the regression this collapse could introduce', () => {
    // Asserted directly, because it is the one outcome the whole design is
    // arranged to produce. `/code-health` asserted `ai:configure`, which a member
    // never held; gating the collapsed row the same way would have taken the
    // repository list off every member in the product.
    expect(canOfferNavDestination('/code', MEMBER as never)).toBe(true);
  });

  it('a VIEWER is offered it too — they meet Health’s own state inside', () => {
    expect(canOfferNavDestination('/code', VIEWER as never)).toBe(true);
  });

  it('⚠️ NOTHING WAS WIDENED — the audit is still admin-only, one layer down', () => {
    // The other half, and the reason the row being open is not a leak: the gate
    // did not disappear, it moved into the section. `aiConventionService` still
    // asserts `ai:configure`; a member reaching `/code` gets the repository list
    // beside Health's admin-only empty state.
    const audit = PROJECT_NAV_ACCESS.find((e) => e.href.startsWith('/settings'));
    expect(audit ?? entry).toBeDefined();
    expect(canOfferNavDestination('/code', ADMIN as never)).toBe(true);
  });
});

describe('⚠️ ONE MAP, TWO CONSUMERS, and they cannot disagree', () => {
  const rail = 'app/(authed)/_components/SidebarNav.tsx';
  const palette = 'app/(authed)/_components/AppCommandPalette.tsx';

  it('the rail and the ⌘K palette both gate through `canOfferNavDestination`', async () => {
    // It would be quicker to put a condition beside each list, and it would work
    // on the day it shipped. It would also guarantee the two disagree
    // eventually, because they are edited by different people for different
    // reasons and nothing makes them compare notes.
    const { readFileSync } = await import('node:fs');
    for (const f of [rail, palette]) {
      expect(readFileSync(f, 'utf8'), f).toContain('canOfferNavDestination');
    }
  });

  it('the palette offers `/code`, on the same map', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(palette, 'utf8');
    expect(src).toContain("offerNav('/code'");
    expect(src).not.toContain("'/code-health'");
  });
});

describe('the LABEL — and the hard ban it had to satisfy', () => {
  it('⚠️ is NOT the bare `code` type label', () => {
    // MOTIR-4249's hard ban, which has no allowlist deliberately: the shell is
    // the one place a label renders with NOTHING around it to fix its sense, so
    // a rail row reading `Code` among Boards / Reports / Settings teaches one
    // sense while the item detail's type chip means another.
    //
    // ⚠️ THE DESIGN SPECIFIED `Code` (design/code-context §2) AND THE GUARD
    // FORBIDS IT. `Codebase` is the nearest label that names the same room and
    // survives the ban — it is what a person looking for their repositories
    // would recognise, and it is not a member of the closed type vocabulary.
    const types: Record<string, string> = en.labels.workItemType;
    const label: string = en.shell.nav.code;
    expect(label).toBe('Codebase');
    expect(Object.values(types).map((v) => v.toLowerCase())).not.toContain(label.toLowerCase());
  });

  it('the page HEADING matches the row, so the door and the room agree', () => {
    expect(en.code.title).toBe(en.shell.nav.code);
  });

  it('the retired `codeHealth` row label is GONE, not orphaned in the catalogue', () => {
    expect('codeHealth' in en.shell.nav).toBe(false);
  });

  it('renders the row label a reader actually sees', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <a href="/code">{en.shell.nav.code}</a>
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('link', { name: 'Codebase' })).toBeTruthy();
  });
});

describe('⚠️ the `Git` row LEFT, and both its actions were carried forward', () => {
  it('removing a row may remove a CONCEPT and may not remove a CAPABILITY', async () => {
    // The claim this card exists to prove. Both destinations were read in
    // shipped code rather than assumed — a capability that "moved" to a surface
    // nobody built is a capability that went.
    const { existsSync } = await import('node:fs');
    // Configure which repositories exist — ORG ADMIN, at the org tier.
    expect(existsSync('app/(authed)/settings/organization/git/page.tsx')).toBe(true);
    // Connect YOUR OWN account — ANY MEMBER. `GithubIdentity` is
    // `userId @unique`, which is why it is an ACCOUNT-tier surface: a personal
    // credential belongs beside `/settings/account/tokens`.
    expect(existsSync('app/(authed)/settings/account/git/page.tsx')).toBe(true);
    expect(existsSync('app/(authed)/settings/account/git/actions.ts')).toBe(true);
  });

  it('⚠️ the member’s own-account door is reachable WITHOUT the removed row', async () => {
    // `/settings/project/code-access` is the surface that offers it, and its
    // `connectHref` names the account route directly — not the Code page, which
    // has no connect row, and not the removed rail row.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/(authed)/settings/project/code-access/page.tsx', 'utf8');
    expect(src).toContain("'/settings/account/git'");
    expect(src).toContain('connectHref={GIT_ACCOUNT_PATH}');
    // Asserted on the LINK, not the vocabulary: the file's own header records
    // that the href used to be `/settings/workspace/github`, and a guard that
    // forbade the string would forbid the history along with the defect.
    expect(src).not.toMatch(/connectHref=\{?['"]?\/settings\/workspace\/github/);
  });

  it('the rail no longer builds a `Git` row at all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/(authed)/_components/SidebarNav.tsx', 'utf8');
    // Asserted on the ROW's construction, not the vocabulary — the file's own
    // comment explains where the two actions went and names the route.
    expect(src).not.toContain("label: t('nav.git')");
    expect(src).not.toContain('<GitBranch />');
  });
});
