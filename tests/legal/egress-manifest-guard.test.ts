import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVISIBLE_TO_THIS_GUARD,
  LEAVING_BEFORE_LAUNCH,
  NOT_A_VENDOR_HOST,
  VENDOR_SIGNATURES,
} from '../helpers/subprocessorRegistry';

// MOTIR-3631 — the SUBPROCESSOR-LIST guard, RE-SUBJECTED by MOTIR-4008.
//
// ── ⚠️ WHAT CHANGED, AND WHY THE GUARD DID NOT SIMPLY MOVE ─────────────────
// It used to read TWO things: the rows we DISCLOSE (`content/legal/*.md`) and
// the EVIDENCE that a vendor receives anything (this repository's
// `package.json` and the outbound hosts in `lib/` and `app/`). The pages have
// moved to `motir-marketing`. **The evidence cannot follow them** — run there,
// this guard would measure a marketing website's dependency tree, pass forever,
// and say nothing about the software the page is about. That is the cheap
// answer and it is a lie.
//
// So the guard splits at the repository line
// (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §E), and this half keeps
// the part that can only live here:
//
//   THIS FILE          the MEASUREMENT — `lib/legal/egressManifest.ts` against
//                      this tree's own signatures. No page is read.
//   motir-marketing    the DISCLOSURE — every vendor row on its `subprocessors.md`
//                      has a manifest entry and vice versa (MOTIR-4011).
//
// **It fires on the pull request that adds the dependency, in the repository
// that added it**, which is instance 3's exact shape below, preserved whole. A
// guard living only in the consumer would report that `motir-core` broke a
// published legal page after it had already shipped.
//
// ── ⚠️ THE ABSENCE QUESTION, ASKED OF THIS FILE ────────────────────────────
// `plan-rules/type-migration.md`: *if this were absent, what would start
// happening?* **A published legal document would silently drift from what the
// software actually does.** So it is a SUPPRESSOR, not a client: it leaves LAST
// or not at all, and it is explicitly NOT deleted by the page's move.
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
// Instance 3 names the mechanism: that row carried its OWN instruction — "this
// page is amended in the same change" — and the change belonged to a different
// card, so nobody read it. A method section cannot fire when somebody else's
// pull request changes the answer. A test can.
//
// ── ⚠️ THE MANIFEST STATES THE LAUNCH SET, AND SO DOES THIS GUARD ──────────
// Motir is not generally available, so nothing receives customer data today.
// `VENDOR_SIGNATURES`'s semantics are unchanged: a signature means "this vendor
// will receive data at launch", not "this import exists right now". A vendor on
// its way out belongs in `LEAVING_BEFORE_LAUNCH`, and the assertions below keep
// it OFF the manifest rather than on it.
//
// ── ⚠️ WHAT THIS GUARD CAN AND CANNOT SEE — unchanged by the split ─────────
//   CAN see — a dependency added to `package.json`, and an outbound host that
//   appears in `lib/` or `app/`. Instance 3 is exactly this.
//
//   CANNOT see — the transfer-basis column, the region column, and anything
//   about the DEPLOYED platform. Those need a credential CI does not have and a
//   judgement CI cannot make, and they are the page's, not the manifest's.
//
//   CANNOT see — the vendors that leave no trace here: Neon (Postgres wire
//   protocol), OpenAI / Brave / the planner model set (reached THROUGH the
//   gateway), Spaceship (a mailbox), Stripe (its SDK and every billing route are
//   in motir-ai). They ride the manifest as `not-evidenced-here` WITH THEIR
//   REASON, and the assertions below keep them on it — which is the most this
//   guard can do for them.
//
// **A green run means the MANIFEST agrees with this repository. It does NOT mean
// the published page is verified** — that is the other half of the seam, and it
// runs in the repository that holds the page.

const ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = ['lib', 'app'];

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

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const INSTALLED = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

const HOSTS = hostsInTree();

