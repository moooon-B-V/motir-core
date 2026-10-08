'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  type FontSet,
  type FontSetId,
  type FontSetMember,
  type FontSetRole,
} from '@motir/design-system';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';

// MOTIR-7848 — the /tokens Font sets section, as designed by MOTIR-7844
// (`design/design-system/tokens-page--font-sets.mock.html`, design-notes § 9).
//
// Every row comes from FONT_SET_REGISTRY. A sample element carries its set's
// `lang` (and `data-font-set-<role>` for a non-default member), and theme.css
// turns that into the member's face (MOTIR-7845). The browser then fetches that
// face's files because rendered text uses it (MOTIR-7847). So the files are
// requested by RENDERING the samples, never by `import()` or `new FontFace`.
//
// That is why the samples mount only once the section is on screen: one Han,
// kana or Hangul glyph in the DOM before then would fetch its set's face on
// every visit to /tokens. Until then the section holds Latin text only.

/** Specimen content per set. Not interface copy, so not in the message catalogue. */
const SAMPLES: Record<FontSetId, { text: string; code: string; script: string }> = {
  latin: {
    text: 'Zażółć gęślą jaźń · Ĳsselmeer · Ça',
    code: 'Zażółć gęślą jaźń · Ĳsselmeer · Ça',
    script: 'Latin',
  },
  'zh-Hans': {
    text: '敏捷的棕色狐狸跳过了懒狗 · 直 骨',
    code: 'const 任务 = "已完成";',
    script: 'Han',
  },
  ja: {
    text: 'いろはにほへと 素早い茶色の狐 · 直 骨',
    code: 'const 課題 = "完了";',
    script: 'kana and kanji',
  },
  ko: {
    text: '다람쥐 헌 쳇바퀴에 타고파 · 直 骨',
    code: 'const 작업 = "완료";',
    script: 'Hangul',
  },
};

/** The two characters whose standard form differs by region (the story names them). */
const REGION_GLYPHS = '直 骨';

/** Notes the design attaches to one member (design-notes § 9.1). */
const MEMBER_NOTES: Partial<Record<string, string>> = {
  'zh-Hans/serif/lxgw-wenkai-tc': 'Draws Traditional (inherited) forms, so never the default.',
};

/** The apply-by-name panel's member (design-notes § 9.3). */
export const APPLY_BY_NAME = { setId: 'ja', role: 'sans', memberId: 'm-plus-rounded-1c' } as const;

const ROLE_CLASS: Record<FontSetRole, string> = {
  sans: 'font-sans',
  serif: 'font-serif',
  mono: 'font-mono',
};

/** The locales a set draws, in LOCALE_FONT_SET order. */
function setLocales(setId: FontSetId): string[] {
  return Object.entries(LOCALE_FONT_SET)
    .filter(([, id]) => id === setId)
    .map(([locale]) => locale);
}

/** The `lang` a set's samples carry: its own tag, or its first locale for the Latin set. */
export function sampleLang(set: FontSet): string {
  return set.lang ?? setLocales(set.id as FontSetId)[0] ?? 'en';
}

/** The `data-font-set-<role>` attribute for a non-default member, or nothing. */
function memberAttr(role: FontSetRole, member: FontSetMember, isDefault: boolean) {
  return isDefault ? {} : { [`data-font-set-${role}`]: member.id };
}

/** True once the element has intersected the viewport; it then stays true. */
function useOnScreenOnce(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Never decided during render: the server render must stay glyph-free.
      queueMicrotask(() => setSeen(true));
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/** The first family in an element's computed `font-family`, following the active pairing. */
function useFirstFamily(ref: RefObject<HTMLElement | null>, enabled: boolean): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const el = ref.current;
      if (!el) return;
      const first = getComputedStyle(el)
        .fontFamily.split(',')[0]
        ?.trim()
        .replace(/^["']|["']$/g, '');
      setFamily(first || null);
    };
    read();
    // The Type toggle flips `data-type` on <html> without re-rendering this page.
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-type'] });
    return () => mo.disconnect();
  }, [ref, enabled]);
  return family;
}

