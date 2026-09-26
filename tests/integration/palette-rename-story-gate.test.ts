import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { isPaletteId } from '@/lib/theme/palettes';
import { buildThemeInitScript } from '@/lib/theme/init-script';
import { createTestUser } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// STORY INTEGRATION GATE (motir-core) — MOTIR-6475, over story MOTIR-6470.
//
// MOTIR-6471 (the palette rename + stored-preference migrations) and MOTIR-6474
// (the brand colours) each shipped unit tests. This file measures what they are
// TOGETHER: the swap's danger is at the joins, where one side is migrated and the
// other is not. The browser-side seams (init script → ThemeProvider, the
// onboarding restore) need a DOM and live in
// `tests/components/palette-rename-story-gate.test.tsx`.

const REPO = process.cwd();
const MIGRATION_SQL = readFileSync(
  join(REPO, 'prisma/migrations/20260926100000_rename_palette_ids_motir_amethyst/migration.sql'),
  'utf8',
);

/** Run the real init script against a fake window/document; return the palette it stamps. */
function stampedPalette(script: string): string | undefined {
  const attributes = new Map<string, string>();
  const store = new Map<string, string>();
  new Function('window', 'document', script)(
    {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      matchMedia: () => ({ matches: false }),
    },
    { documentElement: { setAttribute: (k: string, v: string) => void attributes.set(k, v) } },
  );
  return attributes.get('data-palette');
}

async function seedPreference(paletteId: string | null): Promise<string> {
  const user = await createTestUser();
  await adminDb.$executeRawUnsafe(
    `INSERT INTO "user_appearance_preference" ("user_id", "palette_id", "created_at", "updated_at")
     VALUES ($1, $2, now(), now())`,
    user.id,
    paletteId,
  );
  return user.id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('seam — a stored server value, migrated, is what the first paint stamps', () => {
  it.each([
    ['graphite', 'motir'],
    ['motir', 'amethyst'],
    [null, 'motir'],
  ] as const)('palette_id %s → data-palette="%s"', async (stored, expected) => {
    const userId = await seedPreference(stored);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);

    // An all-NULL row reads as "no preference" (`getApplied` → null), so that
    // case takes the anonymous branch — and must still land on the default.
    const applied = await appearancePreferenceService.getApplied(userId);
    expect(stampedPalette(buildThemeInitScript(applied))).toBe(expected);
  });
});

describe('guard — no graphite survives', () => {
  it('graphite is not a palette id', () => {
    expect(isPaletteId('graphite')).toBe(false);
  });

  it("no source file under app/ components/ lib/ packages/ references data-palette='graphite'", () => {
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          `data-palette=['"]graphite['"]`,
          '--',
          'app',
          'components',
          'lib',
          'packages',
        ],
        { cwd: REPO, encoding: 'utf8' },
      );
    } catch {
      hits = ''; // git grep exits 1 when nothing matches
    }
    expect(hits.trim()).toBe('');
  });
});

describe('guard — brand literal totality (MOTIR-6474)', () => {
  const BRAND_SOURCE = readFileSync(join(REPO, 'packages/brand/src/waveBand.ts'), 'utf8');
  const colourExports = [
    ...BRAND_SOURCE.matchAll(/export const (BRAND_\w+_HEX) = '(#[0-9a-f]{6})'/g),
  ].map(([, name, hex]) => ({ name: name!, hex: hex! }));
  const CONSUMERS = [
    'scripts/brand/generate-brand-icons.mts',
    'lib/emailTemplates/_components/emailColors.ts',
    'app/manifest.ts',
  ].map((path) => readFileSync(join(REPO, path), 'utf8'));

  it('declares the seven colour exports the approved table names', () => {
    expect(colourExports.map((e) => e.name).sort()).toEqual([
      'BRAND_ACCENT_DARK_HEX',
      'BRAND_ACCENT_HEX',
      'BRAND_ACCENT_INK_DARK_HEX',
      'BRAND_ACCENT_INK_HEX',
      'BRAND_GLYPH_HEX',
      'BRAND_LINK_HEX',
      'BRAND_PAGE_BG_HEX',
    ]);
  });

  it('every colour export is consumed by the generator, an email or the manifest — no orphan', () => {
    const orphans = colourExports
      .filter(({ name }) => !CONSUMERS.some((source) => new RegExp(`\\b${name}\\b`).test(source)))
      .map((e) => e.name);
    expect(orphans).toEqual([]);
  });

  it('no consumer re-declares a brand hex as a literal in CODE', () => {
    // Comments may cite a value (provenance is the point of them), and
    // `app/icon.svg` is the generator's committed OUTPUT — asserted byte-for-byte
    // against the generator in `tests/brand/iconAssets.test.ts` — so neither is a
    // re-declaration. Everything else must read the colour from `@motir/brand`.
    const brandHexes = [...new Set(colourExports.map((e) => e.hex))].filter((h) => h !== '#ffffff');
    const pattern = new RegExp(brandHexes.join('|'), 'i');
    let files: string[] = [];
    try {
      files = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-i',
          '-E',
          brandHexes.join('|'),
          '--',
          'app',
          'lib',
          'components',
          'scripts',
        ],
        { cwd: REPO, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      files = []; // git grep exits 1 when nothing matches
    }
    const offenders = files
      .filter((file) => file !== 'app/icon.svg')
      .filter((file) => {
        const code = readFileSync(join(REPO, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        return pattern.test(code);
      });
    expect(offenders).toEqual([]);
  });
});
