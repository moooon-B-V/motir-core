import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

// The SHAPE of an ICU message (Story MOTIR-7730 · MOTIR-7745): the placeholders,
// the plural/select structure and the rich-text tags a translation must keep,
// whatever it does with the words. Parsed with the parser family next-intl
// renders with — never a regex: a placeholder can hide inside a plural branch,
// `#` means something only inside a plural, and `'{'` escapes text.

export type ShapeViolationKind =
  | 'unparseable'
  | 'argument-set'
  | 'argument-kind'
  | 'select-options'
  | 'plural-options'
  | 'tags';

export interface ShapeViolation {
  kind: ShapeViolationKind;
  /** The argument or tag the violation is about, when it is about one. */
  name?: string;
  detail: string;
}

type ArgumentKind = 'simple' | 'number' | 'date' | 'time' | 'select' | 'plural' | 'selectordinal';

interface Shape {
  /** argument name → every kind it was used as. */
  args: Map<string, Set<ArgumentKind>>;
  /** select argument name → option keys (union over occurrences). */
  selectOptions: Map<string, Set<string>>;
  /** plural / selectordinal occurrences, each with its option keys. */
  plurals: { name: string; type: 'cardinal' | 'ordinal'; keys: string[] }[];
  /** tag names that appear OUTSIDE every plural/select branch, with counts. */
  topLevelTags: Map<string, number>;
  /** every tag name anywhere. */
  tagNames: Set<string>;
  /** every parent>child tag nesting anywhere (`>child` for an outermost tag). */
  nesting: Set<string>;
}

function emptyShape(): Shape {
  return {
    args: new Map(),
    selectOptions: new Map(),
    plurals: [],
    topLevelTags: new Map(),
    tagNames: new Set(),
    nesting: new Set(),
  };
}

function addArg(shape: Shape, name: string, kind: ArgumentKind): void {
  const kinds = shape.args.get(name) ?? new Set<ArgumentKind>();
  kinds.add(kind);
  shape.args.set(name, kinds);
}

function walk(
  elements: MessageFormatElement[],
  shape: Shape,
  parentTag: string,
  inBranch: boolean,
): void {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
        addArg(shape, el.value, 'simple');
        break;
      case TYPE.number:
        addArg(shape, el.value, 'number');
        break;
      case TYPE.date:
        addArg(shape, el.value, 'date');
        break;
      case TYPE.time:
        addArg(shape, el.value, 'time');
        break;
      case TYPE.select: {
        addArg(shape, el.value, 'select');
        const keys = shape.selectOptions.get(el.value) ?? new Set<string>();
        for (const [key, option] of Object.entries(el.options)) {
          keys.add(key);
          walk(option.value, shape, parentTag, true);
        }
        shape.selectOptions.set(el.value, keys);
        break;
      }
      case TYPE.plural: {
        const type = el.pluralType === 'ordinal' ? 'ordinal' : 'cardinal';
        addArg(shape, el.value, type === 'ordinal' ? 'selectordinal' : 'plural');
        shape.plurals.push({ name: el.value, type, keys: Object.keys(el.options) });
        for (const option of Object.values(el.options)) walk(option.value, shape, parentTag, true);
        break;
      }
      case TYPE.tag:
        shape.tagNames.add(el.value);
        shape.nesting.add(`${parentTag}>${el.value}`);
        if (!inBranch)
          shape.topLevelTags.set(el.value, (shape.topLevelTags.get(el.value) ?? 0) + 1);
        walk(el.children, shape, el.value, inBranch);
        break;
      default:
        // literal and `#` carry no shape.
        break;
    }
  }
}

/** Parse a message into its shape, or `null` when it is not valid ICU. */
function shapeOf(message: string): Shape | null {
  let ast: MessageFormatElement[];
  try {
    // `requiresOtherClause: false` so a plural without `other` is reported by
    // name below rather than as a bare parse failure.
    ast = parse(message, { requiresOtherClause: false });
  } catch {
    return null;
  }
  const shape = emptyShape();
  walk(ast, shape, '', false);
  return shape;
}

function setDiff<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

const pluralCategoryCache = new Map<string, Set<string>>();
function pluralCategories(locale: string, type: 'cardinal' | 'ordinal'): Set<string> {
  const key = `${locale}:${type}`;
  let cats = pluralCategoryCache.get(key);
  if (!cats) {
    cats = new Set(new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories);
    pluralCategoryCache.set(key, cats);
  }
  return cats;
}

/**
 * Compare a translation's shape with its English source. Returns every
 * violation found; an empty list means the translation keeps the shape.
 *
 * Plural CATEGORIES are deliberately not required to equal the source's —
 * Japanese and Korean have only `other`, Polish adds `few` and `many` — so a
 * plural is checked against the TARGET locale's CLDR categories instead.
 */