/** The evidence that makes a vendor live, or an empty array. */
function evidenceFor(sig: (typeof VENDOR_SIGNATURES)[number]): string[] {
  return [
    ...(sig.packages ?? []).filter((p) => INSTALLED.has(p)).map((p) => `package ${p}`),
    ...(sig.hosts ?? []).filter((h) => HOSTS.has(h)).map((h) => `host ${h}`),
  ];
}

/**
 * The manifest, READ FROM DISK rather than imported.
 *
 * ⚠️ This spec is in the STRUCTURAL-GUARD LANE, which forbids a member importing
 * from `lib/` — the lane exists so whole-tree specs carry no coverage into the
 * merged report, and `tests/ci-structural-guards-lane.test.ts` asserts it. That
 * constraint is why the artifact is a JSON file beside its types: a guard can
 * read one, and may not import the other.
 */
interface ManifestVendor {
  vendor: string;
  basis: 'repository-evidence' | 'not-evidenced-here';
  evidence: string[];
  reason?: string;
}
const EGRESS_MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'lib', 'legal', 'egress-manifest.json'), 'utf8'),
) as { version: number; measuredIn: string; vendors: ManifestVendor[] };

/** The manifest, indexed — this is the SUBJECT now, where the page used to be. */
const MANIFEST = new Map(EGRESS_MANIFEST.vendors.map((v) => [v.vendor, v]));
const EVIDENCED = new Set(
  EGRESS_MANIFEST.vendors.filter((v) => v.basis === 'repository-evidence').map((v) => v.vendor),
);

