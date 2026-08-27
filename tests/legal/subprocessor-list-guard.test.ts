import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVISIBLE_TO_THIS_GUARD,
  LEAVING_BEFORE_LAUNCH,
  NOT_A_VENDOR_HOST,
  VENDOR_SIGNATURES,
} from '../helpers/subprocessorRegistry';

// MOTIR-3631 — the SUBPROCESSOR-LIST guard.
//
// `content/legal/subprocessors.md` is a published legal representation. Naming a
// company that receives nothing, or omitting one that does, is a false statement
// in a document customers and their auditors read — not a stale doc comment.
//
// ── Why a guard and not another careful re-read ─────────────────────────────
// The page went stale FOUR times on 2026-08-26/27, and each was caught by a
// person who happened to look:
//
//   1. the cookie inventory it derives from named 4 cookies; the product set 16
//   2. Brave Search — a live gateway upstream — appeared nowhere on the page
//   3. the Sentry row said "no Sentry SDK exists on origin/main", true when it
//      was written and false hours later when #2318 merged
//   4. the Privacy Policy's duplicate of the list omitted both
//
// Instances 1–3 were each fixed by measuring again, which works exactly once.
// Instance 4 was fixed by deleting the second copy, and that fix does not need
// repeating. This guard is the same treatment applied to the page itself.
//
// Instance 3 is the one that names the mechanism: that row carried its OWN
// instruction — "this page is amended in the same change" — and the change
// belonged to a different card, so nobody read it. A method section cannot fire
// when somebody else's pull request changes the answer. A test can.
//
// ── ⚠️ THE PAGE STATES THE LAUNCH SET, AND SO DOES THIS GUARD ───────────────
// Motir is not generally available, so nothing is receiving customer data today
// and the page's earlier live/pending split sorted every row into one bucket.
// The page now states the vendor set AS AT GENERAL AVAILABILITY, and every
// assertion below reads "will receive at launch" where it once read "receives".
//
// This is the difference between a guard that protects the page and one that
// corrupts it. `inngest` is still imported and is deliberately NOT on the page,
// because it will not exist at launch; a guard keyed to today's manifest would
// fail until somebody put a departing vendor back onto a published legal
// document. LEAVING_BEFORE_LAUNCH holds those, and the assertion below keeps
// them OFF the page rather than on it.
//
// ── ⚠️ WHAT THIS GUARD CAN AND CANNOT SEE ───────────────────────────────────
// It checks the REPOSITORY half of the page and nothing else:
//
//   CAN see — a dependency added to `package.json`, and an outbound host that
//   appears in `lib/` or `app/`. Instance 3 is exactly this. Instance 2 is NOT,
//   for the reason below, and this line said otherwise until the fixtures were
//   actually run.
//
//   CANNOT see — the transfer-basis column, the region column, and anything
//   about the DEPLOYED platform. Those need a credential CI does not have and a
//   judgement CI cannot make.
//
//   CANNOT see — five vendors that are on the page, are real, and leave no
//   trace here: Neon (Postgres wire protocol), motir-ai (a deployment secret),
//   OpenAI and Brave (reached THROUGH the gateway, never named by motir-core),
//   and Spaceship (a mailbox with no code path). They are enumerated in
//   `INVISIBLE_TO_THIS_GUARD` with their reasons, and asserted below to still be
//   on the page — which is the most this guard can do for them.
//
// ⚠️ AND IT DOES NOT CATCH INSTANCE 2, WHICH THIS CARD'S OWN ACCEPTANCE CLAIMED
// IT WOULD. Measured, not assumed — the four fixtures below were run:
//
//   fixture                                     assertion that caught it
//   delete Sentry's live row (instance 3)       lists every vendor … receiving data
//   delete Brave's row                          still carries the vendors … cannot see
//   add an unmapped outbound host               accounts for EVERY outbound host
//   demote an installed vendor to "not yet"     lists every vendor … receiving data
//
// Brave's DELETION is caught. Brave's ORIGINAL OMISSION could not have been:
// `api.search.brave.com` lives in `motir-gateway`, and a guard in motir-core has
// no access to another repository's tree. The card asked for instance 2 because
// whoever wrote the criterion — this session — had not yet worked out that the
// evidence was in a different repository. **The criterion was wrong; the guard
// is right; and the gap is real** — a NEW gateway upstream still arrives
// unguarded, and only the page's human method section will find it.
//
// **A green run means the page agrees with THIS repository. It does NOT mean the
// page is verified.** Saying so here matters more than it looks: a guard that
// half-checks the platform would license exactly the belief that let instance 3
// through, which is that somebody else had already looked.

