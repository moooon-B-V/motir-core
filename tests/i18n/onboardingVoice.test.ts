import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locales, defaultLocale } from '@/lib/i18n/locales';
import { compareMessageShape } from '@/scripts/i18n/messageShape';

// MOTIR-8256 (Story MOTIR-8238's integration gate), cases 1–2 — the onboarding
// voice stays true in EVERY app language after the story merges.
//
// The three namespaces the voice cards re-voiced (`onboarding`,
// `onboardingMigrate`, `import`) are walked in every catalogue the locale list
// names. The list is READ from `lib/i18n/locales`, never typed here, so a
// twelfth language is covered (and must bring its own pattern family below)
// the day it is added.
//
// Why this is a test and not a render: `withEnglishFallback` paints a missing
// key in English with no error, so a German key that never got translated is
// invisible to every component test. A pure read of the JSON is the cheapest
// tier at which it can be caught at all.

const NAMESPACES = ['onboarding', 'onboardingMigrate', 'import'] as const;

type Leaves = Map<string, string>;

function flatten(node: unknown, prefix: string, out: Leaves): Leaves {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flatten(v, `${prefix}.${k}`, out);
  } else if (typeof node === 'string') {
    out.set(prefix, node);
  }
  return out;
}

function leavesOf(messages: Record<string, unknown>): Leaves {
  const out: Leaves = new Map();
  for (const ns of NAMESPACES) flatten(messages[ns], ns, out);
  return out;
}

function readCatalogue(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));
}

const CATALOGUES = new Map(locales.map((l) => [l, leavesOf(readCatalogue(l))] as const));
const EN = CATALOGUES.get(defaultLocale)!;
const OTHERS = locales.filter((l) => l !== defaultLocale);

// ── Case 1: the AI-first pitch, per language ─────────────────────────────────
//
// Each family is built from the PRE-STORY values the voice cards replaced, read
// at the English card's base (`git show 35e82f9f0~1:messages/<locale>.json`).
// `preStory` quotes one of them verbatim: the self-check below fails a pattern
// that does not match the phrase it exists to keep out. "Motir AI" is the
// assistant's NAME and stays legal — `name` is a phrase carrying it that must NOT
// trip the family, so the guard cannot be "fixed" into rejecting the name.

interface VoiceFamily {
  pattern: RegExp;
  preStory: string;
  name: string;
}

const AI_FIRST: Record<string, VoiceFamily> = {
  en: {
    pattern: /plan with ai|build with ai|ai[- ]?planning|ai[- ]first/i,
    preStory: 'Plan with AI',
    name: 'Motir AI plans the project with you',
  },
  zh: {
    pattern: /用 ?AI ?(规划|构建)|AI ?规划|AI ?优先|与 ?AI ?一起/,
    preStory: '用 AI 规划',
    name: 'Motir AI 和你一起把项目想清楚',
  },
  ja: {
    pattern: /AI ?で ?(計画|構築)|AI ?(に ?よる ?)?計画|AI ?ファースト/,
    preStory: 'AI による計画が設定されていません',
    name: 'Motir AI がプロジェクトを一緒に考えます',
  },
  ko: {
    pattern: /AI ?로 ?(계획|빌드)|AI ?계획|AI ?우선/,
    preStory: 'AI로 계획',
    name: 'Motir AI가 함께 프로젝트를 정리합니다',
  },
  de: {
    pattern: /mit (AI|KI) (planen|bauen)|(AI|KI)-?Planung/i,
    preStory: 'Mit AI planen',
    name: 'Motir AI plant das Projekt mit Ihnen',
  },
  fr: {
    pattern: /(planifier|créer) avec l['’]IA|planification (par|avec) (l['’])?IA/i,
    preStory: "La planification par IA n'est pas configurée",
    name: 'Motir AI planifie le projet avec vous',
  },
  es: {
    pattern: /(planificar|construir) con IA|planificación con IA/i,
    preStory: 'Planificar con IA',
    name: 'Motir AI planifica el proyecto contigo',
  },
  it: {
    pattern: /(pianifica|crea) con l['’]AI|pianificazione con l['’]AI/i,
    preStory: 'Pianifica con l’AI',
    name: 'Motir AI pianifica il progetto con te',
  },
  nl: {
    pattern: /(plannen|bouwen) met AI|AI-?planning/i,
    preStory: 'Plannen met AI',
    name: 'Motir AI plant het project met je',
  },
  pl: {
    pattern: /(planuj|buduj) z AI|planowanie z AI/i,
    preStory: 'Planuj z AI',
    name: 'Motir AI planuje projekt razem z Tobą',
  },
  pt: {
    pattern: /(planejar|construa|construir) com IA|planejamento com IA/i,
    preStory: 'Planejar com IA',
    name: 'Motir AI planeja o projeto com você',
  },
};

