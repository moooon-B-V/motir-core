import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATE_ROUTING_STEPS,
  ONBOARDING_ROUTING_OUTCOMES,
  ONBOARDING_ROUTING_REFUSAL,
  readOnboardingRoutingVerdict,
} from '@/lib/dto/onboardingRouting';
import {
  ROUTE_ONBOARDING_CONTEXT_FIELD,
  routeOnboardingContextFor,
} from '@/lib/ai/routeOnboardingContext';

// THE ROUTING VERDICT, on motir-core's side (Story MOTIR-4753 · MOTIR-4769).
//
// ⚠️ WHAT THIS SUITE IS FOR is the one thing this side can get wrong. The
// judgement is `motir-ai`'s (MOTIR-4767) and carrying it is all this code does —
// so the failure available here is not a wrong verdict, it is a SECOND OPINION:
// *the planner said this project is plannable but the item count looks low, so
// let us onboard them anyway*. That would reinstate the exact proxy the story
// removed, in a place nobody will look for it, and it would be added in good
// faith by somebody defending against a bad verdict.
//
// So the assertions come in two halves: a well-formed verdict is acted on
// EXACTLY as given, including one this side might find surprising; and a
// MALFORMED one is declined — which is a different act, and takes the safe
// route rather than a guess.

const envelope = (verdict: unknown) => ({ envelopeVersion: 'v1', onboardingRouting: verdict });

describe('a WELL-FORMED verdict is carried, never second-guessed', () => {
  it('each of the three outcomes round-trips with its message', () => {
    for (const outcome of ONBOARDING_ROUTING_OUTCOMES) {
      const raw =
        outcome === 'onboard_existing_project'
          ? {
              outcome,
              message: 'Two things I still need.',
              keptSteps: ['discovery'],
              missing: ['who for?'],
            }
          : { outcome, message: 'What do you want to plan first?' };
      const read = readOnboardingRoutingVerdict(envelope(raw));
      expect(read?.ok, outcome).toBe(true);
      expect(read?.ok && read.verdict.outcome).toBe(outcome);
      expect(read?.ok && read.verdict.message.length).toBeGreaterThan(0);
    }
  });

  it('a `continue` verdict on a project with almost nothing is STILL `continue`', () => {
    // The surprising one, and the reason the rule is worth a test: this side has
    // no idea whether the planner was right, and having an opinion is the defect.
    const read = readOnboardingRoutingVerdict(
      envelope({ outcome: 'continue', message: 'I can see your code. What shall we plan?' }),
    );
    expect(read).toEqual({
      ok: true,
      verdict: { outcome: 'continue', message: 'I can see your code. What shall we plan?' },
    });
  });

  it('carries the kept steps and the missing-list to whatever renders them', () => {
    const read = readOnboardingRoutingVerdict(
      envelope({
        outcome: 'onboard_existing_project',
        message: 'I read acme/widgets and 214 work items.',
        keptSteps: ['connect', 'discovery'],
        missing: ['The repository is still mostly the starter template.', 'Nothing says who for.'],
      }),
    );
    expect(read?.ok && read.verdict.keptSteps).toEqual(['connect', 'discovery']);
    expect(read?.ok && read.verdict.missing).toHaveLength(2);
  });

  it('a missing-list that is absent reads as EMPTY, not as a refusal', () => {
    // Nothing missing is a legitimate answer for a route whose steps are all
    // machine work; an absent list must not be confused with a malformed one.
    const read = readOnboardingRoutingVerdict(
      envelope({ outcome: 'onboard_existing_project', message: 'm', keptSteps: ['index'] }),
    );
    expect(read?.ok && read.verdict.missing).toEqual([]);
  });
});

describe('a MALFORMED verdict is DECLINED — and that is not disagreeing with one', () => {
  it.each([
    ['an unknown outcome', { outcome: 'onboard', message: 'm' }],
    ['no outcome at all', { message: 'm' }],
    ['no message', { outcome: 'continue' }],
    ['a blank message', { outcome: 'continue', message: '   ' }],
    [
      'a step this product does not have',
      { outcome: 'onboard_existing_project', message: 'm', keptSteps: ['interview'] },
    ],
    [
      'kept steps that are not a list',
      { outcome: 'onboard_existing_project', message: 'm', keptSteps: 'discovery' },
    ],
    ['a verdict that is not an object', 'continue'],
  ])('%s takes the SAFE route and says why', (_what, raw) => {
    const read = readOnboardingRoutingVerdict(envelope(raw));
    expect(read?.ok).toBe(false);
    expect(read?.ok === false && read.outcome).toBe(ONBOARDING_ROUTING_REFUSAL);
    // The reason travels, so a refusal can be logged as a refusal rather than
    // disappearing into a route nobody can explain.
    expect(read?.ok === false && read.reason.length).toBeGreaterThan(0);
  });

  it('the safe route is the one outcome with NO precondition', () => {
    // `continue` requires a linked repository and `onboard_existing_project`
    // requires something to build on. A refusal is precisely the state in which
    // this side does not know that either holds.
    expect(ONBOARDING_ROUTING_REFUSAL).toBe('onboard_new_project');
  });
});

