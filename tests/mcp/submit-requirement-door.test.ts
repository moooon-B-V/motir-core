import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlanArgs } from '../../packages/cli/src/plan';
import { AI_REQUIREMENT_FIELDS } from '../fixtures/settledRequirement';

// WHICH DOOR the composed WHAT goes through (Story MOTIR-3942 · MOTIR-4172) —
// asserted by ABSENCE, which is the only way this particular decision can be
// asserted at all.
//
// The card was written twice against the CLI: first as six string flags on
// `motir plan`, then as one `--requirement <path|->` JSON option beside
// `--detach`. Both fought the same problem — a structured, multi-paragraph
// value does not fit comfortably through `argv` — and the fight was the signal.
// `motir plan` is a command for a PERSON at a terminal; the actor this feature
// serves is an MCP client that happens to have a shell, and every other
// instruction in the same protocol already reaches it as a tool call.
//
// ⚠️ AN ABSENCE IS NOT A SENTENCE, IT IS A CITATION, so each case below names
// the exact file it read and what it looked for. The risk this guards is not
// that somebody argues for the CLI again — it is that somebody ADDS the flag
// "for symmetry" while the tool argument already exists, leaving two doors onto
// one value with nothing saying which is authoritative.

const CLI_SRC = join(__dirname, '../../packages/cli/src');
const read = (f: string) => readFileSync(join(CLI_SRC, f), 'utf8');

describe('the requirement door is the MCP tool — `motir plan` is NOT touched', () => {
  it('`packages/cli/src/plan.ts` carries no requirement option, under any spelling', () => {
    const src = read('plan.ts');
    // The two shapes the card was previously written as, plus the field names
    // themselves — a six-flag grammar would have to name them somewhere.
    expect(src).not.toContain('--requirement');
    expect(src).not.toContain('requirement');
    for (const field of AI_REQUIREMENT_FIELDS) {
      expect(src.toLowerCase()).not.toContain(`--${field.toLowerCase()}`);
    }
  });

  it('`parsePlanArgs` still discriminates on the KEY SHAPE, and treats a flag as prose', () => {
    // Its positional design is not re-opened: everything from the first non-key
    // onward is the turn body, joined back with spaces. So a turn that happens
    // to TALK about the option is a turn, not an option.
    expect(
      parsePlanArgs(['MOTIR-7', '--requirement', 'is', 'now', 'a', 'tool', 'argument']),
    ).toEqual({ targetKeys: ['MOTIR-7'], text: '--requirement is now a tool argument' });
    // …and with no key at all, the whole line is still the body.
    expect(parsePlanArgs(['--requirement', './what.json'])).toEqual({
      targetKeys: [],
      text: '--requirement ./what.json',
    });
  });

  it('no plan-session route or client method grew a requirement — the `/api/v1` surface is untouched', () => {
    // `/api/mcp` is for AGENTS and may churn for prompt-engineering reasons;
    // `/api/v1` is for the CLI and third parties. This value went through the
    // first, so the second gained nothing: no body schema, no client method,
    // no file/STDIN reader — the five hops the CLI door would have needed.
    expect(read('client.ts')).not.toContain('requirement');
  });
});
