import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRootMetadata } from '@/lib/rootMetadata';
import {
  pathToModule,
  REPO_ROOT,
  resolveLocal,
  specifiersOf,
  stripComments,
} from './helpers/importGraph';

// MOTIR-2505 — `metadataBase` and the two traps around setting it.
//
// The bug this covers had no failing test, no red page and no error: Next
// resolved every relative OpenGraph / Twitter image URL against the dev origin
// and said so in a log line, so both branded share cards (MOTIR-1150) were
// advertised at an address nothing outside the container can fetch. The whole
// symptom was a warning nobody reads, which is how it survived — so the value
// is asserted here rather than left to be noticed again.
//
// The two structural checks are not decoration. Each guards a way of writing
// the correct-looking line and still shipping the bug:
//
//   TRAP 1 — reaching the origin through a module that carries a database
//            client would put one in every route in the product.
//   TRAP 2 — a static `metadata` export is evaluated at module load, which for
//            a statically-rendered route is BUILD time, where MOTIR_BASE_URL is
//            deliberately unset. The localhost fallback would be frozen into
//            the output and the build would look clean.

const ROOT_METADATA_MODULE = 'lib/rootMetadata.ts';
const ROOT_LAYOUT = 'app/layout.tsx';

describe('buildRootMetadata — the resolved metadataBase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves metadataBase from the configured origin', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    expect(buildRootMetadata().metadataBase?.toString()).toBe('https://app.motir.co/');
  });

  it('is NOT hardcoded — it follows MOTIR_BASE_URL wherever it points', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://staging.example.test');
    expect(new URL(String(buildRootMetadata().metadataBase)).origin).toBe(
      'https://staging.example.test',
    );
  });

  it('resolves a relative OG image path to an absolute production URL', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    // What Next does with the file-convention `opengraph-image` entry: join the
    // site-relative path onto metadataBase. This is the assertion the bug fails.
    const resolved = new URL('/explore/opengraph-image', buildRootMetadata().metadataBase!);
    expect(resolved.toString()).toBe('https://app.motir.co/explore/opengraph-image');
    expect(resolved.toString()).not.toContain('localhost');
  });

  it('tolerates a configured trailing slash (no double slash in a resolved path)', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co/');
    const base = buildRootMetadata().metadataBase!;
    expect(base.toString()).toBe('https://app.motir.co/');
    expect(new URL('/explore/opengraph-image', base).toString()).toBe(
      'https://app.motir.co/explore/opengraph-image',
    );
  });

  it('falls back to the ONE documented dev origin when MOTIR_BASE_URL is unset', () => {
    // Not an endorsement of the fallback — the point is that it is
    // `lib/baseUrl.ts`'s single fallback and nothing else. Next's own
    // `http://localhost:8080` guess (the one in the production warning) is what
    // an UNSET metadataBase produces, and it must never be reachable again.
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    expect(buildRootMetadata().metadataBase?.toString()).toBe('http://localhost:3000/');
  });

  it('keeps the title and description the root layout already published', () => {
    const metadata = buildRootMetadata();
    expect(metadata.title).toBe('Motir');
    expect(metadata.description).toBe('AI-native project management — open-source PM substrate.');
  });
});

describe('TRAP 1 — the origin is read through the zero-import leaf', () => {
  it('imports lib/baseUrl.ts and nothing else local', () => {
    const source = readFileSync(join(REPO_ROOT, ROOT_METADATA_MODULE), 'utf8');
    const local = specifiersOf(source)
      .map((specifier) => resolveLocal(specifier, ROOT_METADATA_MODULE))
      .filter((path): path is string => path !== null);

    expect(
      local,
      `${ROOT_METADATA_MODULE} is imported by the ROOT layout, so its closure lands in every ` +
        `route in the product. Read the origin from lib/baseUrl.ts — not from ` +
        `lib/publicProjects/urls.ts, which is a domain module free to grow imports.`,
    ).toEqual(['lib/baseUrl.ts']);
  });

  it('reaches no database client', () => {
    expect(pathToModule(ROOT_METADATA_MODULE)).toBeNull();
  });
});

describe('TRAP 2 — the root layout builds its metadata per request', () => {
  const layout = stripComments(readFileSync(join(REPO_ROOT, ROOT_LAYOUT), 'utf8'));

  it('exports generateMetadata, and builds it from buildRootMetadata', () => {
    expect(layout).toMatch(/export\s+async\s+function\s+generateMetadata\s*\(/);
    expect(layout).toContain('buildRootMetadata()');
  });

  it('does NOT export a static metadata object', () => {
    expect(
      /export\s+const\s+metadata\b/.test(layout),
      `${ROOT_LAYOUT} must not export a static \`metadata\` object. It is evaluated at module ` +
        `load — build time for a statically-rendered route — and the image build runs with no ` +
        `MOTIR_BASE_URL, so the localhost fallback would be baked into the output (MOTIR-2505).`,
    ).toBe(false);
  });
});
