import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/health/legal/route';
import { RECONSENT_DOCUMENT_SLUGS } from '@/lib/legal/consent';
import { PUBLISHED_FIXTURE, clearLegalManifest, setLegalManifest } from '../helpers/legalManifest';

// `/api/health/legal` (MOTIR-4007) — the half of AMENDMENT 2 §C's "the refusal is
// LOUD" that lives outside the process's own logs.
//
// The point of every assertion below is a DISTINCTION: unconfigured is not
// faulted, and a fault on a re-consent document is not the same event as a fault
// on one of the other four. A route that collapsed either pair would report
// health it had not measured.

describe('GET /api/health/legal', () => {
  let restore: () => void;

  beforeEach(() => {
    // The route logs through the module; silence it so a deliberate fault does
    // not print a wall of red in a passing suite.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  it('reports `unconfigured` at 200 — an unconfigured self-host is HEALTHY', async () => {
    restore = clearLegalManifest();
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'unconfigured',
      documentCount: 0,
      faults: [],
      reconsentDocumentsAffected: [],
    });
  });

  it('reports `configured` at 200, with the count', async () => {
    restore = setLegalManifest();
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'configured',
      documentCount: PUBLISHED_FIXTURE.length,
      faults: [],
    });
  });

  it('reports `faulted` at 503 — never 200, and never `unconfigured`', async () => {
    restore = setLegalManifest([{ ...PUBLISHED_FIXTURE[0]!, version: 'v1' }]);
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('faulted');
    expect(body.faults).toEqual([
      { entry: 'terms', field: 'version', reason: '"v1" is not <major>.<minor>.<patch>' },
    ]);
  });

  it('NAMES a re-consent document whose entry was refused', async () => {
    restore = setLegalManifest([
      { ...PUBLISHED_FIXTURE[0]!, version: 'v1' },
      PUBLISHED_FIXTURE[1]!,
    ]);
    const body = await (await GET()).json();
    expect(body.reconsentDocumentsAffected).toEqual(['terms']);
  });

  it('does NOT name a refused entry that gates nobody', async () => {
    // `cookies` is one of the four documents `consent.ts` deliberately excludes,
    // each on a ground published in a document we are bound by. A broken entry
    // for it costs a link; it does not stop the gate asking about anything.
    const cookies = PUBLISHED_FIXTURE.find((doc) => doc.slug === 'cookies')!;
    restore = setLegalManifest([PUBLISHED_FIXTURE[0]!, { ...cookies, version: 'nope' }]);
    const body = await (await GET()).json();
    expect(body.status).toBe('faulted');
    expect(body.reconsentDocumentsAffected).toEqual([]);
  });

  // ⚠️ The route spells its re-consent slug list locally so a health transport
  // does not pull the consent module into its request path. This is what stops
  // the two drifting — it is the reason that duplication is safe.
  it('its local re-consent list is exactly `RECONSENT_DOCUMENT_SLUGS`', async () => {
    const affected: string[] = [];
    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const take = setLegalManifest([
        { slug, title: slug, version: 'bad', url: `https://motir.co/legal/${slug}` },
      ]);
      const body = await (await GET()).json();
      affected.push(...body.reconsentDocumentsAffected);
      take();
    }
    expect(affected).toEqual([...RECONSENT_DOCUMENT_SLUGS]);
  });

  it('discloses no document CONTENT — only slugs, fields and reasons', async () => {
    restore = setLegalManifest([{ ...PUBLISHED_FIXTURE[0]!, version: 'v1' }]);
    const raw = await (await GET()).text();
    expect(raw).not.toContain('https://motir.co');
    expect(raw).not.toContain('Terms of Service');
  });
});
