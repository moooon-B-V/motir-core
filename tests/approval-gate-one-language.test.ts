import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVAL_GATE_HANDLERS, UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';

// STORY MOTIR-4778's OWN GATE — the ONE-LANGUAGE guards (Subtask MOTIR-4796).
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHY IT IS NOT A SECOND COPY OF THE UNIT TESTS.
// Every card in this story shipped a correct piece and its own units to prove
// it. What no single card can assert is the property the STORY claims:
// **approving means ONE thing.** That property is about the relationship
// BETWEEN the pieces, so it is only checkable from outside all of them — which
// is this file, and nowhere else.
//
// Each guard below closes a different way the claim decays, and each is
// STRUCTURAL rather than behavioural on purpose. An appearance test passes on
// two components that agree today and says nothing about the day they diverge;
// a test that drives the door proves the door works and says nothing about a
// second door existing beside it. So these read the SOURCE the way a reviewer
// would — the `planChangeArchitecture` / `render-single-source` pattern — and
// they fail on the arrival of a second thing, which is the event that matters.
//
//   1 · ONE CONTROL. The approval frame is a shared, composable component:
//       kind-agnostic in its own source, with everything kind-specific arriving
//       as props, and every surface that renders a gate rendering THAT module.
//   2 · ONE DOOR. A gate's DECISION state has exactly one writer, and the two
//       non-decision writers are DECLARED here with their single call sites.
//   3 · REGISTRY TOTALITY, the half the shipped probe does not cover: a NEW
//       member of the enum fails the build.
//
// ⚠️ GUARD 3 IS DELIBERATELY THE SECOND HALF OF A PAIR.
// `tests/approval-gate-registry.test.ts` (MOTIR-4790) already runs a real `tsc`
// probe for the registry's OTHER compile-time guarantee — *promoting* a kind
// into the registered set fails until its handler exists. Re-writing that here
// would be re-covering what a code subtask's units already prove, which this
// card is told not to do. The guarantee with no probe was the first one the
// registry's own header claims — *"A NEW ENUM MEMBER FAILS THE BUILD"* — and
// that is the one below.

const ROOT = process.cwd();

/** Every gate kind, sourced from the registry rather than re-typed. The
 *  registry's own `_KindsAreExhaustive` assertion is what makes this total over
 *  the Prisma enum, so a fifth kind joins this list by existing. */
