import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The catalogue model behind the translation script (Story MOTIR-7730 ·
// MOTIR-7745): flattening a nested catalogue into dotted leaf keys, rebuilding
// one in en.json's order, and the SOURCE RECORD — `messages/sources/<l>.json`, a
// flat `"<dotted.key>": "<the en.json value the translation was made from>"`
// map. The record stores the full English text rather than a hash so a reviewer
// can see what changed.
//
// Array values (en.json has a few, e.g. billing tier feature lists) are leaves
// per ELEMENT — `a.b.0`, `a.b.1` — so each string is translated and recorded on
// its own; an array is written into a catalogue only when every element is
// present.

export type Catalogue = Record<string, unknown>;
export type FlatCatalogue = Map<string, string>;

export function flattenCatalogue(
  obj: unknown,
  prefix = '',
  out: FlatCatalogue = new Map(),
): FlatCatalogue {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenCatalogue(v, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flattenCatalogue(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === 'string') {
    out.set(prefix, obj);
  }
  return out;
}

/** The dotted path of the ARRAY a key is an element of, or null. Batches keep an
 *  array's elements together. */
export function arrayParentOf(en: Catalogue, key: string): string | null {
  const parts = key.split('.');
  let node: unknown = en;
  for (let i = 0; i < parts.length - 1; i++) {
    node = Array.isArray(node)
      ? node[Number(parts[i])]
      : (node as Record<string, unknown>)?.[parts[i]!];
    if (Array.isArray(node)) return parts.slice(0, i + 1).join('.');
  }
  return null;
}

/** Rebuild a nested catalogue in en.json's key order from a flat map. Keys en
 *  does not hold are dropped (they are orphans). */
export function buildCatalogue(en: Catalogue, values: FlatCatalogue): Catalogue {
  function build(node: unknown, prefix: string): unknown {
    if (Array.isArray(node)) {
      const items = node.map((v, i) => build(v, `${prefix}.${i}`));
      return items.every((v) => v !== undefined) ? items : undefined;
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const built = build(v, prefix ? `${prefix}.${k}` : k);
        if (built !== undefined) out[k] = built;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return values.get(prefix);
  }
  return (build(en, '') as Catalogue | undefined) ?? {};
}

export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serialise(value));
}

export function cataloguePath(rootDir: string, locale: string): string {
  return join(rootDir, 'messages', `${locale}.json`);
}

export function recordPath(rootDir: string, locale: string): string {
  return join(rootDir, 'messages', 'sources', `${locale}.json`);
}

export function readRecord(rootDir: string, locale: string): Map<string, string> | null {
  const raw = readJson<Record<string, string>>(recordPath(rootDir, locale));
  return raw ? new Map(Object.entries(raw)) : null;
}

/** Write a record flat, in en.json key order, 2-space indented, trailing newline. */
export function writeRecord(
  rootDir: string,
  locale: string,
  enFlat: FlatCatalogue,
  record: Map<string, string>,
): void {
  const ordered: Record<string, string> = {};
  for (const key of enFlat.keys()) {
    const v = record.get(key);
    if (v !== undefined) ordered[key] = v;
  }
  writeJson(recordPath(rootDir, locale), ordered);
}

export interface KeyClasses {
  missing: string[];
  stale: string[];
  current: string[];
  untracked: string[];
  orphans: string[];
}

/** Put every en leaf key in exactly one class, and list the orphans. */
export function classifyKeys(
  enFlat: FlatCatalogue,
  catalogue: FlatCatalogue,
  record: Map<string, string> | null,
): KeyClasses {
  const out: KeyClasses = { missing: [], stale: [], current: [], untracked: [], orphans: [] };
  for (const [key, enValue] of enFlat) {
    if (!catalogue.has(key)) out.missing.push(key);
    else if (!record?.has(key)) out.untracked.push(key);
    else if (record.get(key) !== enValue) out.stale.push(key);
    else out.current.push(key);
  }
  const orphanSet = new Set<string>();
  for (const key of catalogue.keys()) if (!enFlat.has(key)) orphanSet.add(key);
  for (const key of record?.keys() ?? []) if (!enFlat.has(key)) orphanSet.add(key);
  out.orphans = [...orphanSet];
  return out;
}