const ROOT = join(__dirname, '..', '..');
const PAGE = join(ROOT, 'content', 'legal', 'subprocessors.md');
const SCAN_ROOTS = ['lib', 'app'];

/** Sections whose rows name a vendor that will receive data at general availability. */
const LIVE_SECTIONS = [
  'Core subprocessors',
  'Sign-in',
  'Product analytics',
  'AI features',
  'Optional integrations',
  'Corporate correspondence',
  'Payments',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every outbound host literal in the application tree. NOT truncated — the
 *  enumeration that missed Brave was a `head -20` over 137 of these. */
function hostsInTree(): Set<string> {
  const found = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)) found.add(m[1]!);
    }
  }
  return found;
}

/** The page's vendor rows, by section: the FIRST bolded span of each table row. */
function vendorsBySection(): Map<string, Set<string>> {
  const bySection = new Map<string, Set<string>>();
  let section = '';
  for (const line of readFileSync(PAGE, 'utf8').split('\n')) {
    const heading = /^##+\s+(.*)$/.exec(line);
    if (heading) section = heading[1]!;
    const row = /^\|\s+\*\*([^*]+)\*\*/.exec(line);
    if (!row) continue;
    if (!bySection.has(section)) bySection.set(section, new Set());
    bySection.get(section)!.add(row[1]!.trim());
  }
  return bySection;
}

function vendorsIn(prefixes: string[], bySection: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const [section, vendors] of bySection) {
    if (!prefixes.some((p) => section.startsWith(p))) continue;
    for (const v of vendors) out.add(v);
  }
  return out;
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const INSTALLED = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

const HOSTS = hostsInTree();
const BY_SECTION = vendorsBySection();
const LIVE = vendorsIn(LIVE_SECTIONS, BY_SECTION);

/** The evidence that makes a vendor live, or an empty array. */
function evidenceFor(sig: (typeof VENDOR_SIGNATURES)[number]): string[] {
  return [
    ...(sig.packages ?? []).filter((p) => INSTALLED.has(p)).map((p) => `package ${p}`),
    ...(sig.hosts ?? []).filter((h) => HOSTS.has(h)).map((h) => `host ${h}`),
  ];
}

