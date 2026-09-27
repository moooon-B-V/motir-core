import { describe, expect, it } from 'vitest';
import { renderAcceptanceRecordPrompt, renderAcceptanceRerunPrompt } from '../src/ciWatch.js';

// The two prompts an acceptance Re-run sends (Story MOTIR-6071 · MOTIR-6502): the fix
// turn, and the closing turn that re-records the video once CI is green.

const input = {
  key: 'PROD-60',
  title: 'Exports list',
  refusal: {
    reasonMd: 'The empty board should say how to add the first card.\nAnd the toolbar wraps.',
    decidedByLabel: 'Yue Zhu',
    decidedAt: '2026-09-26T10:00:00.000Z',
  },
  pullRequests: [
    { repo: 'acme/web', number: 12, url: 'https://github.com/acme/web/pull/12' },
    { repo: 'acme/ai', number: 7, url: 'https://github.com/acme/ai/pull/7' },
  ],
  checkouts: [
    { repo: 'acme/web', branch: 'parent/PROD-60', path: '/work/web-fix-prod-60-12' },
    { repo: 'acme/ai', branch: 'parent/PROD-60', path: '/work/ai-fix-prod-60-7' },
  ],
};

describe('renderAcceptanceRerunPrompt', () => {
  const prompt = renderAcceptanceRerunPrompt(input);

  it('quotes every line of the reason and names who sent it back, and when', () => {
    expect(prompt).toContain(
      'Yue Zhu sent it back on 2026-09-26T10:00:00.000Z, choosing **Re-run**:',
    );
    expect(prompt).toContain(
      '> The empty board should say how to add the first card.\n> And the toolbar wraps.',
    );
  });

  it('names every pull request and where each branch is checked out', () => {
    expect(prompt).toContain('- **acme/web#12** — https://github.com/acme/web/pull/12');
    expect(prompt).toContain('- **acme/ai#7** — https://github.com/acme/ai/pull/7');
    expect(prompt).toContain('branch `parent/PROD-60` at `/work/ai-fix-prod-60-7`');
  });

  it('draws the scope line: a fix, and anything structural is a Re-plan it must stop on', () => {
    expect(prompt).toContain('Anything structural is a Re-plan, not a Re-run');
    expect(prompt).toContain('make NO commit, stop, and say so');
  });

  it('moves nothing, opens nothing, and leaves the recording to the closing turn', () => {
    expect(prompt).toContain('Open no pull request, link nothing,');
    expect(prompt).toContain('Do not record or publish the acceptance video');
    expect(prompt).toContain('`publish_test_instructions` on PROD-60');
  });

  it('a card with no title keeps a clean heading', () => {
    expect(renderAcceptanceRerunPrompt({ ...input, title: null }).split('\n')[0]).toBe(
      '# Answer the acceptance review — PROD-60',
    );
  });
});

describe('renderAcceptanceRecordPrompt', () => {
  const prompt = renderAcceptanceRecordPrompt(input);

  it('asks for the story’s own spec, the two-call publish and the receipt id', () => {
    expect(prompt).toContain("acceptanceStory('PROD-60')");
    expect(prompt).toContain('`create_acceptance_upload`');
    expect(prompt).toContain('`publish_acceptance_result`');
    expect(prompt).toContain('Report the receipt id');
  });

  it('changes no code and publishes nothing from a red run', () => {
    expect(prompt).toContain('Change no code in this step and move no status.');
    expect(prompt).toContain('a red run records nothing');
  });
});
