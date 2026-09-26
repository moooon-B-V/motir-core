import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { machineCreditsFor, motirFleetMultiplier } from '@/lib/hostedRuns/machineRate';
import { CREDITS_PER_LINEAR_EQUIVALENT_MINUTE } from '@/lib/ciMetering/allowance';
import { resolveRunnerRate } from '@/lib/ciMetering/runnerRates';

// THE PRICE OF A HOSTED RUN'S MACHINE TIME (MOTIR-6514, criterion 1;
// `docs/decisions/hosted-agent-machine-charge.md` §2–§3): CI's rate — one credit
// per Linux-equivalent minute at the `motir_fleet` multiplier — rounded up ONCE
// per run, and read from where CI reads it rather than restated.

const ROOT = join(__dirname, '..', '..');
const AT = new Date('2026-09-26T12:00:00.000Z');

describe('machineCreditsFor', () => {
  it('is 0 for a run that billed no seconds', () => {
    expect(machineCreditsFor(0, AT)).toBe(0);
    expect(machineCreditsFor(-5, AT)).toBe(0);
    expect(machineCreditsFor(Number.NaN, AT)).toBe(0);
  });

  it('rounds up once per run: 1,592 s is 27 credits, the decision worked values hold', () => {
    expect(machineCreditsFor(1_592, AT)).toBe(27);
    expect(machineCreditsFor(1, AT)).toBe(1);
    expect(machineCreditsFor(60, AT)).toBe(1);
    expect(machineCreditsFor(61, AT)).toBe(2);
    expect(machineCreditsFor(30 * 60, AT)).toBe(30);
    expect(machineCreditsFor(90 * 60, AT)).toBe(90);
  });

  it("is ⌈s ÷ 60⌉ at today's rates because CI's rate and the fleet multiplier are both 1", () => {
    expect(CREDITS_PER_LINEAR_EQUIVALENT_MINUTE).toBe(1);
    expect(resolveRunnerRate('motir_fleet', AT)?.multiplier).toBe(1);
    expect(motirFleetMultiplier(AT)).toBe(1);
    for (const seconds of [59, 600, 1_592, 3_601, 43_200]) {
      expect(machineCreditsFor(seconds, AT)).toBe(Math.ceil(seconds / 60));
    }
  });
});

/** Every `.ts` file under `dir`, repo-relative. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(relative(ROOT, full));
  }
  return out;
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('there is ONE price for a Motir machine minute (a grep, not a convention)', () => {
  it('the credits-per-minute constant is defined exactly once in lib/, in the CI allowance', () => {
    const definitions = sourceFiles(join(ROOT, 'lib')).filter((file) =>
      /export\s+const\s+\w*CREDITS?_PER_\w*MINUTE\w*\s*=/.test(
        readFileSync(join(ROOT, file), 'utf8'),
      ),
    );
    expect(definitions).toEqual(['lib/ciMetering/allowance.ts']);
  });

  it('the machine rate imports CI’s rate and the fleet multiplier and restates neither', () => {
    const text = readFileSync(join(ROOT, 'lib/hostedRuns/machineRate.ts'), 'utf8');
    expect(text).toMatch(
      /import\s*{\s*CREDITS_PER_LINEAR_EQUIVALENT_MINUTE\s*}\s*from\s*'@\/lib\/ciMetering\/allowance'/,
    );
    expect(text).toMatch(/resolveRunnerRate\('motir_fleet'/);
    // The only numbers the code may carry are "no seconds" and "seconds in a minute".
    const literals = withoutComments(text).match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? [];
    expect(new Set(literals)).toEqual(new Set(['0', '60']));
  });

  it('the charge takes its credits from the machine rate and carries no rate of its own', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'lib/services/hostedRunChargeService.ts'), 'utf8'),
    );
    expect(code).toMatch(/machineCreditsFor\(/);
    expect(code).not.toMatch(/\/\s*60\b|\*\s*60\b|CREDITS_PER|multiplier/);
  });
});