describe('the subprocessor list agrees with the repository (MOTIR-3631)', () => {
  it('is not vacuous — the page parsed and the tree was walked', () => {
    // Without this, every assertion below passes on empty sets, which is how a
    // totality test dies quietly.
    expect(HOSTS.size).toBeGreaterThanOrEqual(20);
    expect(LIVE.size).toBeGreaterThanOrEqual(8);
    for (const prefix of LIVE_SECTIONS) {
      expect(
        [...BY_SECTION.keys()].some((s) => s.startsWith(prefix)),
        `the page no longer has a section starting "${prefix}" — a rename would silently empty the live set`,
      ).toBe(true);
    }
  });

  it('lists every vendor the repository proves will receive data at launch', () => {
    const missing = VENDOR_SIGNATURES.filter((s) => evidenceFor(s).length > 0)
      .filter((s) => !LIVE.has(s.vendor))
      .map((s) => `${s.vendor} (${evidenceFor(s).join(', ')})`);

    expect(
      missing,
      `these vendors have live evidence in the repository but no row in ` +
        `content/legal/subprocessors.md. Add the row — or, if the vendor is on its way out ` +
        `before general availability, record it in LEAVING_BEFORE_LAUNCH with the card that ` +
        `removes it and delete its VendorSignature.`,
    ).toEqual([]);
  });

  it('does not list a vendor the repository shows is receiving nothing', () => {
    // A vendor this guard has ALREADY declared it cannot see is exempt. Stripe is
    // the case that named the rule: its signature is real and its `api.stripe.com`
    // mapping still has to exist for the host-accounting test below, but the SDK
    // and every billing route live in motir-ai, so `evidenceFor` is empty here and
    // always will be. Without this filter the guard would call a TRUE row false —
    // and the remedy a reader would reach for is deleting an accurate disclosure
    // from a published legal page, which is the worst outcome this file can cause.
    const overclaimed = VENDOR_SIGNATURES.filter((s) => evidenceFor(s).length === 0)
      .filter((s) => LIVE.has(s.vendor))
      .filter((s) => !(s.vendor in INVISIBLE_TO_THIS_GUARD))
      .map((s) => s.vendor);

    expect(
      overclaimed,
      `these vendors sit in a live section but nothing in the repository reaches them. ` +
        `Naming a company that receives no data is a false statement — remove the row, or ` +
        `adjust its signature if the evidence changed shape.`,
    ).toEqual([]);
  });

  it('accounts for EVERY outbound host — as a vendor, or with a stated reason', () => {
    const claimed = new Set(VENDOR_SIGNATURES.flatMap((s) => s.hosts ?? []));
    const unaccounted = [...HOSTS]
      .filter((h) => !claimed.has(h) && !(h in NOT_A_VENDOR_HOST))
      .sort();

    expect(
      unaccounted,
      `these hosts appear in lib/ or app/ and are neither mapped to a vendor nor excused. ` +
        `Either add a VendorSignature, or add a NOT_A_VENDOR_HOST entry saying why no data ` +
        `of ours reaches it. This is the check that would have caught Brave.`,
    ).toEqual([]);
  });

  it('keeps the exclusion list honest — no entry may rot', () => {
    const stale = Object.keys(NOT_A_VENDOR_HOST)
      .filter((h) => !HOSTS.has(h))
      .sort();

    expect(
      stale,
      `these NOT_A_VENDOR_HOST entries no longer match anything in the tree. An exclusion ` +
        `nobody can check is indistinguishable from one nobody should trust — delete them.`,
    ).toEqual([]);
  });

  it('still carries the vendors this guard cannot see', () => {
    // The five that leave no repository trace. The guard cannot verify they are
    // live; it CAN refuse to let them vanish from the page unnoticed.
    const dropped = Object.keys(INVISIBLE_TO_THIS_GUARD)
      .filter((v) => !LIVE.has(v))
      .sort();

    expect(
      dropped,
      `these vendors are on the page for reasons this guard cannot re-derive, and one has ` +
        `disappeared from a live section. If that is deliberate, remove it from ` +
        `INVISIBLE_TO_THIS_GUARD in the same change and say where it went.`,
    ).toEqual([]);
  });

  it('keeps a departing vendor OFF the page', () => {
    // The inverse of every other assertion here, and the one that lets the page
    // describe launch rather than this afternoon. A vendor on its way out is
    // absent by decision, and the decision is named in LEAVING_BEFORE_LAUNCH
    // with the card that removes it — so the omission is attributable rather
    // than something that just happened to nobody's account.
    const resurrected = Object.keys(LEAVING_BEFORE_LAUNCH)
      .filter((v) => LIVE.has(v))
      .sort();

    expect(
      resurrected,
      `these vendors are recorded as leaving before general availability, yet they appear ` +
        `in a live section of the page. Either the retirement was abandoned — in which case ` +
        `remove the LEAVING_BEFORE_LAUNCH entry and add a VendorSignature — or the row was ` +
        `added by mistake and states something that will not be true at launch.`,
    ).toEqual([]);
  });
});
