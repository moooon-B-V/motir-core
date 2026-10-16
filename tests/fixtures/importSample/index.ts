// Loaders for the import-sample fixture (Story MOTIR-8240 · MOTIR-8752).
//
// Each file is imported as JSON and checked against its type with `satisfies`
// before it is handed out, so a renamed or missing key is a `pnpm typecheck`
// failure. JSON gives every string the type `string` — never a literal — so the
// check is against `Loose<T>`: the same keys and nesting, with each literal union
// (a kind, a status category, a priority) widened to `string`. The VALUES of
// those fields are the fixture check's job (`validate.ts`), which reads them at
// run time. No logic beyond that lives here.

import expectedJira from './expected/jira.json';
import expectedLinear from './expected/linear.json';
import expectedPlane from './expected/plane.json';
import projectJson from './project.json';
import translationJson from './translation.json';
import type {
  ExpectedResult,
  FixtureProject,
  PerVendor,
  TranslationTable,
  VendorId,
} from './types';

/** `T` as JSON can spell it: literal unions widened to their primitive, the
 *  key set and nesting kept. An empty JSON array is `never[]`, which fits. */
type Loose<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? null
        : T extends readonly (infer U)[]
          ? Loose<U>[]
          : T extends object
            ? { [K in keyof T]: Loose<T[K]> }
            : T;

const project = projectJson satisfies Loose<FixtureProject>;
const translation = translationJson satisfies Loose<TranslationTable>;
const expected = {
  jira: expectedJira satisfies Loose<ExpectedResult>,
  linear: expectedLinear satisfies Loose<ExpectedResult>,
  plane: expectedPlane satisfies Loose<ExpectedResult>,
};

/** The vendor-neutral sample project. */
export function loadProject(): FixtureProject {
  return project as FixtureProject;
}

/** The per-vendor translation of every fixture concept. */
export function loadTranslation(): TranslationTable {
  return translation as TranslationTable;
}

/** What Motir should hold after importing the project from `vendor`. */
export function loadExpected(vendor: VendorId): ExpectedResult {
  return (expected as PerVendor<ExpectedResult>)[vendor];
}
