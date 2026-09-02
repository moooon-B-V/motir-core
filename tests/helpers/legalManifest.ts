import { LEGAL_DOCUMENTS_ENV, type LegalDocument } from '@/lib/legal/documents';

// A CONFIGURED legal manifest, for the suites that used to read `content/legal/`
// (MOTIR-4007).
//
// ⚠️ WHY EVERY LEGAL SUITE NEEDS THIS NOW. `lib/legal/documents.ts` reads its
// documents from `MOTIR_LEGAL_DOCUMENTS` instead of from the filesystem, so a
// suite that simply calls `listLegalDocuments()` gets `[]` — correctly, because
// a test process is an UNCONFIGURED deployment. That is the self-hoster's state
// and it is a thing to assert deliberately, never a thing to inherit by
// accident: an `it.each` over an empty list passes having asserted nothing.
//
// So a suite about the CONFIGURED behaviour configures the manifest, and a suite
// about the UNCONFIGURED behaviour clears it. Both are explicit here.

/** The three documents re-consent is asked for — the set `consent.ts` gates on. */
export const RECONSENT_FIXTURE: LegalDocument[] = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/terms',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/privacy',
  },
  {
    slug: 'acceptable-use',
    title: 'Acceptable Use Policy',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/acceptable-use',
  },
];

/**
 * The seven documents the hosted deployment publishes, in the manifest's own
 * order — the same set `content/legal/` held, so a suite that used to read the
 * directory measures the same population.
 *
 * ⚠️ It is a FIXTURE, not a copy of the published manifest. The real versions
 * live on the deployment (MOTIR-4012) and on the brand host; asserting against
 * them from here would be asserting about somebody else's configuration.
 */
export const PUBLISHED_FIXTURE: LegalDocument[] = [
  ...RECONSENT_FIXTURE,
  {
    slug: 'cookies',
    title: 'Cookie Policy',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/cookies',
  },
  {
    slug: 'dpa',
    title: 'Data Processing Agreement',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/dpa',
  },
  {
    slug: 'subprocessors',
    title: 'Subprocessors',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/subprocessors',
  },
  {
    slug: 'model-providers',
    title: 'Model providers',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://motir.co/legal/model-providers',
  },
];

/** Serialize a manifest exactly as an operator would set it. */
export function manifestJson(documents: readonly unknown[]): string {
  return JSON.stringify(documents);
}

/**
 * Configure the manifest for the duration of a suite, restoring whatever was
 * there before. Pass nothing to configure {@link PUBLISHED_FIXTURE}.
 *
 * Returns the restore function, so a suite that needs a different manifest
 * mid-file can take it back.
 */
export function setLegalManifest(documents: readonly unknown[] = PUBLISHED_FIXTURE): () => void {
  const previous = process.env[LEGAL_DOCUMENTS_ENV];
  process.env[LEGAL_DOCUMENTS_ENV] = manifestJson(documents);
  return () => {
    if (previous === undefined) delete process.env[LEGAL_DOCUMENTS_ENV];
    else process.env[LEGAL_DOCUMENTS_ENV] = previous;
  };
}

/** Clear the manifest — the UNCONFIGURED deployment. Returns the restore function. */
export function clearLegalManifest(): () => void {
  const previous = process.env[LEGAL_DOCUMENTS_ENV];
  delete process.env[LEGAL_DOCUMENTS_ENV];
  return () => {
    if (previous !== undefined) process.env[LEGAL_DOCUMENTS_ENV] = previous;
  };
}