type FaceStatus = { state: 'loading' } | { state: 'loaded' } | { state: 'failed'; reason: string };

/** Whether `family` has loaded for `text`, through the browser's own font loading. */
function useFaceStatus(family: string | null, text: string): FaceStatus {
  const key = `${family ?? ''}|${text}`;
  const [result, setResult] = useState<{ key: string; status: FaceStatus } | null>(null);
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (!family || !fonts) return;
    let live = true;
    const settle = (status: FaceStatus) => {
      if (live) setResult({ key, status });
    };
    fonts.load(`20px "${family}"`, text).then(
      (faces) => {
        if (faces.length === 0) {
          settle({ state: 'failed', reason: `No ${family} face is declared for this text.` });
        } else if (faces.some((f) => f.status === 'error')) {
          settle({ state: 'failed', reason: 'The face file failed to load.' });
        } else {
          settle({ state: 'loaded' });
        }
      },
      () => settle({ state: 'failed', reason: 'The face file failed to load.' }),
    );
    return () => {
      live = false;
    };
  }, [family, text, key]);
  // No Font Loading API: nothing can tell loading from loaded, so claim neither.
  if (typeof document !== 'undefined' && !document.fonts) return { state: 'loaded' };
  return result?.key === key ? result.status : { state: 'loading' };
}

const captionStyle = { color: 'var(--el-text-secondary)' } as const;
const sampleStyle = { fontSize: '20px', lineHeight: 1.5, color: 'var(--el-text)' } as const;

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-[13px]" style={{ ...captionStyle, marginTop: '2px' }}>
      {children}
    </div>
  );
}

function MemberRow({
  set,
  role,
  member,
  isDefault,
}: {
  set: FontSet;
  role: FontSetRole;
  member: FontSetMember;
  isDefault: boolean;
}) {
  const sampleRef = useRef<HTMLDivElement>(null);
  const isPairing = member.source.kind === 'type-pairing';
  const pairingFamily = useFirstFamily(sampleRef, isPairing);
  const family = isPairing ? pairingFamily : member.family;
  const sample = SAMPLES[set.id as FontSetId];
  const text = role === 'mono' ? sample.code : sample.text;
  const status = useFaceStatus(family, text);

  const note = isPairing
    ? "The active pairing's own face. The set loads nothing."
    : member.sameFaceAs
      ? `Composition: the pairing's ${role} face for Latin, the set's ${member.sameFaceAs} face for ${sample.script}.`
      : MEMBER_NOTES[`${set.id}/${role}/${member.id}`];

  return (
    <div data-font-set-member={`${set.id}/${role}/${member.id}`}>
      <div className="flex flex-wrap items-center gap-1" style={{ marginBottom: '2px' }}>
        <span className="font-mono text-xs" style={{ color: 'var(--el-text)' }}>
          {member.id} · {family ?? '…'}
        </span>
        {isDefault && <Pill severity="success">default</Pill>}
        {!member.inDooooWeb && <Pill severity="warning">added (not in dooooWeb)</Pill>}
        {status.state === 'loading' && family && <Pill severity="info">loading {family}</Pill>}
        {status.state === 'failed' && <Pill severity="danger">not loaded</Pill>}
      </div>
      <div
        ref={sampleRef}
        lang={sampleLang(set)}
        {...memberAttr(role, member, isDefault)}
        className={ROLE_CLASS[role]}
        style={sampleStyle}
        data-font-set-sample=""
      >
        {text}
      </div>
      {status.state === 'failed' && <Note>{status.reason} Shown in the fallback face.</Note>}
      {note && <Note>{note}</Note>}
    </div>
  );
}

