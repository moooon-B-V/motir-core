// A stand-in for the real MOTIR-2784 guard, so `preAuthKeys()` has a VERDICTS map
// to parse in the fixture root. Only the `pre-auth` arm matters here; the other
// verdicts are present so the parser must actually filter rather than take
// everything it finds.

type Verdict = 'pre-auth' | 'bound' | 'unreviewed';

const VERDICTS: Record<string, readonly [Verdict, string]> = {
  'fixtureRepository.ts#countAllUnsafe': ['pre-auth', 'no tenant exists at read time'],
  'fixtureRepository.ts#findWidgetUnbound': ['unreviewed', 'not a pre-auth site'],
};

export { VERDICTS };