describe('the egress manifest agrees with the repository (MOTIR-3631 · MOTIR-4008)', () => {
  it('is not vacuous — the tree was walked and the manifest parsed', () => {
    // Without this, every assertion below passes on empty sets, which is how a
    // totality test dies quietly.
    expect(HOSTS.size).toBeGreaterThanOrEqual(20);
    expect(EGRESS_MANIFEST.vendors.length).toBeGreaterThanOrEqual(15);
    expect(EVIDENCED.size).toBeGreaterThanOrEqual(8);
  });

  // ── The two directions the ADR requires, and they are separate tests on
  //    purpose: one is "we send data somewhere we do not disclose", the other is
  //    "we disclose a company we send nothing to". Both are false statements on
  //    a published page and they are corrected in opposite ways.
  it('carries every vendor the repository proves will receive data at launch', () => {
    const missing = VENDOR_SIGNATURES.filter((s) => evidenceFor(s).length > 0)
      .filter((s) => !MANIFEST.has(s.vendor))
      .map((s) => `${s.vendor} (${evidenceFor(s).join(', ')})`);

    expect(
      missing,
      `these vendors have live evidence in this repository but no entry in ` +
        `lib/legal/egressManifest.ts. Add the entry — or, if the vendor is on its way out ` +
        `before general availability, record it in LEAVING_BEFORE_LAUNCH with the card that ` +
        `removes it and delete its VendorSignature.`,
    ).toEqual([]);
  });

  it('carries no `repository-evidence` vendor the repository shows is receiving nothing', () => {
    // A vendor the guard has ALREADY declared it cannot see rides the manifest as
    // `not-evidenced-here` and is exempt from this arm by construction — it is
    // asserted separately below. Stripe is the case that named the rule: its
    // signature is real and its `api.stripe.com` mapping still has to exist for
    // the host-accounting test, but the SDK and every billing route live in
    // motir-ai, so `evidenceFor` is empty here and always will be.
    const overclaimed = [...EVIDENCED]
      .filter((vendor) => {
        const sig = VENDOR_SIGNATURES.find((s) => s.vendor === vendor);
        return !sig || evidenceFor(sig).length === 0;
      })
      .sort();

    expect(
      overclaimed,
      `these vendors are recorded in the manifest as proven by this repository, but nothing ` +
        `in it reaches them. Claiming egress that does not happen is as wrong as omitting ` +
        `egress that does — move them to \`not-evidenced-here\` with a reason, or adjust the ` +
        `signature if the evidence changed shape.`,
    ).toEqual([]);
  });

  it('records the evidence itself, not just the vendor name', () => {
    // The manifest is what the OTHER repository reads. A row saying only "GitHub"
    // tells its reader nothing about why, so a divergence there would be a
    // disagreement nobody can adjudicate without opening this tree.
    const wrong = VENDOR_SIGNATURES.filter((s) => evidenceFor(s).length > 0)
      .filter((s) => {
        const entry = MANIFEST.get(s.vendor);
        return !entry || [...entry.evidence].sort().join('|') !== evidenceFor(s).sort().join('|');
      })
      .map((s) => `${s.vendor}: expected [${evidenceFor(s).sort().join(', ')}]`);

    expect(
      wrong,
      `these manifest entries do not record the evidence this tree actually shows. The ` +
        `manifest is read by another repository, so its evidence strings are the whole of ` +
        `what a reader there has to go on.`,
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

  it('still carries the vendors this guard cannot see, each with its reason', () => {
    // The ones that leave no repository trace. The guard cannot verify they are
    // live; it CAN refuse to let them vanish from the manifest unnoticed, which
    // is what stops them vanishing from the page.
    const dropped = Object.keys(INVISIBLE_TO_THIS_GUARD)
      .filter((v) => MANIFEST.get(v)?.basis !== 'not-evidenced-here')
      .sort();

    expect(
      dropped,
      `these vendors are disclosed for reasons this guard cannot re-derive, and one has ` +
        `disappeared from the manifest or been re-labelled as evidenced. If that is ` +
        `deliberate, remove it from INVISIBLE_TO_THIS_GUARD in the same change and say ` +
        `where it went.`,
    ).toEqual([]);

    // A reason is not decoration: it is the only thing standing between an
    // unverifiable row and an unexplained one.
    const unexplained = EGRESS_MANIFEST.vendors
      .filter((v) => v.basis === 'not-evidenced-here' && !v.reason?.trim())
      .map((v) => v.vendor);
    expect(unexplained).toEqual([]);
  });

  it('keeps a departing vendor OFF the manifest', () => {
    // The inverse of every other assertion here, and the one that lets the
    // manifest describe launch rather than this afternoon.
    const resurrected = Object.keys(LEAVING_BEFORE_LAUNCH)
      .filter((v) => MANIFEST.has(v))
      .sort();

    expect(
      resurrected,
      `these vendors are recorded as leaving before general availability, yet they appear ` +
        `in the manifest. Either the retirement was abandoned — remove the ` +
        `LEAVING_BEFORE_LAUNCH entry and add a VendorSignature — or the entry was added by ` +
        `mistake and states something that will not be true at launch.`,
    ).toEqual([]);
  });

  it("retires a departing vendor's entry once it has actually gone", () => {
    const departed = Object.entries(LEAVING_BEFORE_LAUNCH)
      .filter(([, d]) => d.packages.every((p) => !INSTALLED.has(p)))
      .map(([vendor]) => vendor)
      .sort();

    expect(
      departed,
      `these vendors have finished leaving — none of the dependencies naming them is ` +
        `installed any more. Delete their LEAVING_BEFORE_LAUNCH entries: the vendor is ` +
        `simply not a subprocessor now, and an entry explaining why it is absent outlives ` +
        `the question it answers.`,
    ).toEqual([]);
  });

  it('reads no page — the disclosure half lives in the repository that holds it', () => {
    // ⚠️ THE SPLIT, ASSERTED. A future edit that "helpfully" re-adds a read of
    // `content/legal/` here would re-create the guard that cannot survive the
    // move, and it would pass locally right up until the files leave.
    const source = readFileSync(join(ROOT, 'tests/legal/egress-manifest-guard.test.ts'), 'utf8');
    // ⚠️ Two things this assertion has to get right, and the first draft got
    // neither. The needle is ASSEMBLED rather than written, so the check does
    // not match itself; and it is applied to CODE ONLY, because the header
    // above discusses the pages at length and prose about a path is not a read
    // of it. Comment lines are dropped rather than block-stripped — a line
    // comment containing `/*` swallows the rest of a naive block strip
    // (MOTIR-4043), and this file has no need to be clever about it.
    const needle = ['content', 'legal'].join('/');
    const code = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code.split(needle)).toHaveLength(1);
  });
});