function SetCard({ set }: { set: FontSet }) {
  return (
    <Card data-font-set={set.id}>
      <div
        className="flex flex-wrap items-baseline gap-1"
        style={{ marginBottom: 'var(--spacing-md)' }}
      >
        <span className="font-mono text-base font-semibold" style={{ color: 'var(--el-text)' }}>
          {set.id}
        </span>
        <span className="font-mono text-xs" style={captionStyle}>
          — {setLocales(set.id as FontSetId).join(' · ')}
        </span>
      </div>
      {FONT_SET_ROLES.map((role) => {
        const r = set.roles[role];
        return (
          <div
            key={role}
            className="grid grid-cols-1 gap-1 sm:grid-cols-[96px_1fr] sm:gap-3"
            style={{ padding: 'var(--spacing-sm) 0', borderTop: '1px solid var(--el-border)' }}
          >
            <div className="font-mono text-xs" style={captionStyle}>
              {role}
            </div>
            <div className="grid gap-2">
              {r.members.map((m) => (
                <MemberRow
                  key={m.id}
                  set={set}
                  role={role}
                  member={m}
                  isDefault={m.id === r.default}
                />
              ))}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function Placeholder({ set }: { set: FontSet }) {
  // Latin text only: the language is named in English, never as an endonym.
  const what = set.cjk ? set.label : setLocales(set.id as FontSetId).join(', ');
  return (
    <div
      data-font-set-placeholder={set.id}
      className="text-sm"
      style={{
        ...captionStyle,
        border: '1px dashed var(--el-border)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--spacing-card-padding)',
      }}
    >
      {set.id} · {what} · samples load when this section is on screen
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p
      className="font-mono text-xs"
      style={{
        ...captionStyle,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 'var(--spacing-md)',
      }}
    >
      {children}
    </p>
  );
}

const cellStyle = {
  border: '1px solid var(--el-border)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--spacing-md)',
} as const;

function RegionForms({ sets }: { sets: FontSet[] }) {
  return (
    <div style={{ marginTop: 'var(--spacing-xl)' }}>
      <Eyebrow>Region forms</Eyebrow>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
      >
        {sets.map((set) => {
          const face = set.roles.sans.members.find((m) => m.id === set.roles.sans.default);
          return (
            <div
              key={set.id}
              data-font-set-region={set.id}
              style={{ ...cellStyle, textAlign: 'center' }}
            >
              <div
                lang={sampleLang(set)}
                className="font-sans"
                style={{ fontSize: '56px', lineHeight: 1.2, color: 'var(--el-text)' }}
              >
                {REGION_GLYPHS}
              </div>
              <div className="font-mono text-xs" style={captionStyle}>
                {set.id} · {face?.family}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ApplyByName() {
  const set = FONT_SET_REGISTRY[APPLY_BY_NAME.setId];
  const { role, memberId } = APPLY_BY_NAME;
  const defaultId = set.roles[role].default;
  const text = SAMPLES[APPLY_BY_NAME.setId].text;
  const attr = `data-font-set-${role}`;
  return (
    <div style={{ marginTop: 'var(--spacing-xl)' }}>
      <Eyebrow>Apply a member by name</Eyebrow>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
      >
        <div>
          <div className="font-mono text-xs" style={captionStyle}>
            {set.id} · {role} · default ({defaultId})
          </div>
          <div lang={sampleLang(set)} className={ROLE_CLASS[role]} style={sampleStyle}>
            {text}
          </div>
        </div>
        <div>
          <div className="font-mono text-xs" style={captionStyle}>
            {set.id} · {role} · {attr}=&quot;{memberId}&quot;
          </div>
          <div
            lang={sampleLang(set)}
            {...{ [attr]: memberId }}
            className={ROLE_CLASS[role]}
            style={sampleStyle}
            data-font-set-apply-by-name=""
          >
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The section body, under the page's own `<Section title="Font sets">`. It
 * renders placeholders until it is on screen, then every set's samples.
 */
export function FontSetsSection() {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreenOnce(ref);
  const sets = FONT_SET_IDS.map((id) => FONT_SET_REGISTRY[id] as FontSet);

  return (
    <div ref={ref} data-font-sets-mounted={onScreen ? 'true' : 'false'}>
      <Eyebrow>Each locale&apos;s script, behind the active Type pairing</Eyebrow>
      <div className="grid gap-6">
        {sets.map((set) =>
          onScreen ? <SetCard key={set.id} set={set} /> : <Placeholder key={set.id} set={set} />,
        )}
      </div>
      {onScreen && (
        <>
          <RegionForms sets={sets.filter((s) => s.cjk)} />
          <ApplyByName />
        </>
      )}
    </div>
  );
}
