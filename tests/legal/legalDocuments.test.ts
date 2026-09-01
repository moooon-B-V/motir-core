import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGAL_DOCUMENTS_ENV,
  getLegalDocument,
  legalDocumentSlugs,
  legalManifestState,
  listLegalDocuments,
} from '@/lib/legal/documents';
import {
  PUBLISHED_FIXTURE,
  clearLegalManifest,
  manifestJson,
  setLegalManifest,
} from '../helpers/legalManifest';

// THE CONFIGURED MANIFEST (MOTIR-4007), which replaced a `readdirSync` of
// `content/legal/`.
//
// ── ⚠️ WHAT LEFT THIS FILE, AND WHERE IT WENT ──────────────────────────────
// The `parseLegalDocument` and `byPreferredOrder` suites are GONE from here
// because their SUBJECT moved, not because they stopped mattering. MOTIR-4009
// ported the front-matter parser to `motir-marketing` with the documents it
// reads, and its tests travelled with it — `motir-marketing`
// `tests/legal/legalDocuments.test.ts` carries all ten parser cases and all
// three ordering cases, verbatim. Re-asserting them here would test a parser
// this repository no longer has.
//
// `PREFERRED_ORDER` did not move; it was RETIRED
// (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §C). The manifest is an
// authored array, so its order is the operator's, and a hardcoded list re-sorting
// it would impose one company's document ordering on every self-hoster.
//
// ── What this file asserts instead ─────────────────────────────────────────
// Three things, and the middle one is why the module was worth rewriting rather
// than deleting: the UNCONFIGURED arm behaves (it is the self-hoster's state and
// the common case for the open product), a MALFORMED entry never reaches a
// consumer, and the refusal is LOUD.

describe('an UNCONFIGURED deployment', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = clearLegalManifest();
  });
  afterEach(() => restore());

  // ⚠️ EACH OF THESE IS A SEPARATE BEHAVIOUR, asserted separately and on purpose.
  // Every one is a deliberate empty-set arm somewhere downstream, and the whole
  // failure mode MOTIR-3909 guards against is those arms being silently correct
  // together. "Nothing threw" is not what is being claimed.
  it('lists no documents', () => {
    expect(listLegalDocuments()).toEqual([]);
  });

  it('has no slugs, so nothing generates a route', () => {
    expect(legalDocumentSlugs()).toEqual([]);
  });

  it('resolves NO slug, including one that would be valid when configured', () => {
    expect(getLegalDocument('terms')).toBeNull();
  });

  it('reports `unconfigured` — which is NOT `faulted`', () => {
    const state = legalManifestState();
    expect(state.status).toBe('unconfigured');
    expect(state.faults).toEqual([]);
  });

  it('treats an EMPTY value as unset rather than as malformed JSON', () => {
    process.env[LEGAL_DOCUMENTS_ENV] = '   ';
    expect(legalManifestState().status).toBe('unconfigured');
  });
});

describe('a CONFIGURED manifest', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setLegalManifest();
  });
  afterEach(() => restore());

  it('lists every entry', () => {
    expect(listLegalDocuments()).toHaveLength(PUBLISHED_FIXTURE.length);
    expect(legalManifestState().status).toBe('configured');
  });

  it('keeps the MANIFEST’S OWN ORDER rather than a curated one', () => {
    // The retired `PREFERRED_ORDER` began `terms, privacy, cookies, …`. This
    // manifest is deliberately shuffled away from it, so an accidental
    // re-introduction of a sort would show up as a reordering rather than as a
    // no-op against a fixture that happened to match.
    const shuffled = [...PUBLISHED_FIXTURE].reverse();
    const take = setLegalManifest(shuffled);
    try {
      expect(legalDocumentSlugs()).toEqual(shuffled.map((doc) => doc.slug));
    } finally {
      take();
    }
  });

  it('resolves a configured slug, with its url', () => {
    const doc = getLegalDocument('terms');
    expect(doc?.title).toBe('Terms of Service');
    expect(doc?.url).toBe('https://motir.co/legal/terms');
  });

  it('refuses a slug that names no entry', () => {
    expect(getLegalDocument('not-a-document')).toBeNull();
  });

  // ⚠️ THE TRAVERSAL CASES SURVIVE THE SWAP, and they now hold by construction:
  // there is no path to build. They are kept because the property is what
  // matters, not the mechanism that used to provide it — a later refactor that
  // reintroduced a path would be caught here.
  it.each(['../../package', '../../../etc/passwd', '../terms'])(
    'refuses the traversal-shaped slug %s',
    (slug) => {
      expect(getLegalDocument(slug)).toBeNull();
    },
  );

  it('maps an absent effectiveDate and changeSummary to null', () => {
    const doc = getLegalDocument('privacy');
    expect(doc?.effectiveDate).toBeNull();
    expect(doc?.changeSummary).toBeNull();
  });

  it('carries an effectiveDate and a changeSummary when the entry has them', () => {
    const take = setLegalManifest([
      {
        slug: 'terms',
        title: 'Terms of Service',
        version: '2.0.0',
        effectiveDate: '2026-10-12',
        changeSummary: 'Adds the hosted-agent execution service.',
        url: 'https://motir.co/legal/terms',
      },
    ]);
    try {
      const doc = getLegalDocument('terms');
      expect(doc?.effectiveDate).toBe('2026-10-12');
      expect(doc?.changeSummary).toBe('Adds the hosted-agent execution service.');
    } finally {
      take();
    }
  });
});

