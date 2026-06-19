import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAiPlanningConfigured } from '@/lib/ai/planningConfig';

// `isAiPlanningConfigured()` is the open-core boundary read as a boolean: it
// decides whether the front door shows the marketing hero (Motir Cloud / a
// connected deployment) or the "Connect Motir AI" gate (self-hosted, not yet
// connected). It must mirror exactly the env pair the motir-ai client requires.

const URL_KEY = 'MOTIR_AI_URL';
const TOKEN_KEY = 'MOTIR_AI_SERVICE_TOKEN';

describe('isAiPlanningConfigured', () => {
  let prevUrl: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevUrl = process.env[URL_KEY];
    prevToken = process.env[TOKEN_KEY];
    delete process.env[URL_KEY];
    delete process.env[TOKEN_KEY];
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env[URL_KEY];
    else process.env[URL_KEY] = prevUrl;
    if (prevToken === undefined) delete process.env[TOKEN_KEY];
    else process.env[TOKEN_KEY] = prevToken;
  });

  it('is true only when BOTH the url and the service token are set (cloud / connected)', () => {
    process.env[URL_KEY] = 'https://ai.example.test';
    process.env[TOKEN_KEY] = 'svc-token';
    expect(isAiPlanningConfigured()).toBe(true);
  });

  it('is false when neither is set (self-hosted, not connected)', () => {
    expect(isAiPlanningConfigured()).toBe(false);
  });

  it('is false when only the url is set', () => {
    process.env[URL_KEY] = 'https://ai.example.test';
    expect(isAiPlanningConfigured()).toBe(false);
  });

  it('is false when only the service token is set', () => {
    process.env[TOKEN_KEY] = 'svc-token';
    expect(isAiPlanningConfigured()).toBe(false);
  });

  it('is false when a value is present but empty', () => {
    process.env[URL_KEY] = '';
    process.env[TOKEN_KEY] = '';
    expect(isAiPlanningConfigured()).toBe(false);
  });
});
