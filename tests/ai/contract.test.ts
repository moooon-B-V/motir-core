import { describe, it, expect } from 'vitest';
import { JOB_KINDS, ENVELOPE_VERSION } from '@/lib/ai/types';
import type { Problem } from '@/lib/ai/types';
import {
  errorFromProblem,
  MotirAiUnauthorizedError,
  MotirAiBadRequestError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
  type MotirAiError,
} from '@/lib/ai/errors';

// CONTRACT TEST — the open side (Subtask 7.1.8). The frozen canonical lists
// below are IDENTICAL to motir-ai's tests/contract.test.ts; each repo asserts
// its own implementation matches them. If the boundary contract
// (motir-ai/docs/contract.md) changes, BOTH copies must change — the only
// cross-repo drift guard possible without a shared package. A deliberately
// mismatched value makes the suite FAIL (the drift-sim tests prove it bites).

// contract.md §5 — the shared error taxonomy. KEEP IN SYNC with motir-ai.
const CANONICAL_ERROR_CODES = [
  'validation_error',
  'unsupported_version',
  'service_unauthorized',
  'token_expired',
  'token_invalid',
  'not_found',
  'permission_denied',
  'conflict',
  'rate_limited',
  'ai_job_failed',
  'internal_error',
] as const;

// contract.md §2.3 — the jobKind enum. KEEP IN SYNC with motir-ai.
const CANONICAL_JOB_KINDS = [
  'noop',
  'discovery',
  'generate_explanation',
  'generate_tree',
  'expand_item',
  'augment',
  'replan',
] as const;

// The motir-core typed error each canonical code maps to (lib/ai/errors.ts).
const EXPECTED_MAPPING: Record<string, new (...args: never[]) => MotirAiError> = {
  validation_error: MotirAiBadRequestError,
  unsupported_version: MotirAiBadRequestError,
  service_unauthorized: MotirAiUnauthorizedError,
  token_expired: MotirAiUnauthorizedError,
  token_invalid: MotirAiUnauthorizedError,
  permission_denied: MotirAiUnauthorizedError,
  not_found: MotirAiJobNotFoundError,
  conflict: MotirAiBadRequestError, // 409 < 500 → bad-request fallback
  rate_limited: MotirAiUnavailableError,
  ai_job_failed: MotirAiUnavailableError,
  internal_error: MotirAiUnavailableError,
};

function problemFor(code: string, status = 400): Problem {
  return { type: `https://motir.co/errors/${code}`, title: code, status, code };
}

describe('contract: error taxonomy (§5)', () => {
  it('maps EVERY canonical code to its motir-core typed error', () => {
    for (const code of CANONICAL_ERROR_CODES) {
      const status = code === 'conflict' ? 409 : code === 'not_found' ? 404 : 400;
      const err = errorFromProblem(problemFor(code, status));
      expect(err, `code ${code}`).toBeInstanceOf(EXPECTED_MAPPING[code]!);
    }
  });

  it('the EXPECTED_MAPPING covers exactly the canonical code set', () => {
    expect(Object.keys(EXPECTED_MAPPING).sort()).toEqual([...CANONICAL_ERROR_CODES].sort());
  });
});

describe('contract: jobKind enum (§2.3)', () => {
  it('motir-core JOB_KINDS is EXACTLY the canonical set', () => {
    expect([...JOB_KINDS].sort()).toEqual([...CANONICAL_JOB_KINDS].sort());
  });

  it('ENVELOPE_VERSION matches the canonical version', () => {
    expect(ENVELOPE_VERSION).toBe('v1');
  });
});

describe('contract: request envelope (§3.1)', () => {
  // The IDENTICAL fixture motir-ai parses in its contract test.
  const CANONICAL_REQUEST = {
    envelopeVersion: 'v1',
    jobKind: 'noop',
    tenant: {
      organizationId: 'org_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
      projectKey: 'MOTIR',
    },
    context: { prompt: 'ping', rootItemKey: null, discovery: null, code: null },
    readBackToken: 'eyJ...token',
  };

  it('the canonical request uses a known kind + version core also speaks', () => {
    expect(ENVELOPE_VERSION).toBe(CANONICAL_REQUEST.envelopeVersion);
    expect((JOB_KINDS as readonly string[]).includes(CANONICAL_REQUEST.jobKind)).toBe(true);
  });
});

describe('contract: drift simulation (the guard must bite)', () => {
  it('an unknown error code does NOT silently pass as a known mapping', () => {
    // A drifted code falls to the status-based fallback, never one of the
    // specific known-code classes by accident.
    const err = errorFromProblem(problemFor('totally_made_up_code', 418));
    expect(err).toBeInstanceOf(MotirAiBadRequestError); // 4xx fallback, not a known mapping
    expect(CANONICAL_ERROR_CODES).not.toContain('totally_made_up_code');
  });

  it('a drifted jobKind is not in the canonical set', () => {
    expect((JOB_KINDS as readonly string[]).includes('mine_bitcoin')).toBe(false);
  });
});
