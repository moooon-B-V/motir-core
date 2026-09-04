import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_SETTINGS_NAV } from '@/lib/settings/projectSettingsNav';

// THE PUBLIC PAGE ROOM's MOUNT (Story MOTIR-3875 · MOTIR-4243) — the door, the
// page and the read. The rail row and the registry filter are pinned in
// `projectSettingsNav.test.ts`; this file is about the DESTINATION.
//
// These are SOURCE assertions for the two gates, and deliberately so. What they
// claim is ORDER, and order is exactly what a rendered test cannot see: a page
// whose `notFound()` moved below an `await` renders identically once everything
// has resolved, and answers 200 instead of 404 only to a reader on a self-hosted
// build. `tests/e2e/billing-selfhost.spec.ts` is the precedent for the shape and
// for why the ordering is load-bearing (the A/B in `motir-core/CLAUDE.md`).

const ROOT = process.cwd();
const PAGE = 'app/(authed)/settings/project/public/page.tsx';
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the Public page room 404s off-cloud (MOTIR-3908 · MOTIR-4243)', () => {
  const src = code(PAGE);

  it('`notFound()` is the FIRST statement, and nothing is awaited before it', () => {
    // Off-cloud there are no public projects, so this is not a hidden room but
    // an ABSENT one — the same 404 `publicSurfaceUnavailable()` gives the API
    // surface, and NOT the settings refusal state, which would say *this exists
    // and you may not see it* about a build where it does not.
    const gate = src.indexOf('if (!isCloud()) notFound()');
    expect(gate).toBeGreaterThan(-1);
    expect(src.slice(0, gate)).not.toMatch(/await /);
  });

  it('asks the CLOUD question, not the billing one', () => {
    // `docs/decisions/billing-tiering.md` §6: two questions, two predicates.
    // Public projects are cloud-only and have nothing to do with billing.
    expect(src).toContain("from '@/lib/billing/availability'");
    expect(src).toContain('isCloud');
    expect(src).not.toContain('isCloudBilling');
  });

  it('no route-level loading.tsx sits beside it — nothing may flush before the status', () => {
    const dir = join(ROOT, 'app/(authed)/settings/project/public');
    expect(readdirSync(dir)).not.toContain('loading.tsx');
    expect(src).not.toMatch(/<Suspense/);
  });
});

describe('the room island is mounted on the hero read (MOTIR-4171)', () => {
  const src = code(PAGE);

  it('renders `PublicPageEditor` with the three fields `getPublicHero` returns as its initial values', () => {
    // MOTIR-4243 shipped the read and left it unconsumed on purpose; the island
    // is the consumer, and a page that read the fields and rendered nothing
    // with them would be the mount without the room.
    expect(src).toContain("from './_components/PublicPageEditor'");
    expect(src).toContain('projectsService.getPublicHero(');
    expect(src).toContain('initial={initialHero}');
    expect(src).not.toContain('_initialHero');
  });

  it('threads the access level and the PUBLIC host’s URL, never the app origin', () => {
    // The not-yet-public band and the head link hang off `accessLevel`; the
    // link's host comes from `publicProjectUrl` (MOTIR-4242's accessor), which
    // is a server read the client island cannot make.
    expect(src).toContain("isPublic={ctx.project.accessLevel === 'public'}");
    expect(src).toContain('publicPageUrl={publicProjectUrl(ctx.project.identifier)}');
    expect(src).not.toContain('window.location');
  });
});

describe('the destination guard, and the key it is NOT allowed to re-declare', () => {
  const src = code(PAGE);

  it('guards on the registry entry `public-page`, after the cloud gate', () => {
    // MOTIR-2469: hiding is presentation and never protection. The rail row is
    // gone for a non-admin and the page is still one typed URL away.
    const gate = src.indexOf('if (!isCloud()) notFound()');
    const guard = src.indexOf("guardSettingsPage('public-page'");
    expect(guard).toBeGreaterThan(gate);
  });

  it('spells NO permission key of its own — the guard looks it up', () => {
    // The divergence this prevents is invisible in review: everything renders,
    // everything refuses, and the only symptom is that the wrong people are let
    // in. The entry's own key is asserted in `projectSettingsNav.test.ts`.
    const entry = PROJECT_SETTINGS_NAV.find((e) => e.id === 'public-page')!;
    expect(src).not.toContain(`'${entry.permission}'`);
  });

  it('has refusal copy of its own in BOTH catalogs', () => {
    // The guard renders `noAccess.section.<id>`; a missing key renders the key.
    for (const file of ['messages/en.json', 'messages/zh.json']) {
      const messages = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      expect(messages.settings.noAccess.section['public-page'], file).toBeTruthy();
      expect(messages.settings.nav.publicPage, file).toBeTruthy();
      expect(messages.settings.publicPage.title, file).toBeTruthy();
      expect(messages.settings.publicPage.subtitle, file).toBeTruthy();
    }
  });
});

describe("the design's forward-looking exemptions have expired (MOTIR-4205 → MOTIR-4243)", () => {
  it('the page the design named before it existed is now on disk', () => {
    expect(existsSync(join(ROOT, PAGE))).toBe(true);
  });

  it('and the guard rows that stood in for it are gone', () => {
    // `tests/design-asset-addresses.test.ts` carried three KNOWN rows so the
    // design could name the route and the page file before either existed. They
    // are self-destructing by construction — `carries no KNOWN entry that has
    // stopped applying` goes red while they linger — but that check reports a
    // stale EXEMPTION, not a missing deletion, so this says which three.
    const guard = readFileSync(join(ROOT, 'tests/design-asset-addresses.test.ts'), 'utf8');
    expect(guard).not.toContain("address: '/settings/project/public'");
    expect(guard).not.toContain(`path: '${PAGE}'`);
  });
});
