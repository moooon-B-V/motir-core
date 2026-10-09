'use client';

import { useTranslations } from 'next-intl';
import {
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  fontSetMemberVar,
  type FontSet,
  type FontSetLocale,
  type FontSetMember,
  type FontSetRole,
} from '@motir/design-system';
import { AxisRadioGroup, type AxisOption } from '@/components/theme/AppearancePickers';
import { useTheme } from '@/lib/contexts/theme-context';
import type { FontPicks } from '@/lib/appearance/fontPicks';

// The Typography axis on a page whose language has its own fonts (Story
// MOTIR-7736 · Subtask MOTIR-7899). The design of record is
// `design/settings/appearance--fonts-by-language.mock.html` (MOTIR-7895,
// revision 3): there is no separate font field. Typography IS the font choice,
// and its list follows the page's language. A Latin-script page keeps the type
// pairings (`TypePicker`); a ja, ko or zh page lists "Automatic (‹default›)"
// first and then that language's fonts, each drawn in its own face.
//
// The registry decides everything: no set or member id is written here, so a
// member the registry gains or loses is offered with no change.

/** One font a page language offers. */
export interface FontPickMember {
  id: string;
  family: string;
  role: FontSetRole;
  /** The CSS variable carrying the member's face (`fontSetMemberVar`). */
  cssVar: string;
}

/** What the Typography axis offers on a page in `locale`. */
export interface FontPickOptions {
  /** The roles with a real choice: two or more faces. */
  choosableRoles: FontSetRole[];
  /** The family Automatic stands for — the first choosable role's default. */
  defaultFamily: string | null;
  /** The face Automatic is drawn in. */
  defaultCssVar: string | null;
  /** Every member of every choosable role, in registry order. */
  members: FontPickMember[];
}

function isFace(m: FontSetMember): boolean {
  return m.source.kind !== 'type-pairing';
}

/**
 * The fonts a page in `locale` can pick between. A role is choosable when it
 * holds two or more real faces; picking within a single-face role changes
 * nothing, so it is not offered. Every Latin locale returns no members.
 */
export function fontPickOptions(locale: FontSetLocale): FontPickOptions {
  const set: FontSet = FONT_SET_REGISTRY[LOCALE_FONT_SET[locale]];
  const setId = LOCALE_FONT_SET[locale];
  const choosableRoles = FONT_SET_ROLES.filter(
    (role) => set.roles[role].members.filter(isFace).length >= 2,
  );
  const members: FontPickMember[] = [];
  for (const role of choosableRoles) {
    for (const m of set.roles[role].members) {
      const cssVar = fontSetMemberVar(setId, role, m.id);
      if (isFace(m) && m.family && cssVar)
        members.push({ id: m.id, family: m.family, role, cssVar });
    }
  }
  const first = choosableRoles[0];
  const defaultMember = first
    ? set.roles[first].members.find((m: FontSetMember) => m.id === set.roles[first].default)
    : undefined;
  return {
    choosableRoles,
    defaultFamily: defaultMember?.family ?? null,
    defaultCssVar: first && defaultMember ? fontSetMemberVar(setId, first, defaultMember.id) : null,
    members,
  };
}

/** The fixed script sample each chip previews, untranslated. Latin is never drawn. */
const SCRIPT_SAMPLE: Record<FontSetLocale, string> = {
  en: 'Aa',
  zh: '汉字与诗文',
  ja: 'ひらがなと漢字',
  ko: '한글과 한자',
  de: 'Aa',
  fr: 'Aa',
  es: 'Aa',
  it: 'Aa',
  nl: 'Aa',
  pl: 'Aa',
  pt: 'Aa',
};

/** The generic family behind a role's face while it loads. */
const GENERIC: Record<FontSetRole, string> = {
  sans: 'sans-serif',
  serif: 'serif',
  mono: 'monospace',
};

/** Automatic's option id. Never a member id: those are kebab-case slugs. */
const AUTOMATIC = '__automatic__';

/**
 * Which option a page language shows as selected: this session's pick first (a
 * `null` there is a cleared pick, so Automatic), then the stored baseline, then
 * Automatic. A stored id the language does not offer shows Automatic, the same
 * way rendering falls back to the default.
 */
export function selectedFontPick(
  locale: FontSetLocale,
  sessionPicks: Partial<Record<FontSetLocale, string | null>>,
  initialFontPicks: FontPicks,
  offered: readonly string[],
): string | null {
  const picked = locale in sessionPicks ? sessionPicks[locale] : initialFontPicks[locale];
  return picked && offered.includes(picked) ? picked : null;
}

export function LanguageFontPicker({
  locale,
  initialFontPicks,
  label,
}: {
  locale: FontSetLocale;
  initialFontPicks: FontPicks;
  label: string;
}) {
  const t = useTranslations('settings.appearance');
  const { fontPicks, setFontPick } = useTheme();
  const { members, defaultFamily, defaultCssVar, choosableRoles } = fontPickOptions(locale);
  const generic = GENERIC[choosableRoles[0] ?? 'sans'];
  const sample = (cssVar: string | null, role: FontSetRole) => (
    <span
      lang={locale}
      className="font-normal"
      style={cssVar ? { fontFamily: `var(${cssVar}), ${GENERIC[role]}` } : undefined}
    >
      {SCRIPT_SAMPLE[locale]}
    </span>
  );

  const options: AxisOption<string>[] = [
    {
      id: AUTOMATIC,
      label: t('type.automatic', { font: defaultFamily ?? '' }),
      labelStyle: defaultCssVar ? { fontFamily: `var(${defaultCssVar}), ${generic}` } : undefined,
      detail: sample(defaultCssVar, choosableRoles[0] ?? 'sans'),
    },
    ...members.map((m) => ({
      id: m.id,
      label: m.family,
      labelStyle: { fontFamily: `var(${m.cssVar}), ${GENERIC[m.role]}` },
      detail: sample(m.cssVar, m.role),
    })),
  ];

  const selected = selectedFontPick(
    locale,
    fontPicks,
    initialFontPicks,
    members.map((m) => m.id),
  );

  return (
    <AxisRadioGroup
      label={label}
      value={selected ?? AUTOMATIC}
      onChange={(id) => setFontPick(locale, id === AUTOMATIC ? null : id)}
      options={options}
    />
  );
}