const ALL_GATE_KINDS: readonly string[] = [
  ...Object.keys(APPROVAL_GATE_HANDLERS),
  ...UNREGISTERED_GATE_KINDS,
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * A file with its comments stripped.
 *
 * ⚠️ EVERY GUARD BELOW ASSERTS THE ABSENCE OF SOMETHING, and these files
 * discuss that very something at length in prose — the service's own header
 * names `approvalGateRepository.decide`, the control's header names
 * `design_result`. Matching raw source would make each guard fail on its
 * subject's documentation, and the reflex repair (delete the comment) removes
 * the best explanation in the file. So the guards read CODE.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `app` + `components` + `lib`, repo-relative — the product surface the guards
 *  quantify over. Tests are deliberately outside it: a fixture may name a kind
 *  or build a gate row, and that is not a second vocabulary. */
const SOURCE_FILES: readonly string[] = ['app', 'components', 'lib']
  .flatMap((d) => collectSourceFiles(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f));

const CONTROL = 'components/approvals/ApprovalGateControl.tsx';

describe('ONE CONTROL — the approval frame is SHARED and COMPOSABLE (MOTIR-4796)', () => {
  // ⚠️ THIS GUARD IS THE AMENDED ONE, AND THE AMENDMENT MADE IT STRONGER.
  // The card as written asked for component IDENTITY across three surfaces —
  // the design-result panel, the Development section and the Approvals row.
  // MOTIR-4778's split moved two of those to sibling stories, so this build has
  // exactly ONE production render site, and "two subjects render the same
  // module" is not assertable here.
  //
  // That is not a weaker property to settle for; it is the STRONGER half of the
  // pair. Two call sites rendering one component is a fact about today that a
  // third call site can falsify. A component that is kind-agnostic BY
  // CONSTRUCTION — no kind in its source, everything kind-specific arriving as
  // data — is a property no later kind can break without breaking this guard.
  // Identity across surfaces then follows from it rather than being checked
  // beside it.

  it('names NO gate kind in its own code — a kind reaches it only as data', () => {
    const code = codeOf(CONTROL);
    const named = ALL_GATE_KINDS.filter((kind) => code.includes(kind));
    // A kind literal in the frame is the frame growing knowledge of one kind,
    // which is the exact shape ADR §1's registry exists to keep out of the
    // generic half. The remedy is a prop, never a branch.
    expect(named, `the shared approval frame branches on ${named.join(', ')}`).toEqual([]);
  });

  it('imports nothing kind-specific — no handler, no subject repository, no service', () => {
    const code = codeOf(CONTROL);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const offending = imports.filter(
      (spec) =>
        /designResult|designEvidence|pullRequest/i.test(spec) ||
        spec.startsWith('@/lib/services/') ||
        spec.startsWith('@/lib/repositories/'),
    );
    // The second clause is the client/server boundary the DTO's own note
    // records: a `'use client'` module importing the service layer compiles,
    // survives SSR and then fails in the browser. Both failures have the same
    // remedy — the frame takes data, not sources.
    expect(offending, `the frame imports ${offending.join(', ')}`).toEqual([]);
  });

  it('takes EVERY kind-specific thing as a prop — the slots ADR §1 promises', () => {
    const code = codeOf(CONTROL);
    const props = code.slice(code.indexOf('interface ApprovalGateControlProps'));
    // `port` is band 2 (the subject, rendered) and `verbs` is band 3 (the verb
    // SET, as data — a pair is one case, not the shape). Those two are what
    // make a third kind "a row in the enum, a handler, and a renderer" rather
    // than a second approval feature.
    for (const slot of [
      'kindLabel',
      'subjectMeta',
      'port',
      'verbs',
      'consequence',
      'confirmConsequences',
    ]) {
      expect(props, `the frame lost its \`${slot}\` slot`).toMatch(
        new RegExp(`^\\s*${slot}[?]?:`, 'm'),
      );
    }
  });

  it('is rendered by EVERY surface that renders a gate — no second control', () => {
    // THE POPULATION IS DERIVED, NOT LISTED. Any renderable module that handles
    // an `ApprovalGateDTO` is a surface that shows somebody a gate; each must
    // render the shared frame rather than its own markup. When
    // `pull_request_approval` lands, its section joins this population by
    // existing and is held to the same rule with no edit here — which is the
    // whole point of deriving it.
    const gateSurfaces = SOURCE_FILES.filter(
      (f) => f.endsWith('.tsx') && f !== CONTROL && codeOf(f).includes('ApprovalGateDTO'),
    );
    // Vacuity check: this guard is worthless if the population is empty, and an
    // empty population is exactly what a rename would produce.
    expect(gateSurfaces.length).toBeGreaterThan(0);

    for (const file of gateSurfaces) {
      expect(codeOf(file), `${file} renders a gate without the shared frame`).toContain(
        "from '@/components/approvals/ApprovalGateControl'",
      );
    }
  });
});

describe('ONE DOOR — a gate DECISION has exactly one writer (MOTIR-4796)', () => {
  // ⚠️ THE CARD SAID "no gate's `state` is written anywhere but
  // `approvalGatesService.decide`", AND THAT SENTENCE IS FALSE OF SHIPPED CODE
  // — for two reasons that are both correct, which is why this guard states the
  // property at the altitude the claim actually lives at.
  //
  // A gate's `state` column is written by THREE things, and only one of them is
  // a decision:
  //
  //   · `create` writes `awaiting` — asking the question;
  //   · `supersedeAwaitingByWorkItem` writes `superseded` — WITHDRAWING the
  //     question (ADR §6b), which carries no actor, no authority and no note
  //     precisely so the audit can never read it as somebody's answer;
  //   · `decide` writes `approved` / `changes_requested` — the DECISION.
  //
  // The story's claim is about the third. A guard written to the card's literal
  // words would have to either fail on `main` or quietly exempt the supersede
  // path, and a quiet exemption is how a real second writer gets in later
  // wearing the same excuse. So the exemptions are DECLARED, with their single
  // call sites asserted — the registry's own *"the holes are declared, not
  // left"* discipline, applied to writers instead of kinds.

  const REPO = 'lib/repositories/approvalGateRepository.ts';
  const DOOR = 'lib/services/approvalGatesService.ts';

  /** The two writes that are NOT decisions, each with the ONE production caller
   *  it is allowed. Adding a row here is a deliberate act a reviewer sees. */
  const DECLARED_NON_DECISION_WRITERS = [
    { method: 'create', writes: 'awaiting', caller: 'lib/services/designEvidenceService.ts' },
    {
      method: 'supersedeAwaitingByWorkItem',
      writes: 'superseded',
      caller: 'lib/services/designEvidenceService.ts',
    },
  ] as const;

  it('routes every DECISION through `approvalGatesService.decide` — one call site', () => {
    const callers = SOURCE_FILES.filter((f) =>
      codeOf(f).includes('approvalGateRepository.decide('),
    );
    expect(callers).toEqual([DOOR]);
  });

  it('writes the `approval_gate` table NOWHERE but the repository leaf', () => {
    // ⚠️ THE PREDICATE IS THE PRISMA WRITE, NOT THE STATE LITERAL, and the
    // first cut of this guard got that wrong in a way worth recording: it
    // matched `state: 'approved'` as source text and fired on two TYPE
    // POSITIONS — a constructor parameter in `errors.ts` and the `data`
    // parameter of `decide` itself — while matching the actual write not at
    // all, because the repository passes `data` through opaquely. A guard keyed
    // on how a value is SPELLED is falsifiable by spelling it differently; one
    // keyed on the write reaches a second writer whatever it writes.
    const writers = SOURCE_FILES.filter((f) =>
      /\bapprovalGate\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\b/.test(
        codeOf(f),
      ),
    );
    // A service, a route, a job or a server action reaching the table directly
    // would be a second door with none of this door's obligations — no lock, no
    // re-read, no actor gate, no audit set — and CLAUDE.md's 4-layer rule
    // already forbids it. Here it is also the mechanism the story's claim rests
    // on, so it is asserted where the claim is made.
    expect(writers).toEqual([REPO]);
  });

  it('keeps each DECLARED non-decision writer to its one caller', () => {
    for (const { method, caller } of DECLARED_NON_DECISION_WRITERS) {
      const callers = SOURCE_FILES.filter((f) =>
        codeOf(f).includes(`approvalGateRepository.${method}(`),
      );
      expect(callers, `\`${method}\` grew a second caller`).toEqual([caller]);
    }
  });

  it('lets NO new writer in unnoticed — the repository’s own writes are COUNTED', () => {
    // THE BACKSTOP, and the guard this file would be incomplete without. The
    // three assertions above each name a write we already know about; a FOURTH
    // one — a new repository method, reached by a new caller — satisfies every
    // one of them by not being mentioned in any. Counting is what closes that,
    // and it fails loudly on the one event that matters: the table growing a
    // way to be written that nobody has classified as a decision or declared as
    // not one.
    const repoWrites = [
      ...codeOf(REPO).matchAll(
        /\bapprovalGate\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\b/g,
      ),
    ].length;
    expect(
      repoWrites,
      'the gate repository grew a write this guard does not classify — ' +
        'declare it as a non-decision writer, or route it through the decide door',
    ).toBe(DECLARED_NON_DECISION_WRITERS.length + 1);
  });
});

describe('REGISTRY TOTALITY — a NEW enum member fails the build (MOTIR-4796)', () => {
  // ⚠️ WHY A REAL `tsc` RUN, and why THIS half. Every type-level assertion in
  // `registry.ts` observes what the compiler already accepted, which cannot
  // tell "the classification is total" from "it happens to be total today". The
  // criterion is about the BUILD FAILING, so the test runs a build — the same
  // reasoning, and the same mechanics, as the promotion probe MOTIR-4790
  // shipped in `tests/approval-gate-registry.test.ts`.
  //
  // What differs is WHICH guarantee is probed. That one edits the REGISTERED
  // set; this one widens the ENUM, which is the first thing a new kind's
  // migration does and the point at which the classification must stop
  // compiling. The probe imports the REAL `UNREGISTERED_GATE_KINDS` and the
  // REAL `RegisteredGateKind`, and checks them against the enum as it would
  // stand with one member added — so the only thing simulated is the widening
  // itself.

  it('a fifth `ApprovalGateKind` breaks the classification until somebody files it', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, '.tsprobe-kind-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'probe.ts'),
        [
          "import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';",
          "import type { RegisteredGateKind } from '@/lib/approvalGates/registry';",
          "import type { ApprovalGateKind } from '@/generated/prisma/client';",
          '',
          '// The enum as a migration would leave it the moment a fifth kind is',
          '// added — before anybody has classified it as registered or as a',
          '// declared hole. The tuple and the registered set are the REAL ones.',
          "type WidenedKind = ApprovalGateKind | 'decision_choice';",
          'type WidenedUnregistered = Exclude<WidenedKind, RegisteredGateKind>;',
          '',
          'type AssertEqual<A, B> =',
          '  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2',
          '    ? true',
          "    : { ERROR: 'approval-gate kinds are not exhaustively classified' };",
          '',
          '// This must NOT compile: the shipped tuple cannot enumerate a member',
          '// nobody has added to it.',
          'export const proof: true = null as unknown as AssertEqual<',
          '  (typeof UNREGISTERED_GATE_KINDS)[number],',
          '  WidenedUnregistered',
          '>;',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: '../tsconfig.base.json',
          compilerOptions: { noEmit: true, composite: false, incremental: false },
          include: ['probe.ts'],
        }),
      );

      let failed = false;
      let output = '';
      try {
        execFileSync(
          'node',
          [
            path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
            '-p',
            path.join(dir, 'tsconfig.json'),
          ],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (err) {
        failed = true;
        output = String((err as { stdout?: string }).stdout ?? '');
      }

      expect(failed).toBe(true);
      // Not merely "some error": it must be THIS error. A probe that failed for
      // an unrelated reason would satisfy a bare `expect(failed).toBe(true)`
      // while proving nothing at all.
      expect(output).toMatch(/not exhaustively classified|TS2322/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
