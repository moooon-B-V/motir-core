import { describe, expect, it } from 'vitest';
import {
  firstPostMergeChildTell,
  isPostMergeChildCandidate,
  isPostMergeChildCheckExemptContainer,
} from '@/lib/workItems/proseVsGraph';

// The PURE half of the POST-MERGE-CHILD check (MOTIR-8863).

describe('firstPostMergeChildTell', () => {
  it('reads the MOTIR-8860 tell from the Context, outside any criterion', () => {
    const body = [
      '## Context',
      '',
      'Earliest legal start: after the deploy that ships the controller has finished.',
      '',
      '## Acceptance criteria',
      '',
      '1. the seven steps pass',
    ].join('\n');
    expect(firstPostMergeChildTell(body)).toBe('earliest legal start');
  });

  it('is markup- and wrap-tolerant', () => {
    expect(firstPostMergeChildTell('Run it **after the\ndeploy** completes')).toBe(
      'after the deploy',
    );
  });

  it('is word-bounded and quiet on a body that reads nothing post-deploy', () => {
    expect(firstPostMergeChildTell('Wire the reproduction into CI')).toBeNull();
    expect(firstPostMergeChildTell(null)).toBeNull();
  });
});

describe('scope', () => {
  it('asks only the cards that wait on a deployment', () => {
    expect(isPostMergeChildCandidate('verification', 'coding_agent')).toBe(true);
    expect(isPostMergeChildCandidate('deploy', null)).toBe(true);
    expect(isPostMergeChildCandidate('code', 'human')).toBe(true);
    expect(isPostMergeChildCandidate('code', 'coding_agent')).toBe(false);
  });

  it('never asks a child of an epic or a root', () => {
    expect(isPostMergeChildCheckExemptContainer('epic')).toBe(true);
    expect(isPostMergeChildCheckExemptContainer(null)).toBe(true);
    expect(isPostMergeChildCheckExemptContainer('story')).toBe(false);
  });
});
