import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { OUT_OF_CREDITS_CODE } from '@/lib/planning/planEditsClient';
import {
  RESUME_REASON_CODES,
  RESUME_REFUSAL_KEYS,
  refusalEndsWaiting,
  resumeReasonKeyOf,
  resumeRefusalKeyOf,
  stopPhraseKeyOf,
} from '../../app/(authed)/workbench/_components/planningSessionWords';

// The words of a failed planning session's To resume entry (MOTIR-7917) — pure, so no React.

describe('stopPhraseKeyOf — where the walk stopped, in the progress line’s step words', () => {
  it('lay + title → Laying {title}', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'lay', stopTitle: 'Export' })).toBe('lay');
  });
  it('lay, no title → the project’s top level', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'lay', stopTitle: null })).toBe('layTop');
  });
  it('author + title → Writing {title}', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'author', stopTitle: 'Export' })).toBe('author');
  });
  it('no phase → Drafting a new item (and an author with nothing to name falls to it)', () => {
    expect(stopPhraseKeyOf({ stopPhase: null, stopTitle: null })).toBe('draft');
    expect(stopPhraseKeyOf({ stopPhase: 'author', stopTitle: null })).toBe('draft');
  });
});

describe('resumeReasonKeyOf — TOTAL over the five stored codes', () => {
  it('returns a key for each code, and every key has words in both locales', () => {
    for (const code of RESUME_REASON_CODES) {
      expect(resumeReasonKeyOf(code)).toBe(code);
      expect(en.workbench.planningSession.reason[code]).toBeTruthy();
      expect(zh.workbench.planningSession.reason[code]).toBeTruthy();
    }
    expect(RESUME_REASON_CODES).toHaveLength(5);
  });
  it('an unknown or missing code reads as `internal`, never the raw code', () => {
    expect(resumeReasonKeyOf('quantum_flux')).toBe('internal');
    expect(resumeReasonKeyOf(null)).toBe('internal');
    expect(resumeReasonKeyOf(undefined)).toBe('internal');
  });
});

describe('resumeRefusalKeyOf — TOTAL over the resume route’s refusals', () => {
  it.each([
    ['RESUME_ALREADY_STARTED', null, 'alreadyStarted'],
    ['PLAN_SESSION_ENDED', 409, 'ended'],
    ['SESSION_ENDED', null, 'ended'],
    ['SESSION_NOT_FAILED', 409, 'notFailed'],
    ['NOT_SESSION_OWNER', 403, 'notOwner'],
    ['PLAN_NOT_RESUMABLE', 409, 'notResumable'],
    [OUT_OF_CREDITS_CODE, 402, 'credits'],
    [null, 402, 'credits'],
    ['SOMETHING_ELSE', 502, 'unavailable'],
    [null, null, 'unavailable'],
  ] as const)('%s / %s → %s', (code, status, expected) => {
    expect(resumeRefusalKeyOf(code, status)).toBe(expected);
  });

  it('every key that is an error has a sentence in both locales', () => {
    for (const key of RESUME_REFUSAL_KEYS) {
      if (key === 'alreadyStarted') continue; // not an error: it reads as resuming
      expect(en.workbench.planningSession.refusal[key]).toBeTruthy();
      expect(zh.workbench.planningSession.refusal[key]).toBeTruthy();
    }
  });

  it('only `ended` and `notFailed` say the session no longer waits', () => {
    expect(RESUME_REFUSAL_KEYS.filter(refusalEndsWaiting).sort()).toEqual(['ended', 'notFailed']);
  });
});
