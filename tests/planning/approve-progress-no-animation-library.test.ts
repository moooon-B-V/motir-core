import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WHAT APPROVE SAYS WHILE IT RUNS draws its wait with the design system's own
// Spinner and two sentences (MOTIR-5249; design Part XXV §25.6). No animation
// runtime was needed for it, and none is to arrive with it or after it: a library
// brought in "for the approve" would be a second motion language beside the
// tokens, and one `motion-reduce` would not reach. This pins that both manifests
// stay free of the four that a progress surface tends to pull in (MOTIR-5251).

const FORBIDDEN = ['lottie', 'framer-motion', 'rive', 'gsap'] as const;

function dependencyNames(manifest: string): string[] {
  const pkg = JSON.parse(readFileSync(path.resolve(manifest), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
    (field) => Object.keys(pkg[field] ?? {}),
  );
}

/** A name is an offender when it IS a forbidden library, or a scoped/suffixed
 *  package of it (`lottie-react`, `@rive-app/react-canvas`, `@gsap/react`). */
function offenders(names: string[]): string[] {
  return names.filter((name) =>
    FORBIDDEN.some((lib) => {
      const bare = name.replace(/^@[^/]+\//, '');
      return (
        name === lib ||
        bare === lib ||
        bare.startsWith(`${lib}-`) ||
        name.startsWith(`@${lib}/`) ||
        name.startsWith(`@${lib}-app/`)
      );
    }),
  );
}

describe('approve progress — no animation runtime (MOTIR-5251)', () => {
  it.each(['package.json', 'packages/design-system/package.json'])(
    '%s declares none of lottie / framer-motion / rive / gsap',
    (manifest) => {
      expect(offenders(dependencyNames(manifest))).toEqual([]);
    },
  );

  it('the matcher catches each library and its usual packaging', () => {
    expect(
      offenders([
        'lottie-react',
        'framer-motion',
        '@rive-app/react-canvas',
        'gsap',
        '@gsap/react',
        'react',
        'driver',
      ]),
    ).toEqual(['lottie-react', 'framer-motion', '@rive-app/react-canvas', 'gsap', '@gsap/react']);
  });
});
