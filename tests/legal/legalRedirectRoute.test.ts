import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLegalManifest, RECONSENT_FIXTURE, setLegalManifest } from '../helpers/legalManifest';

const { notFound, permanentRedirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({ notFound, permanentRedirect }));

const route = await import('@/app/(public)/legal/[slug]/page');

afterEach(() => {
  clearLegalManifest();
  vi.clearAllMocks();
});

describe('/legal/[slug] redirect route', () => {
  it('does not derive static parameters from runtime-only configuration', () => {
    expect(route).not.toHaveProperty('generateStaticParams');
  });

  it('permanently redirects a configured document to its published URL', async () => {
    setLegalManifest(RECONSENT_FIXTURE);

    await expect(route.default({ params: Promise.resolve({ slug: 'terms' }) })).rejects.toThrow(
      'NEXT_REDIRECT:https://motir.co/legal/terms',
    );
    expect(permanentRedirect).toHaveBeenCalledWith('https://motir.co/legal/terms');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('publishes metadata for configured documents and none for unknown slugs', async () => {
    setLegalManifest(RECONSENT_FIXTURE);

    await expect(
      route.generateMetadata({ params: Promise.resolve({ slug: 'terms' }) }),
    ).resolves.toEqual({
      title: 'Terms of Service',
      alternates: { canonical: 'https://motir.co/legal/terms' },
    });
    await expect(
      route.generateMetadata({ params: Promise.resolve({ slug: 'no-such-doc' }) }),
    ).resolves.toEqual({});
  });

  it('returns not found for an unknown document', async () => {
    setLegalManifest(RECONSENT_FIXTURE);

    await expect(
      route.default({ params: Promise.resolve({ slug: 'no-such-doc' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