describe('NO verdict is not a bad verdict', () => {
  it.each([
    ['an envelope that was never asked for one', { envelopeVersion: 'v1' }],
    ['an explicit null', { envelopeVersion: 'v1', onboardingRouting: null }],
    ['nothing at all', null],
  ])('%s reads as null, and nobody is routed', (_what, result) => {
    expect(readOnboardingRoutingVerdict(result)).toBeNull();
  });
});

describe('the kept-step list is typed against the STATE MACHINE, not against a local copy', () => {
  it('holds every step the wizard runs, and not its terminal marker', () => {
    expect([...MIGRATE_ROUTING_STEPS]).toEqual([
      'connect',
      'index',
      'import',
      'audit_convention',
      'discovery',
      'generate',
      'review',
    ]);
    // `done` is the machine's terminal marker, not a step anybody runs, so a
    // verdict asking to KEEP it is asking for nothing.
    expect(MIGRATE_ROUTING_STEPS as readonly string[]).not.toContain('done');
  });
});

describe('THE FLAG — the verdict is REQUESTED, not inferred (MOTIR-4769)', () => {
  it('is set for a project whose first plan has never been approved', () => {
    expect(routeOnboardingContextFor({ onboardingRanAt: null })).toEqual({
      [ROUTE_ONBOARDING_CONTEXT_FIELD]: true,
    });
  });

  it('is ABSENT for an established project — not `false`', () => {
    // The opposite of `onboarding`'s rule, and deliberately: there, absence
    // means *the producer predates the field*. Here the consumer's default IS
    // the safe one, so `false` would add a key to every planning envelope in the
    // product to say the thing its absence already says.
    expect(routeOnboardingContextFor({ onboardingRanAt: new Date() })).toEqual({});
  });

  it('the PLAN WINDOW derives it server-side; the MIGRATE WIZARD never sets it', () => {
    // The whole reason the flag exists. Both dispatches reach the same service,
    // and a verdict inferred from the tree would send a user who is already in
    // onboarding back to the start of it.
    // ⚠️ ONE DOOR ASKS, AND IT IS NOT `…/plan/generate`. An earlier revision
    // derived the flag there from the marker, which looks right and is wrong for
    // the run AFTER the verdict: `onboardingRanAt` is stamped on the first plan
    // APPROVED, so it is still null while a `continue` project does its actual
    // planning — every ask that user made would have been routed again and
    // halted, planning nothing, forever.
    const routingDoor = readFileSync(
      join(process.cwd(), 'app/api/ai/plan/route-onboarding/route.ts'),
      'utf8',
    );
    expect(routingDoor).toContain('startRoutingRun');
    // …and nothing is taken from the client: there is no body on this route at
    // all. A caller who could assert the flag could route a user into onboarding
    // they do not need.
    expect(routingDoor).not.toMatch(/req\.json\(\)/);

    const generate = readFileSync(join(process.cwd(), 'app/api/ai/plan/generate/route.ts'), 'utf8');
    expect(generate).not.toMatch(/routeOnboarding:/);

    const wizard = readFileSync(
      join(process.cwd(), 'lib/services/migrateOnboardingService.ts'),
      'utf8',
    );
    expect(wizard).not.toContain('routeOnboarding');

    // The service's routing dispatch is the ONLY place the context helper is
    // called, so the flag cannot reach a submit that did not ask for it.
    const service = readFileSync(
      join(process.cwd(), 'lib/services/aiGenerationService.ts'),
      'utf8',
    );
    expect((service.match(/routeOnboardingContextFor\(/g) ?? []).length).toBe(1);
  });
});

describe('AC4 · motir-core applies NO heuristic of its own on the verdict’s path', () => {
  const source = readFileSync(join(process.cwd(), 'lib/dto/onboardingRouting.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('nothing on this path reads the substrate at all', () => {
    // Not "no comparison" but something stronger and simpler to keep true: the
    // reader never sees the project. It cannot form an opinion about a verdict
    // because it has nothing to form one from.
    for (const tell of ['itemCount', 'repositoryConnected', 'repositoryIndexed', 'substrate']) {
      expect(code, tell).not.toContain(tell);
    }
  });

  it('and it produces no outcome of its own except the named REFUSAL', () => {
    const produced =
      code.match(/outcome:\s*'(continue|onboard_new_project|onboard_existing_project)'/g) ?? [];
    expect(produced).toEqual([]);
    expect(code).toContain('ONBOARDING_ROUTING_REFUSAL');
  });
});