// ── Case 2: the English-identical allow-list ─────────────────────────────────
//
// A non-en leaf equal to its en leaf is "left English-only" unless it is one of:
//
// 1. NAME-ONLY: nothing is left once the do-not-translate names, `{placeholders}`,
//    URLs and punctuation are removed — `Motir`, `Cloud · OAuth`, `{reason}`,
//    `{done} / {total}`, `https://your-instance.example.com`. There is nothing in
//    such a value TO translate.
// 2. The brand phrase `Vibe the project`, which motir.co keeps in English in every
//    language (`onboarding.entrance.headingDefault`, recorded by the Chinese and
//    nine-languages voice cards).
// 3. A COGNATE — a word the target language spells exactly as English does, so
//    the correct translation IS the English string. Each is listed by locale and
//    key with its reason; nothing else is accepted, so a new identical value
//    fails until somebody decides which it is.

const DO_NOT_TRANSLATE = [
  'Motir AI',
  'Motir',
  'GitHub Issues',
  'GitHub',
  'Jira',
  'Linear',
  'Plane',
  'Vibe',
  'OAuth',
  'Cloud',
  'CSV',
  'owner/repo',
];

function isNameOnly(value: string): boolean {
  let rest = value.replace(/\{[^{}]*\}/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const name of DO_NOT_TRANSLATE) rest = rest.split(name).join(' ');
  return rest.replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

const BRAND_PHRASE_KEY = 'onboarding.entrance.headingDefault';

const COGNATES: Record<string, Record<string, string>> = {
  de: {
    'onboarding.landing.optional.optionalTag': '"optional" is the German word',
    'onboardingMigrate.rail.importOptional': '"optional" is the German word',
    'onboarding.directionDoc.optional': '"optional" is the German word',
    'onboarding.chat.railLabel': '"Chat" is the German word',
    'onboarding.chat.topbarLabel': '"Onboarding" is the loanword German product copy uses',
    'onboarding.design.theme.name': '"Theme" is the loanword German UI copy uses',
    'onboarding.design.theme.system': '"System" is the German word',
    'onboarding.generation.designLabel': '"Design" is the German word',
    'import.connect.repoNameLabel': '"Repository" is the German term',
    'import.map.rowLabels': '"Labels" is the German term',
  },
  fr: {
    'onboarding.chat.railLabel': '"Chat" is the French term',
    'onboarding.chat.canvas.facts.type': '"Type" is the French word',
    'onboarding.design.style.name': '"Style" is the French word',
    'onboarding.design.palette.name': '"Palette" is the French word',
    'onboarding.generation.designLabel': '"Design" is the French word',
    'import.map.auto': '"auto" is the French abbreviation',
    'import.preview.colAction': '"Action" is the French word',
  },
  es: {
    'onboarding.chat.railLabel': '"Chat" is the Spanish term',
    'import.map.auto': '"auto" is the Spanish abbreviation',
  },
  it: {
    'onboarding.chat.railLabel': '"Chat" is the Italian term',
    'onboarding.design.palette.name': '"Palette" is the Italian word',
    'onboarding.generation.designLabel': '"Design" is the Italian word',
    'import.connect.repoNameLabel': '"Repository" is the Italian term',
    'onboardingMigrate.index.perRepo': '"Per repository" is the Italian phrase',
  },
  nl: {
    'onboarding.nav.product': '"Product" is the Dutch word',
    'onboarding.chat.railLabel': '"Chat" is the Dutch word',
    'onboarding.chat.topbarLabel': '"Onboarding" is the loanword Dutch product copy uses',
    'onboarding.chat.canvas.facts.type': '"Type" is the Dutch word',
    'onboarding.chat.canvas.facts.platform': '"Platform" is the Dutch word',
    'import.connect.repoNameLabel': '"Repository" is the Dutch term',
    'import.map.rowLabels': '"Labels" is the Dutch word',
    'onboardingMigrate.index.perRepo': '"Per repository" is the Dutch phrase',
  },
  pl: {
    'import.steps.import': '"Import" is the Polish word',
    'import.map.auto': '"auto" is the Polish abbreviation',
  },
  pt: {
    'onboarding.chat.railLabel': '"Chat" is the Portuguese term',
    'onboarding.generation.designLabel': '"Design" is the Portuguese word',
  },
};

function identicalFindings(locale: string, leaves: Leaves): string[] {
  const cognates = COGNATES[locale] ?? {};
  const out: string[] = [];
  for (const [key, en] of EN) {
    if (leaves.get(key) !== en) continue;
    if (isNameOnly(en)) continue;
    if (key === BRAND_PHRASE_KEY) continue;
    if (key in cognates) continue;
    out.push(`${locale} ${key} = ${JSON.stringify(en)} — left English-only`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the onboarding voice — no AI-first pitch in any language', () => {
  it('every locale the app ships has its own pattern family', () => {
    expect(locales.filter((l) => !(l in AI_FIRST))).toEqual([]);
  });

  for (const locale of locales) {
    describe(locale, () => {
      const family = AI_FIRST[locale]!;

      it('its pattern matches the pre-story phrase it exists to keep out', () => {
        expect(family?.pattern.test(family.preStory)).toBe(true);
      });

      it('its pattern does not trip on the assistant’s name', () => {
        expect(family?.pattern.test(family.name)).toBe(false);
        expect(family.name).toContain('Motir AI');
      });

      it('no onboarding, migrate or import string pitches AI-first', () => {
        const hits = [...CATALOGUES.get(locale)!]
          .filter(([, value]) => family?.pattern.test(value))
          .map(([key, value]) => `${locale} ${key} = ${JSON.stringify(value)}`);
        expect(hits, hits.join('\n')).toEqual([]);
      });
    });
  }
});

describe('the onboarding catalogues — parity with English in every language', () => {
  it('walks real namespaces', () => {
    for (const ns of NAMESPACES) {
      expect(
        [...EN.keys()].some((k) => k.startsWith(`${ns}.`)),
        ns,
      ).toBe(true);
    }
  });

  for (const locale of OTHERS) {
    describe(locale, () => {
      const leaves = CATALOGUES.get(locale)!;

      it('has every key English has (a missing key renders English via fallback)', () => {
        const missing = [...EN.keys()]
          .filter((k) => !leaves.has(k))
          .map((k) => `${locale} ${k} — missing, renders English via fallback`);
        expect(missing, missing.join('\n')).toEqual([]);
      });

      it('has no key English does not (a stale key)', () => {
        const stale = [...leaves.keys()]
          .filter((k) => !EN.has(k))
          .map((k) => `${locale} ${k} — stale, not in en.json`);
        expect(stale, stale.join('\n')).toEqual([]);
      });

      it('leaves no English in place off the allow-list', () => {
        const found = identicalFindings(locale, leaves);
        expect(found, found.join('\n')).toEqual([]);
      });

      it('keeps every placeholder and plural shape', () => {
        const broken = [...EN].flatMap(([key, source]) => {
          const target = leaves.get(key);
          if (target === undefined) return [];
          return compareMessageShape(source, target, locale).map(
            (v) => `${locale} ${key}: ${v.kind}${v.name ? `:${v.name}` : ''} ${v.detail ?? ''}`,
          );
        });
        expect(broken, broken.join('\n')).toEqual([]);
      });

      it('every cognate on the allow-list is still identical (the list only shrinks)', () => {
        const drifted = Object.keys(COGNATES[locale] ?? {}).filter(
          (k) => !EN.has(k) || leaves.get(k) !== EN.get(k),
        );
        expect(drifted).toEqual([]);
      });
    });
  }
});