describe('a MALFORMED entry never reaches a consumer, and says so LOUDLY', () => {
  let restore: () => void;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
  });
  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  // ⚠️ THIS IS THE LOAD-BEARING CASE, and the alternative that was REJECTED is
  // named here so the assertion cannot be softened by accident.
  // `consent.ts`'s `parseSemanticVersion` returns null for an unreadable version
  // and `isMaterialChange` then answers TRUE — right for a version in a file we
  // control, and catastrophic for operator input: one typo would hold EVERY
  // signed-in reader at `/re-consent`, on a screen they cannot clear. So the
  // entry is refused before a consumer sees it (AMENDMENT 2 §C).
  //
  // The other rejected alternative was refusing SILENTLY and reporting the
  // manifest as unset — which is precisely the failure MOTIR-3909 exists to
  // prevent, reached from the other side. Hence `faulted`, and the log.
  it('refuses an entry whose version is not <major>.<minor>.<patch>', () => {
    restore = setLegalManifest([
      { ...PUBLISHED_FIXTURE[0]!, version: '1.0' },
      PUBLISHED_FIXTURE[1]!,
    ]);
    expect(legalDocumentSlugs()).toEqual(['privacy']);
    expect(getLegalDocument('terms')).toBeNull();
  });

  it('reports `faulted` — never `unconfigured` — and names the entry and the field', () => {
    restore = setLegalManifest([{ ...PUBLISHED_FIXTURE[0]!, version: 'v1' }]);
    const state = legalManifestState();
    expect(state.status).toBe('faulted');
    expect(state.faults).toEqual([
      { entry: 'terms', field: 'version', reason: '"v1" is not <major>.<minor>.<patch>' },
    ]);
    expect(errors.some((line) => line.includes('terms') && line.includes('version'))).toBe(true);
  });

  it('refuses ONE bad entry without disabling the others — the refusal is per entry', () => {
    restore = setLegalManifest([
      PUBLISHED_FIXTURE[0]!,
      { ...PUBLISHED_FIXTURE[1]!, version: 'nonsense' },
      PUBLISHED_FIXTURE[2]!,
    ]);
    // The two re-consent documents that ARE well-formed keep gating.
    expect(legalDocumentSlugs()).toEqual(['terms', 'acceptable-use']);
    expect(legalManifestState().status).toBe('faulted');
  });

  it.each([
    ['slug', { title: 'T', version: '1.0.0', url: 'https://motir.co/legal/t' }],
    ['title', { slug: 't', version: '1.0.0', url: 'https://motir.co/legal/t' }],
    ['url', { slug: 't', title: 'T', version: '1.0.0' }],
    ['version', { slug: 't', title: 'T', url: 'https://motir.co/legal/t' }],
  ])('refuses an entry missing %s', (field, entry) => {
    restore = setLegalManifest([entry]);
    expect(listLegalDocuments()).toEqual([]);
    expect(legalManifestState().faults.map((f) => f.field)).toContain(field);
  });

  it('refuses a DUPLICATE slug rather than silently shadowing one', () => {
    restore = setLegalManifest([
      PUBLISHED_FIXTURE[0]!,
      { ...PUBLISHED_FIXTURE[0]!, version: '2.0.0' },
    ]);
    expect(listLegalDocuments()).toHaveLength(1);
    expect(getLegalDocument('terms')?.version).toBe('1.0.0');
    expect(legalManifestState().faults).toEqual([
      { entry: 'terms', field: 'slug', reason: 'duplicate' },
    ]);
  });

  it('refuses an element that is not an object', () => {
    restore = setLegalManifest(['terms', 42, null]);
    expect(listLegalDocuments()).toEqual([]);
    expect(legalManifestState().faults).toHaveLength(3);
  });

  it('refuses a value that is not JSON at all, and logs it', () => {
    const previous = process.env[LEGAL_DOCUMENTS_ENV];
    process.env[LEGAL_DOCUMENTS_ENV] = '{not json';
    restore = () => {
      if (previous === undefined) delete process.env[LEGAL_DOCUMENTS_ENV];
      else process.env[LEGAL_DOCUMENTS_ENV] = previous;
    };
    const state = legalManifestState();
    expect(state.status).toBe('faulted');
    expect(state.documents).toEqual([]);
    expect(errors.some((line) => line.includes('not valid JSON'))).toBe(true);
  });

  it('refuses valid JSON that is not an array', () => {
    const previous = process.env[LEGAL_DOCUMENTS_ENV];
    process.env[LEGAL_DOCUMENTS_ENV] = manifestJson([]).replace('[]', '{"terms":{}}');
    restore = () => {
      if (previous === undefined) delete process.env[LEGAL_DOCUMENTS_ENV];
      else process.env[LEGAL_DOCUMENTS_ENV] = previous;
    };
    expect(legalManifestState().status).toBe('faulted');
    expect(errors.some((line) => line.includes('must be a JSON array'))).toBe(true);
  });
});

describe('the module reads the environment at the moment of the call', () => {
  // ⚠️ NO MODULE-LEVEL CACHE, DELIBERATELY — `legalAcceptanceService`'s own
  // comment argues it: a cache serves the PREVIOUS version of the Terms for the
  // life of a server process after a deploy, on a screen whose entire job is to
  // be current about what a person is agreeing to. This is what asserts it.
  it('sees a manifest that changed after the first read', () => {
    const clear = clearLegalManifest();
    try {
      expect(listLegalDocuments()).toEqual([]);
      const take = setLegalManifest([PUBLISHED_FIXTURE[0]!]);
      try {
        expect(legalDocumentSlugs()).toEqual(['terms']);
      } finally {
        take();
      }
      expect(listLegalDocuments()).toEqual([]);
    } finally {
      clear();
    }
  });
});