export function compareMessageShape(
  source: string,
  target: string,
  locale: string,
): ShapeViolation[] {
  const s = shapeOf(source);
  // A source that is not valid ICU is rendered RAW (`t.raw`) — two en.json
  // values are, each holding a literal `<command>` / `<KEY>`. There is no ICU
  // shape to keep, so the translation must keep the same literal `{…}` and
  // `<…>` tokens instead.
  if (!s) return compareRawTokens(source, target);
  const t = shapeOf(target);
  if (!t) return [{ kind: 'unparseable', detail: 'the translation is not valid ICU' }];

  const violations: ShapeViolation[] = [];

  const sNames = new Set(s.args.keys());
  const tNames = new Set(t.args.keys());
  for (const name of setDiff(sNames, tNames)) {
    violations.push({ kind: 'argument-set', name, detail: `missing {${name}}` });
  }
  for (const name of setDiff(tNames, sNames)) {
    violations.push({ kind: 'argument-set', name, detail: `invented {${name}}` });
  }
  for (const name of sNames) {
    const sk = s.args.get(name);
    const tk = t.args.get(name);
    if (!sk || !tk) continue;
    const same = sk.size === tk.size && [...sk].every((k) => tk.has(k));
    if (!same) {
      violations.push({
        kind: 'argument-kind',
        name,
        detail: `{${name}} is ${[...tk].join('/')} but the source has ${[...sk].join('/')}`,
      });
    }
  }

  for (const [name, sKeys] of s.selectOptions) {
    const tKeys = t.selectOptions.get(name);
    if (!tKeys) continue; // already reported as argument-set / argument-kind
    const missing = setDiff(sKeys, tKeys);
    const extra = setDiff(tKeys, sKeys);
    if (missing.length || extra.length) {
      violations.push({
        kind: 'select-options',
        name,
        detail: `select {${name}} options differ (missing: ${missing.join(', ') || '—'}; extra: ${extra.join(', ') || '—'})`,
      });
    }
  }

  for (const plural of t.plurals) {
    const allowed = pluralCategories(locale, plural.type);
    if (!plural.keys.includes('other')) {
      violations.push({
        kind: 'plural-options',
        name: plural.name,
        detail: `plural {${plural.name}} has no "other" branch`,
      });
    }
    const outside = plural.keys.filter((k) => !/^=\d+$/.test(k) && !allowed.has(k));
    if (outside.length) {
      violations.push({
        kind: 'plural-options',
        name: plural.name,
        detail: `plural {${plural.name}} has ${outside.join(', ')}, outside ${locale}'s categories (${[...allowed].join(', ')})`,
      });
    }
  }

  for (const name of setDiff(s.tagNames, t.tagNames)) {
    violations.push({ kind: 'tags', name, detail: `missing tag <${name}>` });
  }
  for (const name of setDiff(t.tagNames, s.tagNames)) {
    violations.push({ kind: 'tags', name, detail: `invented tag <${name}>` });
  }
  for (const [name, count] of s.topLevelTags) {
    const tc = t.topLevelTags.get(name) ?? 0;
    if (t.tagNames.has(name) && tc !== count) {
      violations.push({
        kind: 'tags',
        name,
        detail: `<${name}> appears ${tc}×, the source has ${count}×`,
      });
    }
  }
  if (
    setDiff(s.tagNames, t.tagNames).length === 0 &&
    setDiff(t.tagNames, s.tagNames).length === 0
  ) {
    const missingNest = setDiff(s.nesting, t.nesting);
    const extraNest = setDiff(t.nesting, s.nesting);
    if (missingNest.length || extraNest.length) {
      violations.push({
        kind: 'tags',
        detail: `tag nesting differs (source: ${[...s.nesting].join(' ')}; translation: ${[...t.nesting].join(' ')})`,
      });
    }
  }

  return violations;
}

const RAW_TOKEN = /\{[^{}]*\}|<\/?[A-Za-z][\w-]*>/g;

function compareRawTokens(source: string, target: string): ShapeViolation[] {
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const token of text.match(RAW_TOKEN) ?? []) m.set(token, (m.get(token) ?? 0) + 1);
    return m;
  };
  const s = count(source);
  const t = count(target);
  const violations: ShapeViolation[] = [];
  for (const token of new Set([...s.keys(), ...t.keys()])) {
    const sc = s.get(token) ?? 0;
    const tc = t.get(token) ?? 0;
    if (sc !== tc) {
      violations.push({
        kind: token.startsWith('{') ? 'argument-set' : 'tags',
        name: token,
        detail: `raw token ${token} appears ${tc}×, the source has ${sc}×`,
      });
    }
  }
  return violations;
}
