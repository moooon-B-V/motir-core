import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3448 — allocation rows 11–14: the four heavy pages outside the project
// rail. Two of them stop reading in series, and one of THOSE is the route the
// whole in-page decision was measured on.

const ROOT = resolve(__dirname, '..', '..');
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const S = 'app/(authed)/settings';
const ROWS = [
  { row: 11, rel: `${S}/workspace/jobs/page.tsx`, width: '60rem' },
  { row: 12, rel: `${S}/workspace/gitlab/page.tsx`, width: null },
  { row: 13, rel: `${S}/organization/page.tsx`, width: '45rem' },
  { row: 14, rel: `${S}/organization/billing/page.tsx`, width: '64rem' },
] as const;

describe('all four mount the shared frame (MOTIR-3448)', () => {
  it.each(ROWS)(
    'row $row · $rel mounts SettingsPaneFrame and draws no frame of its own',
    ({ rel }) => {
      const src = code(rel);
      expect(src).toMatch(/from '@\/components\/settings\/SettingsPaneFrame'/);
      expect(src).toMatch(/fallback=\{<SettingsPaneFrame\s*\/>\}/);
      expect(src).not.toMatch(/animate-pulse/);
    },
  );

  it.each(ROWS)('row $row · adds NO route-level loading.tsx', ({ rel }) => {
    expect(code(rel)).not.toMatch(/loading\.tsx/);
  });

  it.each(ROWS.filter((r) => r.width !== null))(
    'row $row · keeps its own centred column at $width',
    ({ rel, width }) => {
      // The frame carries no width — the column is the page's, so a stale entry
      // in the asset's width table cannot move the content. (Row 14 is exactly
      // that case: the table says 48rem, the page has always said 64rem.)
      expect(code(rel)).toContain(`max-w-[${width!}]`);
    },
  );

  it('row 12 · the boundary sits INSIDE GitSettingsShell, whose header is pure t(...)', () => {
    const src = code(`${S}/workspace/gitlab/page.tsx`);
    const shell = src.indexOf('<GitSettingsShell provider="gitlab">\n      {bannerTone');
    expect(shell).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(shell);
  });
});

describe('⚠️ row 14 is a DECIDER — the route the boundary decision was measured on', () => {
  const src = code(`${S}/organization/billing/page.tsx`);

  it('notFound() is the FIRST statement, and the boundary comes after it', () => {
    // Off-cloud this route 404s, and `tests/e2e/billing-selfhost.spec.ts` asserts
    // it. With a route-level boundary above it that 404 came back 200 — the A/B
    // in `motir-core/CLAUDE.md`. Nothing may flush before the status is settled.
    const gate = src.indexOf('if (!isCloudBilling()) notFound()');
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(gate);
    // …and it really is first: no await precedes it.
    expect(src.slice(0, gate)).not.toMatch(/await /);
  });

  it('no loading.tsx sits beside it', () => {
    expect(src).not.toMatch(/loading\.tsx/);
  });
});

describe('the reads (MOTIR-3448)', () => {
  it('row 11 · jobs reads the role, the DLQ count and the list in ONE wave', () => {
    // The asset expected TWO waves, with the role preceding the others because
    // "the role selects which list is fetched". Measured: it does not — the tab
    // is narrowed by `showSystemTab`, an env var compared against the session
    // email, with no read behind it. All three are independent.
    const src = code(`${S}/workspace/jobs/page.tsx`);
    expect(src).toMatch(/const \[role, dlqCount, list\] = await allSettledOrThrow\(\[/);
    expect(src).toMatch(/workspacesService\.getMemberRole\(userId, workspaceId\)/);
    expect(src).toMatch(/jobsDashboardService\.countDLQ\(/);
    // The tab is still chosen ABOVE the wave, from the query string and the env.
    const tab = src.indexOf('let requestedTab');
    expect(tab).toBeGreaterThan(-1);
    expect(src.indexOf('allSettledOrThrow([')).toBeGreaterThan(tab);
    // Three CALL sites, and they are the three arms of ONE ternary — so exactly
    // one read is issued, not three. Matched on the call form `list…({` so the
    // two `typeof jobsDashboardService.listX` type positions below do not count.
    const calls = src.match(/jobsDashboardService\.list\w+\(\{/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(src).toMatch(/requestedTab === 'dlq'\s*\?\s*jobsDashboardService\.listDLQ\(/);
    // …and all three sit inside the wave, so none is a second, earlier read.
    const wave = src.slice(src.indexOf('allSettledOrThrow(['), src.indexOf('const isOwner'));
    expect(wave.match(/jobsDashboardService\.list\w+\(\{/g) ?? []).toHaveLength(3);
  });

  it('row 13 · organization reads the members and the AI access in ONE wave', () => {
    // The asset counts three serial reads; `listUserWorkspaces` is already
    // concurrent in the gate's own Promise.all, so the genuine win is two.
    const src = code(`${S}/organization/page.tsx`);
    expect(src).toMatch(
      /const \[\{ total: memberCount \}, aiAccess\] = await allSettledOrThrow\(\[/,
    );
    expect(src).toMatch(/organizationsService\.listMembers\(/);
    expect(src).toMatch(/billingService\.getAiAccess\(/);
    // `resolveActiveOrganization` stays ABOVE: it decides the no-active-org state
    // and supplies the org name the header interpolates.
    const resolve_ = src.indexOf('resolveActiveOrganization');
    expect(src.indexOf('<Suspense')).toBeGreaterThan(resolve_);
  });

  it('rows 12 and 14 have ONE read each — nothing to make concurrent', () => {
    const gitlab = code(`${S}/workspace/gitlab/page.tsx`);
    expect((gitlab.match(/gitlabConnectionService\./g) ?? []).length).toBe(1);
    const billing = code(`${S}/organization/billing/page.tsx`);
    expect((billing.match(/organizationsService\.listMembers\(/g) ?? []).length).toBe(1);
  });

  it('every multi-arm read uses allSettledOrThrow, never a bare Promise.all', () => {
    // Each arm opens a transaction (MOTIR-3066). Row 13's GATE keeps its existing
    // `Promise.all` — it predates this card and its arms are unchanged.
    for (const { rel } of ROWS) {
      const below = code(rel).split('<Suspense')[1] ?? '';
      expect(below, rel).not.toMatch(/await Promise\.all\(\[/);
    }
  });
});
