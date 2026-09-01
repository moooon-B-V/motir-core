import 'server-only';

// The legal-document loader (Story 8.4 · MOTIR-1134; re-sourced by MOTIR-4007).
//
// ── ⚠️ WHAT CHANGED, AND WHY IT IS A SOURCE SWAP RATHER THAN A REDESIGN ─────
// This module used to `readdirSync` `content/legal/`. Those documents are
// moooon B.V.'s own contract text and have left this GPL-3.0 repository
// (MOTIR-3909); what stays is the MECHANISM. So the exported surface is
// unchanged in name and call shape and the SOURCE is now configuration:
// `MOTIR_LEGAL_DOCUMENTS`, a JSON array the operator supplies.
//
// `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §C is the record. Read it
// before changing anything here — every choice below is decided there, with its
// rejected alternatives.
//
// **`body` is GONE and `url` replaces it.** That is what makes this a swap: no
// surviving caller read `body`. The two pages that did are leaving with the
// documents, and every other consumer — `legalAcceptanceService`, the re-consent
// interstitial, `consent.ts` — takes `slug` / `title` / `version` and now `url`.
//
// ── ⚠️ THE ORDER IS THE OPERATOR'S, so `PREFERRED_ORDER` is GONE ────────────
// The old constant existed because a DIRECTORY LISTING has no order. An authored
// array does. A hardcoded list in the open product re-sorting an operator's
// manifest would impose moooon's document ordering on every self-hoster, which is
// a smaller instance of exactly what MOTIR-3909 is undoing. `byPreferredOrder`
// goes with it (§C); nothing outside this module imported it.
//
// ── ⚠️ NO MODULE-LEVEL CACHE, DELIBERATELY ─────────────────────────────────
// `legalAcceptanceService`'s own comment argues this and the argument only got
// stronger: a cache serves the PREVIOUS version of the Terms for the life of a
// server process after a deploy, and parsing one string is cheaper than the
// `readdirSync` + seven `readFileSync`s it replaces. On a screen whose entire job
// is to be current about what a person is agreeing to, stale is the failure that
// matters.

/**
 * The environment value the manifest is read from — ONE variable holding a JSON
 * array (§C). One, because the consumer is `fly secrets set` or a single line in
 * a self-hoster's env; a per-document variable set would make "which documents
 * exist" unanswerable without enumerating variable names.
 */
export const LEGAL_DOCUMENTS_ENV = 'MOTIR_LEGAL_DOCUMENTS';

/** A published legal document, as the manifest describes it. */
export interface LegalDocument {
  /** Stable identifier — what an acceptance row is keyed on, and what `consent.ts` matches. */
  slug: string;
  /** Human title, rendered on the re-consent row. */
  title: string;
  /**
   * Version string, verbatim — `1.0.0`.
   *
   * ⚠️ ITS COMPONENTS CARRY MEANING, and `lib/legal/consent.ts` is where that
   * meaning lives: a MAJOR or MINOR bump is a MATERIAL change and prompts every
   * reader to re-accept, a PATCH bump takes effect when published and prompts
   * nobody. That is not a convention this module invented — the published Terms
   * §14 promise outright that clarifications *"take effect when published"*.
   *
   * It is also the ONE field whose malformation is dangerous rather than merely
   * wrong — see {@link isValidEntry}.
   */
  version: string;
  /** The effective date, or `null` when it is not yet set. `null` is meaningful. */
  effectiveDate: string | null;
  /** One human sentence saying what MOVED in this version, or `null`. */
  changeSummary: string | null;
  /**
   * The ABSOLUTE url of the published document, on whatever host the operator
   * publishes. Absolute because it is no longer a page this application serves.
   */
  url: string;
}

/** Why one manifest entry was refused. */
export interface LegalManifestFault {
  /** The entry's `slug` when it had a usable one, else its index in the array. */
  entry: string;
  /** The field that failed, or `'entry'` when the whole element is unusable. */
  field: string;
  reason: string;
}

/** What this deployment's legal configuration currently IS. */
export type LegalManifestStatus = 'unconfigured' | 'configured' | 'faulted';

export interface LegalManifestState {
  status: LegalManifestStatus;
  documents: LegalDocument[];
  faults: LegalManifestFault[];
}

/** `true` when every required string is present and non-empty. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A nullable scalar: absent, empty and `null` all mean "not set". */
function optionalString(value: unknown): string | null {
  return nonEmptyString(value) ? value.trim() : null;
}

/**
 * Validate ONE entry, returning it or the faults that refuse it.
 *
 * ⚠️ THE `version` CHECK IS THE LOAD-BEARING ONE, and the reason is not
 * tidiness. `consent.ts`'s `parseSemanticVersion` returns `null` for a version it
 * cannot read, and `isMaterialChange` then answers **true** — deliberately, and
 * rightly, for a version in a file we control, because a version whose
 * materiality nobody can rule out should ask rather than stay silent. Applied to
 * OPERATOR INPUT that arm turns one typo into a hold on every signed-in reader,
 * on a screen they cannot clear. So a malformed entry never reaches a consumer
 * (§C), and the refusal is per ENTRY rather than per manifest: one bad optional
 * document must not disable the gate for the three that govern it.
 */
function validateEntry(value: unknown, index: number): LegalDocument | LegalManifestFault[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ entry: String(index), field: 'entry', reason: 'not a JSON object' }];
  }
  const raw = value as Record<string, unknown>;
  const slug = nonEmptyString(raw['slug']) ? raw['slug'].trim() : null;
  const name = slug ?? String(index);
  const faults: LegalManifestFault[] = [];

  if (!slug) faults.push({ entry: name, field: 'slug', reason: 'missing or empty' });
  if (!nonEmptyString(raw['title']))
    faults.push({ entry: name, field: 'title', reason: 'missing or empty' });
  if (!nonEmptyString(raw['url']))
    faults.push({ entry: name, field: 'url', reason: 'missing or empty' });
  if (!nonEmptyString(raw['version'])) {
    faults.push({ entry: name, field: 'version', reason: 'missing or empty' });
  } else if (!/^\d+\.\d+\.\d+$/.test(raw['version'].trim())) {
    // The same grammar `consent.ts` parses. Rejecting it HERE is what stops
    // `isMaterialChange`'s unparseable-is-material arm from meeting it.
    faults.push({
      entry: name,
      field: 'version',
      reason: `"${raw['version'].trim()}" is not <major>.<minor>.<patch>`,
    });
  }

  if (faults.length > 0) return faults;
  return {
    slug: slug as string,
    title: (raw['title'] as string).trim(),
    version: (raw['version'] as string).trim(),
    effectiveDate: optionalString(raw['effectiveDate']),
    changeSummary: optionalString(raw['changeSummary']),
    url: (raw['url'] as string).trim(),
  };
}

/**
 * The whole manifest, with every refusal it produced — read at the moment of the
 * call, never cached (see the module header).
 *
 * ⚠️ THE REFUSAL IS LOUD, and that is the half that separates this from the
 * failure MOTIR-3909 exists to prevent (§C). Rejecting a bad entry SILENTLY and
 * treating the manifest as unset is a legal gate that stops holding people with
 * nothing to see. So every fault is logged at error level naming the entry and
 * the field, and {@link legalManifestState} reports `faulted` — which
 * `/api/health/legal` serves, so *unconfigured* and *misconfigured* can never
 * render as the same state.
 */
export function legalManifestState(): LegalManifestState {
  const configured = process.env[LEGAL_DOCUMENTS_ENV];
  if (!nonEmptyString(configured)) {
    return { status: 'unconfigured', documents: [], faults: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unparseable';
    console.error(`[legal] ${LEGAL_DOCUMENTS_ENV} is not valid JSON: ${reason}`);
    return {
      status: 'faulted',
      documents: [],
      faults: [{ entry: LEGAL_DOCUMENTS_ENV, field: 'json', reason }],
    };
  }

  if (!Array.isArray(parsed)) {
    console.error(`[legal] ${LEGAL_DOCUMENTS_ENV} must be a JSON array of documents`);
    return {
      status: 'faulted',
      documents: [],
      faults: [{ entry: LEGAL_DOCUMENTS_ENV, field: 'json', reason: 'not an array' }],
    };
  }

  const documents: LegalDocument[] = [];
  const faults: LegalManifestFault[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const result = validateEntry(entry, index);
    if (Array.isArray(result)) {
      faults.push(...result);
      return;
    }
    // A duplicate slug is refused rather than silently shadowed: two entries for
    // one document means the operator disagrees with themselves about its
    // version, and `outstandingReconsent` would take whichever came first.
    if (seen.has(result.slug)) {
      faults.push({ entry: result.slug, field: 'slug', reason: 'duplicate' });
      return;
    }
    seen.add(result.slug);
    documents.push(result);
  });

  for (const fault of faults) {
    console.error(`[legal] manifest entry "${fault.entry}": ${fault.field} — ${fault.reason}`);
  }

  return { status: faults.length > 0 ? 'faulted' : 'configured', documents, faults };
}

/**
 * Every configured legal document, IN THE MANIFEST'S OWN ORDER.
 *
 * Unset ⇒ `[]`, which is the right answer for a self-hosted build and is a state
 * every downstream consumer already handles deliberately (`recordAcceptance`'s
 * *"NO EMPTY-SET GUARD HERE, DELIBERATELY"*, `outstandingReconsent`'s `[]`, the
 * interstitial's `terms ? … : null`). Do NOT add a second guard at another tier.
 */
export function listLegalDocuments(): LegalDocument[] {
  return legalManifestState().documents;
}

/** Every configured slug. */
export function legalDocumentSlugs(): string[] {
  return listLegalDocuments().map((doc) => doc.slug);
}

/**
 * One document, or `null` when the slug names no entry.
 *
 * ⚠️ The slug is matched against the configured ENTRIES rather than used to build
 * anything, so a traversal-shaped slug (`../../../etc/passwd`) finds no match and
 * returns null. That was a real property of the filesystem loader and it survives
 * the swap by construction: there is no path to build any more.
 */
export function getLegalDocument(slug: string): LegalDocument | null {
  return listLegalDocuments().find((doc) => doc.slug === slug) ?? null;
}
